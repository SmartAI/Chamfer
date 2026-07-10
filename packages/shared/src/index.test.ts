import { describe, expect, it } from "vitest";
import { PROXY_AUTH_TOKEN, isCadResponse } from "./index";

describe("shared", () => {
  it("exports the local proxy token", () => {
    expect(PROXY_AUTH_TOKEN).toBe("chamfer-local");
  });
  it("guards CadResponse shapes", () => {
    expect(isCadResponse({ id: 1, ok: false, cmd: "run", error: "boom" })).toBe(true);
    expect(isCadResponse({ nope: true })).toBe(false);
  });
});
