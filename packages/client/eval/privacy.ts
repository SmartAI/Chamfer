export type PrivacyFindingKind =
  | "pii"
  | "credential"
  | "private-url"
  | "absolute-local-path"
  | "private-research-content"
  | "raw-production-content"
  | "raw-user-evidence";

export interface PrivacyFinding {
  kind: PrivacyFindingKind;
  source: string;
  line: number;
}

export interface PrivacyScan {
  status: "passed" | "failed";
  findings: PrivacyFinding[];
}

const patterns: Array<{ kind: PrivacyFindingKind; expression: RegExp }> = [
  { kind: "pii", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "pii", expression: /\b(?:\+?1[-. (]*)?(?:\d{3}[-. )]*){2}\d{4}\b/g },
  {
    kind: "credential",
    expression: /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/gi,
  },
  { kind: "credential", expression: /\b(?:sk|pk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g },
  {
    kind: "private-url",
    expression: /https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[^\s/]+\.(?:internal|local))(?:[^\s]*)/gi,
  },
  { kind: "absolute-local-path", expression: /(?:\/Users|\/home)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/ -]+/g },
  { kind: "absolute-local-path", expression: /\b[A-Z]:\\Users\\[^\s"']+/gi },
  { kind: "private-research-content", expression: /\bprivateResearch(?:Content)?\s*[:=]/gi },
  { kind: "raw-production-content", expression: /\brawProductionConversation\s*[:=]/gi },
  { kind: "raw-user-evidence", expression: /\brawUserEvidence\s*[:=]/gi },
  { kind: "raw-production-content", expression: /"containsProductionData"\s*:\s*true/gi },
];

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function scanPrivacy(inputs: Array<{ source: string; content: string }>): PrivacyScan {
  const findings: PrivacyFinding[] = [];
  for (const input of inputs) {
    for (const pattern of patterns) {
      pattern.expression.lastIndex = 0;
      for (const match of input.content.matchAll(pattern.expression)) {
        findings.push({
          kind: pattern.kind,
          source: input.source,
          line: lineAt(input.content, match.index),
        });
      }
    }
  }
  findings.sort((left, right) =>
    left.source.localeCompare(right.source) || left.line - right.line || left.kind.localeCompare(right.kind)
  );
  return { status: findings.length > 0 ? "failed" : "passed", findings };
}
