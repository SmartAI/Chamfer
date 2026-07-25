import { describe, expect, it } from "vitest";
import { evaluateContainerSkew, imageTagOf, expectedVersionOf } from "./check-container-skew.mjs";

const WRANGLER = `{
  "containers": [
    { "image": "registry.cloudflare.com/acct/chamfer-agent:abc1234", "instance_type": "standard-1" }
  ],
  "vars": { "CHAMFER_EXPECTED_CONTAINER_VERSION": "abc1234" }
}`;

describe("wrangler.jsonc readers", () => {
  it("extracts the pinned image tag and expected version", () => {
    expect(imageTagOf(WRANGLER)).toBe("abc1234");
    expect(expectedVersionOf(WRANGLER)).toBe("abc1234");
  });
});

describe("evaluateContainerSkew", () => {
  const matched = { headImageTag: "new5678", headExpectedVersion: "new5678" };

  it("passes when non-container files change, tag untouched", () => {
    const verdict = evaluateContainerSkew({
      changedFiles: ["packages/client/src/App.tsx", "README.md"],
      baseImageTag: "new5678",
      ...matched,
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("fails when container code changes without a tag bump", () => {
    const verdict = evaluateContainerSkew({
      changedFiles: ["packages/server/src/container/app.ts"],
      baseImageTag: "new5678",
      ...matched,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(" ")).toContain("still new5678");
  });

  it("passes when container code changes WITH a tag bump", () => {
    const verdict = evaluateContainerSkew({
      changedFiles: ["packages/online/container/Dockerfile"],
      baseImageTag: "old1234",
      headImageTag: "new5678",
      headExpectedVersion: "new5678",
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("fails when the image tag and expected-version var disagree", () => {
    const verdict = evaluateContainerSkew({
      changedFiles: [],
      baseImageTag: "new5678",
      headImageTag: "new5678",
      headExpectedVersion: "stale00",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join(" ")).toContain("must be equal");
  });
});
