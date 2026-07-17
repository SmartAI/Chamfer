export interface PrivacyFinding {
  code:
    | "credential"
    | "email"
    | "phone"
    | "local-path"
    | "private-content-key"
    | "private-research";
  location: string;
}

const PRIVATE_KEYS = new Set([
  "apiKey",
  "authorization",
  "credential",
  "credentials",
  "privatePrompt",
  "rawUserEvidence",
  "researchContent",
  "systemPrompt",
  "token",
]);

const STRING_PATTERNS: Array<{ code: PrivacyFinding["code"]; pattern: RegExp }> = [
  { code: "credential", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b|\bBearer\s+[A-Za-z0-9._-]{12,}\b/i },
  { code: "email", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { code: "phone", pattern: /(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/ },
  { code: "local-path", pattern: /(?:^|[\s"'])(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Z]:\\Users\\[^\\\s]+)/i },
  { code: "private-research", pattern: /\b(?:private|confidential|internal)\s+research\s+(?:report|content|transcript)\b/i },
];

function scan(value: unknown, path: string, findings: PrivacyFinding[]): void {
  if (typeof value === "string") {
    for (const candidate of STRING_PATTERNS) {
      if (candidate.pattern.test(value)) findings.push({ code: candidate.code, location: path });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scan(item, `${path}[${index}]`, findings));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (PRIVATE_KEYS.has(key)) findings.push({ code: "private-content-key", location: childPath });
    scan(item, childPath, findings);
  }
}

export function privacyFindings(value: unknown): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  scan(value, "$", findings);
  return findings;
}

export function assertPrivacySafe(value: unknown, label: string): void {
  const findings = privacyFindings(value);
  if (findings.length === 0) return;
  const summary = findings.map((finding) => `${finding.code} at ${finding.location}`).join(", ");
  throw new Error(`${label} failed the privacy scan: ${summary}`);
}
