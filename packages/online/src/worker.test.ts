import { describe, expect, it } from "vitest";
import { expireHostOnlySessionCookies } from "./worker";

function collect(cookieHeader: string | null): string[] {
  const headers = new Headers();
  if (cookieHeader !== null) headers.set("cookie", cookieHeader);
  const set: string[] = [];
  expireHostOnlySessionCookies(headers, (name, value) => {
    expect(name).toBe("Set-Cookie");
    set.push(value);
  });
  return set;
}

describe("expireHostOnlySessionCookies", () => {
  it("expires the secure session cookie without a Domain attribute", () => {
    const set = collect(
      "__Secure-better-auth.session_token=stale.sig; __cf_bm=edge; other=1",
    );
    expect(set).toEqual([
      "__Secure-better-auth.session_token=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax",
    ]);
    expect(set[0]).not.toContain("Domain");
  });

  it("expires the unprefixed variant used on plain http", () => {
    const set = collect("better-auth.session_token=stale.sig");
    expect(set).toEqual([
      "better-auth.session_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax",
    ]);
  });

  it("emits one expiry per cookie name even when the browser sent duplicates", () => {
    const set = collect(
      "__Secure-better-auth.session_token=stale.sig; __Secure-better-auth.session_token=fresh.sig",
    );
    expect(set).toHaveLength(1);
  });

  it("does nothing when no session cookie was presented", () => {
    expect(collect("__cf_bm=edge; theme=dark")).toEqual([]);
    expect(collect(null)).toEqual([]);
  });
});
