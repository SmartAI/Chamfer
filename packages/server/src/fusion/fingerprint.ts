import { createHash } from "node:crypto";
import { fingerprintEngineeringScript } from "./integrityScripts";
import type { FusionMcpClient } from "./mcpClient";
import { executeFusionScript, isRecord, stableJson } from "./mcpPayload";

/** The verified-rollback machinery shared by the integrity probe and the live
 * connector. The probe certifies exactly this code against live Fusion; the
 * connector's rollback path must run the same code, or the certification is
 * void. Keep both callers on these helpers. */

const UPDATE_TOOL = "fusion_mcp_update";

/** Token-free engineering fingerprint of the active design. It never reads
 * entityToken, so it leaves the native Undo stack untouched and is safe to
 * call inside a rollback loop. */
export async function fingerprintFusionEngineering(client: FusionMcpClient, documentId: string): Promise<string> {
  const payload = await executeFusionScript(client, fingerprintEngineeringScript(documentId));
  if (!isRecord(payload.fingerprint)) throw new Error("Fusion fingerprint inspector returned no fingerprint");
  return createHash("sha256").update(stableJson(payload.fingerprint)).digest("hex");
}

/** One native Undo, strict: anything but an explicit success is a failure. */
export async function undoFusionOnce(client: FusionMcpClient): Promise<void> {
  const result = await client.callJson(UPDATE_TOOL, { featureType: "undo" });
  if (!isRecord(result) || result.success !== true) {
    throw new Error(`Fusion Undo failed: ${stableJson(result)}`);
  }
}

/** Undo repeatedly until the token-free fingerprint matches the target, up to
 * maxSteps. Returns the number of Undo steps taken, or undefined when the
 * target geometry did not return within the budget. */
export async function undoFusionUntilFingerprint(
  client: FusionMcpClient,
  documentId: string,
  target: string,
  maxSteps: number,
): Promise<number | undefined> {
  for (let step = 1; step <= maxSteps; step += 1) {
    await undoFusionOnce(client);
    if ((await fingerprintFusionEngineering(client, documentId)) === target) return step;
  }
  return undefined;
}
