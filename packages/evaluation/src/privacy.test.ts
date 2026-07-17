import { describe, expect, it } from "vitest";
import { assertPrivacySafe, privacyFindings } from "./privacy";

describe("evaluation privacy scan", () => {
  it("rejects credentials, PII, local paths, private prompts, raw evidence, and private research", () => {
    const findings = privacyFindings({
      apiKey: "sk_examplecredential000000000",
      contact: "person@example.com 250-555-1212",
      path: "/Users/example/private/file.txt",
      privatePrompt: "hidden",
      rawUserEvidence: "image bytes",
      notes: "confidential research report",
    });
    expect(new Set(findings.map((finding) => finding.code))).toEqual(new Set([
      "private-content-key",
      "credential",
      "email",
      "phone",
      "local-path",
      "private-research",
    ]));
  });

  it("accepts identity-only sanitized run output", () => {
    expect(() => assertPrivacySafe({
      taskId: "synthetic-case",
      provider: "scripted",
      model: "fixture",
      proofIdentities: { artifactId: "artifact-1", proofPolicyVersion: 1 },
    }, "fixture")).not.toThrow();
  });

  it("accepts the complete release corpus and deterministic fixtures", () => {
    for (const path of ["corpus/proven-single-part-v1.json", "corpus/deterministic-v1.json"]) {
      const fixture = JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as unknown;
      expect(privacyFindings(fixture), path).toEqual([]);
    }
  });
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
