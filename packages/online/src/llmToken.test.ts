import { describe, expect, it } from "vitest";
import { DEFAULT_LLM_TOKEN_TTL_SECONDS, mintLlmToken, verifyLlmToken } from "./llmToken";

const SECRET = "test-signing-secret";
const NOW = Date.parse("2026-07-23T12:00:00Z");

describe("llm proxy tokens", () => {
  it("round-trips claims through mint and verify", async () => {
    const token = await mintLlmToken(SECRET, { userId: "user-1", conversationId: "conv-1" }, NOW);
    const claims = await verifyLlmToken(SECRET, token, NOW);
    expect(claims).toEqual({
      userId: "user-1",
      conversationId: "conv-1",
      expiresAt: Math.floor(NOW / 1000) + DEFAULT_LLM_TOKEN_TTL_SECONDS,
    });
  });

  it("honors an explicit ttl", async () => {
    const token = await mintLlmToken(
      SECRET,
      { userId: "user-1", conversationId: "conv-1", ttlSeconds: 60 },
      NOW,
    );
    const claims = await verifyLlmToken(SECRET, token, NOW);
    expect(claims?.expiresAt).toBe(Math.floor(NOW / 1000) + 60);
  });

  it("is a standard HS256 JWT with the conversation id as a private claim", async () => {
    const token = await mintLlmToken(SECRET, { userId: "user-1", conversationId: "conv-1" }, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const [header, payload] = token.split(".") as [string, string];
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "HS256" });
    expect(JSON.parse(Buffer.from(payload, "base64url").toString())).toMatchObject({
      sub: "user-1",
      cnv: "conv-1",
    });
  });

  it("rejects an expired token", async () => {
    const token = await mintLlmToken(
      SECRET,
      { userId: "user-1", conversationId: "conv-1", ttlSeconds: 60 },
      NOW,
    );
    expect(await verifyLlmToken(SECRET, token, NOW + 61_000)).toBeNull();
    expect(await verifyLlmToken(SECRET, token, NOW + 59_000)).not.toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await mintLlmToken("other-secret", { userId: "user-1", conversationId: "conv-1" }, NOW);
    expect(await verifyLlmToken(SECRET, token, NOW)).toBeNull();
  });

  it("rejects a token whose payload was tampered with", async () => {
    const token = await mintLlmToken(SECRET, { userId: "user-1", conversationId: "conv-1" }, NOW);
    const [prefix, payload, signature] = token.split(".") as [string, string, string];
    const forgedPayload = payload.slice(0, -2) + (payload.endsWith("aa") ? "bb" : "aa");
    expect(await verifyLlmToken(SECRET, `${prefix}.${forgedPayload}.${signature}`, NOW)).toBeNull();
  });

  it("rejects garbage without throwing", async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const garbage of [
      "",
      "not-a-token",
      "a.b",
      "..",
      "!!!.###.$$$",
      `${b64({ alg: "HS256" })}.${btoa("not json").replace(/=+$/, "")}.AAAA`,
      `${b64({ alg: "HS256" })}.${b64({})}.AAAA`, // empty payload: missing claims
    ]) {
      expect(await verifyLlmToken(SECRET, garbage, NOW)).toBeNull();
    }
  });

  it("rejects an unsigned alg:none token even with valid-looking claims", async () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const forged = `${b64({ alg: "none" })}.${b64({
      sub: "user-1",
      cnv: "conv-1",
      exp: Math.floor(NOW / 1000) + 600,
    })}.`;
    expect(await verifyLlmToken(SECRET, forged, NOW)).toBeNull();
  });
});
