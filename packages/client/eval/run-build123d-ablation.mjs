import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { scoreAblationMessages } from "../src/agent/ablation.ts";

const TASKS = {
  drawer_handle: "Design a curved drawer handle: sweep a D-shaped profile along a gentle 110 mm arc to form the grip bar, join each end to a 16 mm diameter, 12 mm tall cylindrical standoff, and put a 4 mm screw hole through each standoff.",
};
const CONDITIONS = new Set(["none", "core", "catalog", "full"]);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");

function argument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function scoreConversation(db, conversationId) {
  const rows = db.prepare("SELECT content_json FROM messages WHERE conversation_id = ? ORDER BY seq").all(conversationId);
  return scoreAblationMessages(rows.map((row) => JSON.parse(row.content_json)));
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

const baseUrl = argument("url", "http://localhost:5173");
const taskName = argument("task", "drawer_handle");
const trials = Number(argument("trials", "5"));
const requestedConditions = argument("conditions", "none,core,catalog,full").split(",");
const expectedModel = argument("model", "");
const seed = Number(argument("seed", "12345"));
const dbPath = resolve(repoRoot, argument("db", "data/chamfer.db"));
const outputPath = resolve(repoRoot, argument("output", `docs/internal/ablation-${Date.now()}.jsonl`));
if (!(taskName in TASKS)) throw new Error(`Unknown task ${taskName}`);
if (!Number.isInteger(trials) || trials < 1) throw new Error("--trials must be a positive integer");
if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
for (const condition of requestedConditions) {
  if (!CONDITIONS.has(condition)) throw new Error(`Unknown condition ${condition}`);
}

const browser = await chromium.launch({ headless: true });
const db = new DatabaseSync(dbPath, { readOnly: true });
const modelJson = db.prepare("SELECT value FROM settings WHERE key = 'modelJson'").get()?.value;
if (!modelJson) throw new Error("No configured modelJson found in the evaluation database");
const configuredModel = JSON.parse(modelJson);
if (expectedModel && configuredModel.id !== expectedModel) {
  throw new Error(`Expected model id ${expectedModel}, found ${configuredModel.id}`);
}
const results = [];
const random = seededRandom(seed);
const promptHash = digest(await readFile(resolve(scriptDir, "../src/agent/prompt.ts"), "utf8"));
// The skill treatment is build123dSkill.ts plus every authored SKILL.md and snippet.
const skillDir = resolve(scriptDir, "../src/agent/skills");
const skillEntries = (await readdir(skillDir, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => resolve(entry.parentPath, entry.name))
  .sort();
const skillParts = [await readFile(resolve(scriptDir, "../src/agent/build123dSkill.ts"), "utf8")];
for (const entry of skillEntries) skillParts.push(await readFile(entry, "utf8"));
const skillHash = digest(skillParts.join("\n"));
await mkdir(resolve(outputPath, ".."), { recursive: true });
try {
  for (let trial = 1; trial <= trials; trial += 1) {
    const order = shuffled(requestedConditions, random);
    for (const condition of order) {
      const page = await browser.newPage();
      const startedAt = Date.now();
      let infrastructureError;
      let conversation;
      try {
        await page.goto(`${baseUrl}/?chamferSkill=${condition}`);
        const loading = page.getByText("Preparing environment, please wait...");
        if (await loading.count()) await loading.waitFor({ state: "hidden", timeout: 180_000 });
        const created = page.waitForResponse((response) =>
          response.request().method() === "POST" && response.url().endsWith("/api/conversations"));
        await page.getByRole("button", { name: "New chat" }).first().click();
        conversation = await (await created).json();
        await page.getByRole("textbox", { name: "Message Chamfer..." }).fill(TASKS[taskName]);
        await page.getByRole("button", { name: "Send" }).click();
        await page.getByText("Agent is working").waitFor({ state: "hidden", timeout: 600_000 });
      } catch (error) {
        infrastructureError = error instanceof Error ? error.message : String(error);
      } finally {
        await page.close();
      }
      const result = {
        task: taskName,
        condition,
        trial,
        seed,
        promptHash,
        skillHash,
        modelId: configuredModel.id,
        modelHash: digest(modelJson),
        elapsedMs: Date.now() - startedAt,
        infrastructureError,
        conversation,
        ...(conversation ? scoreConversation(db, conversation.id) : {}),
      };
      results.push(result);
      await appendFile(outputPath, `${JSON.stringify(result)}\n`);
    }
  }
} finally {
  db.close();
  await browser.close();
}

const summaryPath = outputPath.replace(/\.jsonl$/, ".md");
const rows = results.map((result) =>
  `| ${result.trial} | ${result.condition} | ${result.gatePassed ? "gate pass" : "gate fail"} | ${result.cadRuns ?? "-"} | ${result.searches ?? "-"} | ${result.inputTokens ?? "-"} | ${result.infrastructureError ?? ""} |`);
await writeFile(summaryPath, [
  "# Build123d Ablation Results",
  "",
  `Seed: ${seed}. Prompt hash: \`${promptHash}\`. Skill hash: \`${skillHash}\`.`,
  "",
  "| Trial | Condition | Result | CAD runs | Searches | Input tokens | Infrastructure error |",
  "| ---: | --- | --- | ---: | ---: | ---: | --- |",
  ...rows,
  "",
].join("\n"));
console.log(`Wrote ${results.length} trial results to ${outputPath} and ${summaryPath}`);
