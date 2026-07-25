import { describe, expect, it } from "vitest";
import { containerVersionSkewMessage } from "./containerVersion";

describe("containerVersionSkewMessage", () => {
  it("permits the turn when the versions match", () => {
    expect(containerVersionSkewMessage("abc1234", "abc1234")).toBeUndefined();
  });

  it("refuses when the container runs an older build than expected", () => {
    const message = containerVersionSkewMessage("new5678", "old1234");
    expect(message).toBeDefined();
    expect(message).toContain("expects container version new5678");
    expect(message).toContain("reports version old1234");
    expect(message).toContain("container-image.yml");
  });

  it("refuses a legacy image that reports no version", () => {
    for (const legacy of [undefined, "unknown"]) {
      const message = containerVersionSkewMessage("new5678", legacy);
      expect(message).toBeDefined();
      expect(message).toContain("legacy image predating the handshake");
    }
  });

  it("does not block turns when the handshake is unconfigured", () => {
    expect(containerVersionSkewMessage(undefined, "abc1234")).toBeUndefined();
    expect(containerVersionSkewMessage(undefined, undefined)).toBeUndefined();
    expect(containerVersionSkewMessage("", "abc1234")).toBeUndefined();
  });
});
