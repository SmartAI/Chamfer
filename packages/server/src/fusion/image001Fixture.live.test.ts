import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { FUS_IMAGE_001, FUS_IMAGE_001_ACTION_BODY } from "@chamfer/fusion-fixtures";
import type { FusionActionRequestDto, FusionDocumentIdentityDto } from "@chamfer/shared";
import { fusionActionHarnessScript } from "./actionScripts";
import { captureFusionInspection, evaluateFusionChecks } from "./inspection";
import { inspectionDocumentIdentityScript } from "./inspectionScripts";
import { closeDisposableDocumentScript, createDisposableDocumentScript } from "./integrityScripts";
import { SdkFusionMcpClient } from "./mcpClient";
import { executeFusionScript } from "./mcpPayload";

const liveIt = process.env.CHAMFER_LIVE_FUSION_IMAGE_001 === "1" ? it : it.skip;

liveIt("completes FUS-IMAGE-001 in one Undo step on an explicitly disposable live document", async () => {
  const client = new SdkFusionMcpClient(process.env.CHAMFER_FUSION_MCP_ENDPOINT ?? "http://127.0.0.1:27182/mcp");
  const marker = randomUUID();
  let created = false;
  try {
    await client.connect();
    await executeFusionScript(client, createDisposableDocumentScript(marker));
    created = true;
    const identity = await executeFusionScript(client, inspectionDocumentIdentityScript());
    const document = identity.document as FusionDocumentIdentityDto;
    expect(document?.id).toBeTruthy();
    const request: FusionActionRequestDto = {
      actionId: `live-${FUS_IMAGE_001.id.toLowerCase()}`, document, expectedEvidenceId: "live-disposable",
      expectedRevision: "live-disposable", intent: `Complete ${FUS_IMAGE_001.id} on the marked disposable document`,
      strategy: "targeted", body: FUS_IMAGE_001_ACTION_BODY,
      affectedReferences: [{ id: "root-component", kind: "component" }],
      expectedEffects: [...FUS_IMAGE_001.expectedEffects], model: { provider: "fixture", model: FUS_IMAGE_001.id },
      skills: { foundation: { name: "fusion-foundation", version: "1.1.0" }, loaded: [{ name: "fusion-parametric-features", version: "1.0.0" }] },
    };
    const execution = await executeFusionScript(client, fusionActionHarnessScript(request, document, {}));
    expect(execution.undoEntries).toBe(1);
    const captured = await captureFusionInspection(client, document);
    expect(evaluateFusionChecks(captured.snapshot, FUS_IMAGE_001.expectedEffects,
      { views: captured.screenshots.map((screenshot) => screenshot.view), cameraRestored: captured.cameraRestored })
      .filter((check) => check.status !== "passed")).toEqual([]);
    expect(JSON.stringify(await client.callJson("fusion_mcp_update", { featureType: "undo" }))).toContain("true");
  } finally {
    try {
      if (created) await executeFusionScript(client, closeDisposableDocumentScript(marker));
    } finally {
      await client.close();
    }
  }
}, 120_000);
