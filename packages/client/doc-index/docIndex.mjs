import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import MiniSearch from "minisearch";
import { BUILD123D_VERSION } from "../src/cad/versions.ts";
import { DOC_INDEX_OPTIONS } from "../src/agent/docSearchConfig.ts";

export const INDEX_OPTIONS = DOC_INDEX_OPTIONS;

const HEADING_ADORNMENT = /^([=\-`:.'"~^_*+#<>])\1{2,}$/;
const PYTHON_NON_APIS = new Set([
  "and", "as", "assert", "bool", "dict", "enumerate", "float", "for", "if", "in", "int", "len",
  "list", "max", "min", "not", "or", "print", "range", "set", "str", "sum", "tuple", "zip",
]);

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function extractApiNames(text) {
  const names = new Set();
  const addQualified = (value) => {
    const name = value.replace(/^~/, "").split(".").at(-1);
    if (name && /^[A-Za-z_]\w*$/.test(name) && !PYTHON_NON_APIS.has(name)) names.add(name);
  };

  for (const match of text.matchAll(/:(?:attr|class|data|func|meth):`(?:[^<`]+<)?(~?[\w.]+)>?`/g)) {
    addQualified(match[1]);
  }
  for (const match of text.matchAll(/^\s*\.\. auto(?:class|function|method)::\s+([\w.]+)/gm)) {
    addQualified(match[1]);
  }
  for (const match of text.matchAll(/``([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)/g)) {
    addQualified(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
    addQualified(match[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function headingAt(lines, index) {
  if (lines[index] !== lines[index]?.trim() || lines[index + 1] !== lines[index + 1]?.trim()) return undefined;
  const title = lines[index]?.trim();
  const underline = lines[index + 1]?.trim();
  if (!title || !underline || !HEADING_ADORNMENT.test(underline) || underline.length < title.length) return undefined;
  if (/^[.][.]\s/.test(title) || /^[+|]/.test(title)) return undefined;
  const overline = lines[index - 1]?.trim();
  const hasOverline = overline === underline && HEADING_ADORNMENT.test(overline);
  return { title, start: hasOverline ? index - 1 : index, bodyStart: index + 2 };
}

export function chunkRstDocument(sourcePath, source, synonymTable = []) {
  const lines = source.replace(/\r\n?/g, "\n").replaceAll("\u2014", "-").split("\n");
  const headings = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    const heading = headingAt(lines, index);
    if (heading) headings.push(heading);
  }

  const sourceSlug = slugify(basename(sourcePath, posix.extname(sourcePath)));
  const seenIds = new Map();
  return headings.map((heading, index) => {
    const nextStart = headings[index + 1]?.start ?? lines.length;
    const body = lines.slice(heading.bodyStart, nextStart).join("\n").trim();
    const baseId = `${sourceSlug}#${slugify(heading.title)}`;
    const occurrence = (seenIds.get(baseId) ?? 0) + 1;
    seenIds.set(baseId, occurrence);
    const section_id = occurrence === 1 ? baseId : `${baseId}-${occurrence}`;
    const api_names = extractApiNames(`${heading.title}\n${body}`);
    const searchable = `${heading.title}\n${body}\n${api_names.join(" ")}`.toLowerCase();
    const synonyms = synonymTable
      .filter((entry) => entry.terms.some((term) => searchable.includes(term.toLowerCase())))
      .flatMap((entry) => entry.synonyms)
      .filter((value, synonymIndex, values) => values.indexOf(value) === synonymIndex)
      .sort((a, b) => a.localeCompare(b));
    return { section_id, title: heading.title, body, api_names, synonyms };
  });
}

function selectIncludedLines(source, options) {
  let lines = source.replace(/\r\n?/g, "\n").split("\n");
  const markerIndex = (marker) => lines.findIndex((line) => line.includes(marker));
  if (options["start-after"]) {
    const index = markerIndex(options["start-after"]);
    if (index < 0) throw new Error(`literalinclude start marker not found: ${options["start-after"]}`);
    lines = lines.slice(index + 1);
  } else if (options["start-at"]) {
    const index = markerIndex(options["start-at"]);
    if (index < 0) throw new Error(`literalinclude start marker not found: ${options["start-at"]}`);
    lines = lines.slice(index);
  }
  if (options["end-before"]) {
    const index = markerIndex(options["end-before"]);
    if (index < 0) throw new Error(`literalinclude end marker not found: ${options["end-before"]}`);
    lines = lines.slice(0, index);
  } else if (options["end-at"]) {
    const index = markerIndex(options["end-at"]);
    if (index < 0) throw new Error(`literalinclude end marker not found: ${options["end-at"]}`);
    lines = lines.slice(0, index + 1);
  }
  if (options.lines) {
    const selected = [];
    for (const part of options.lines.split(",")) {
      const [startText, endText] = part.trim().split("-");
      const start = Number(startText);
      const end = endText ? Number(endText) : start;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
        throw new Error(`invalid literalinclude lines option: ${options.lines}`);
      }
      selected.push(...lines.slice(start - 1, end));
    }
    lines = selected;
  }
  return lines;
}

export async function expandLiteralIncludes(sourcePath, source, readSource) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)\.\. literalinclude::\s+(.+?)\s*$/);
    if (!match) {
      output.push(lines[index]);
      continue;
    }
    const [, indent, target] = match;
    const options = {};
    while (index + 1 < lines.length) {
      const option = lines[index + 1].match(/^\s+:([\w-]+):\s*(.*?)\s*$/);
      if (!option) break;
      options[option[1]] = option[2];
      index += 1;
    }
    const includePath = posix.normalize(posix.join(posix.dirname(sourcePath), target));
    const included = selectIncludedLines(await readSource(includePath), options);
    const language = options.language || (posix.extname(includePath) === ".py" ? "python" : "text");
    output.push(`${indent}.. code-block:: ${language}`, "");
    output.push(...included.map((line) => `${indent}    ${line}`));
  }
  return output.join("\n");
}

export async function buildIndexAsset({ sourceFiles, synonymTable, readSource, version = BUILD123D_VERSION }) {
  const chunks = [];
  for (const sourcePath of [...sourceFiles].sort()) {
    const expanded = await expandLiteralIncludes(sourcePath, await readSource(sourcePath), readSource);
    chunks.push(...chunkRstDocument(sourcePath, expanded, synonymTable));
  }
  chunks.sort((a, b) => a.section_id.localeCompare(b.section_id));

  const index = new MiniSearch(INDEX_OPTIONS);
  index.addAll(chunks.map((chunk) => ({
    ...chunk,
    api_names: chunk.api_names.join(" "),
    synonyms: chunk.synonyms.join(" "),
  })));
  return {
    format_version: 1,
    attribution: {
      project: "build123d",
      version,
      source: `https://github.com/gumyr/build123d/tree/v${version}/docs`,
      license: "Apache-2.0",
    },
    index: index.toJSON(),
  };
}

async function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(scriptDir, "..");
  const config = JSON.parse(await readFile(resolve(scriptDir, "build123d-docs.json"), "utf8"));
  if (config.docs_ref !== `v${BUILD123D_VERSION}`) {
    throw new Error(`Docs ref ${config.docs_ref} does not match build123d ${BUILD123D_VERSION}`);
  }
  const synonymTable = JSON.parse(await readFile(resolve(scriptDir, "doc-synonyms.json"), "utf8"));
  const cache = new Map();
  const readSource = async (sourcePath) => {
    if (!cache.has(sourcePath)) {
      const url = `https://raw.githubusercontent.com/gumyr/build123d/${config.docs_ref}/${sourcePath}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
      cache.set(sourcePath, await response.text());
    }
    return cache.get(sourcePath);
  };
  const asset = await buildIndexAsset({
    sourceFiles: config.source_files,
    synonymTable,
    readSource,
  });
  const outputPath = resolve(packageDir, "public/docs/build123d-index.json");
  await writeFile(outputPath, `${JSON.stringify(asset)}\n`, "utf8");
  process.stdout.write(`Generated ${asset.index.documentCount} sections at ${outputPath}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
