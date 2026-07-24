import { describe, expect, it } from "vitest";
import { microUsdFromTotalTokens, microUsdFromUsage, usdToMicroUsd } from "./demoPricing";

describe("demoPricing", () => {
  it("prices a usage breakdown at Sonnet 5 standard rates", () => {
    // input 100*3 + output 50*15 + cacheRead 25*0.3 + cacheWrite 5*3.75 = 1076.25 -> 1076
    expect(microUsdFromUsage({ input: 100, output: 50, cacheRead: 25, cacheWrite: 5 })).toBe(1076);
  });

  it("prices a bare output turn at $15/M", () => {
    expect(microUsdFromUsage({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(15_000_000);
  });

  it("prices blended totalTokens at the output ceiling (conservative over-count)", () => {
    expect(microUsdFromTotalTokens(1000)).toBe(15_000);
  });

  it("converts whole-dollar caps to micro-USD", () => {
    expect(usdToMicroUsd(2)).toBe(2_000_000);
    expect(usdToMicroUsd(50)).toBe(50_000_000);
  });
});
