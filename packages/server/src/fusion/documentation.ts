import type { FusionDocumentationQueryDto, FusionDocumentationResultDto } from "@chamfer/shared";

export interface FusionDocumentationProvider {
  search(query: FusionDocumentationQueryDto): Promise<FusionDocumentationResultDto>;
}

const MAX_EXCERPTS = 8;
const MAX_EXCERPT_CHARS = 600;
const DOCUMENTATION_SCALAR_FIELDS = new Set([
  "deprecated", "description", "documentation", "name", "namespace", "qualifiedName", "returnType",
  "signature", "since", "summary", "type",
]);
const DOCUMENTATION_CONTAINER_FIELDS = new Set([
  "classes", "items", "members", "methods", "overloads", "parameters", "properties", "results", "returns",
]);

function scalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Converts the adapter's version-dependent JSON shape into a small textual
 * projection. Only scalar documentation fields cross the browser boundary. */
export function documentationExcerpts(value: unknown): string[] {
  const excerpts: string[] = [];
  const seen = new Set<string>();
  const add = (text: string) => {
    const concise = text
      .replace(/\bBearer\s+[^\s|,;]+/gi, "[credential omitted]")
      .replace(/\b(authorization|password|credential|api[_-]?key)\s*[:=]\s*[^|,;]+/gi, "$1: [credential omitted]")
      .replace(/https?:\/\/[^\s|]+/gi, "[network location omitted]")
      .replace(/\b[^\s|]+\.(?:f3d|f3z)\b/gi, "[Fusion file omitted]")
      .replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);
    if (!concise || seen.has(concise) || excerpts.length >= MAX_EXCERPTS) return;
    seen.add(concise);
    excerpts.push(concise);
  };
  const visit = (candidate: unknown): void => {
    if (excerpts.length >= MAX_EXCERPTS) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const entries = Object.entries(candidate as Record<string, unknown>);
    const ownScalars = entries.filter((entry): entry is [string, string | number | boolean] =>
      DOCUMENTATION_SCALAR_FIELDS.has(entry[0]) && scalar(entry[1]));
    if (ownScalars.length > 0) add(ownScalars.map(([key, item]) => `${key}: ${String(item)}`).join(" | "));
    for (const [key, nested] of entries) if (DOCUMENTATION_CONTAINER_FIELDS.has(key)) visit(nested);
  };
  visit(value);
  return excerpts;
}
