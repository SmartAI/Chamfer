import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";

const VISIBLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAFAAAAAwCAYAAACG5f33AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAqklEQVRoge2WsQ3EQBCE3MF3eiHt8z3Ywegkgm0AgXaeH8fuvGbwBO98EiiABNBlRRlIAM1A7l0CJUwAzUD2KZYwAXRtU0+EALo2qhlDAL3pGtIE0Axkn2IJE0DXNvVECKBro5oxBNCbriFNAM1A9imWMAF0bVNPhAC6NqoZQwC96RrSBNAMZJ9iCRNA1zb1RAiga6OaMQTQm64hTQDNQPYpljABdG3Tm/sDJeEvtDvLa50AAAAASUVORK5CYII=";
const processes: ChildProcess[] = [];
const tempDirs: string[] = [];

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("failed to allocate port"));
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitFor(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`timed out waiting for ${url}`);
}

function stop(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Best-effort test cleanup.
  }
}

test.afterEach(() => {
  for (const child of processes.splice(0)) stop(child);
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("a conversation from a copied legacy database keeps its image position after startup migration and reload", async ({
  page,
}, testInfo) => {
  const png = Buffer.from(VISIBLE_PNG_BASE64, "base64");
  const sourceDir = mkdtempSync(join(tmpdir(), "chamfer-legacy-source-"));
  const dataDir = mkdtempSync(join(tmpdir(), "chamfer-legacy-copy-"));
  tempDirs.push(sourceDir, dataDir);
  const sourcePath = join(sourceDir, "legacy.db");
  const copiedPath = join(dataDir, "chamfer.db");
  const source = new DatabaseSync(sourcePath);
  source.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, last_gate_status TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, seq INTEGER NOT NULL,
      role TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, seq)
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, kind TEXT NOT NULL,
      mime TEXT NOT NULL, data BLOB NOT NULL
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, version INTEGER NOT NULL,
      py_source TEXT NOT NULL, params_json TEXT, created_at INTEGER NOT NULL,
      UNIQUE(conversation_id, version)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO conversations VALUES ('c1', 'Migrated drawing', 1, 1, NULL);
  `);
  source.prepare(
    "INSERT INTO messages VALUES ('m1', 'c1', 1, 'user', ?, 1)",
  ).run(JSON.stringify({
    role: "user",
    content: [
      { type: "text", text: "before legacy image" },
      { type: "image", data: VISIBLE_PNG_BASE64, mimeType: "image/png" },
      { type: "text", text: "after legacy image" },
    ],
    timestamp: 1,
  }));
  source.prepare("INSERT INTO attachments VALUES ('a1', 'm1', 'user-image', 'image/png', ?)").run(
    png,
  );
  source.close();
  copyFileSync(sourcePath, copiedPath);

  const [apiPort, clientPort] = await Promise.all([freePort(), freePort()]);
  const root = resolve(process.cwd());
  const environment = {
    ...process.env,
    CHAMFER_DATA_DIR: dataDir,
    CHAMFER_FAKE_LLM: "1",
    PORT: String(apiPort),
    CLIENT_PORT: String(clientPort),
  };
  processes.push(
    spawn("npm", ["run", "start", "-w", "@chamfer/server"], { cwd: root, env: environment, detached: true }),
  );
  processes.push(
    spawn("npm", ["run", "dev", "-w", "@chamfer/client"], { cwd: root, env: environment, detached: true }),
  );
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`);
  await waitFor(`http://localhost:${clientPort}`);

  await page.goto(`http://localhost:${clientPort}`);
  const image = page.getByTestId("message-user-image");
  await expect(image).toBeVisible();
  const before = page.getByText("before legacy image");
  const after = page.getByText("after legacy image");
  await expect(before).toBeVisible();
  await expect(after).toBeVisible();
  const [beforeBox, imageBox, afterBox] = await Promise.all([
    before.boundingBox(),
    image.boundingBox(),
    after.boundingBox(),
  ]);
  expect(beforeBox!.y).toBeLessThan(imageBox!.y);
  expect(imageBox!.y).toBeLessThan(afterBox!.y);
  await page.screenshot({ path: testInfo.outputPath("migrated-before-reload.png"), fullPage: true });

  await page.reload();
  await expect(page.getByTestId("message-user-image")).toBeVisible();
  await expect(page.getByText("before legacy image")).toBeVisible();
  await expect(page.getByText("after legacy image")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("migrated-after-reload.png"), fullPage: true });

  const migrated = new DatabaseSync(copiedPath, { readOnly: true });
  expect(migrated.prepare("SELECT content_json FROM messages WHERE id = 'm1'").get()).toEqual(
    expect.objectContaining({ content_json: expect.stringContaining('"type":"attachment-reference"') }),
  );
  expect(migrated.prepare("PRAGMA table_info(attachments)").all()).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "data" })]),
  );
  migrated.close();
});
