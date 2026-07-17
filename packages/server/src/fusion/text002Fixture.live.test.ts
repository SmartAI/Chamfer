import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { FUS_TEXT_002, FUS_TEXT_002_ACTION_BODY } from "@chamfer/fusion-fixtures";
import type { FusionActionRequestDto, FusionDocumentIdentityDto } from "@chamfer/shared";
import { fusionActionHarnessScript } from "./actionScripts";
import { captureFusionInspection, evaluateFusionChecks } from "./inspection";
import { inspectionDocumentIdentityScript } from "./inspectionScripts";
import { closeDisposableDocumentScript, createDisposableDocumentScript } from "./integrityScripts";
import { SdkFusionMcpClient } from "./mcpClient";
import { executeFusionScript } from "./mcpPayload";

const liveIt = process.env.CHAMFER_LIVE_FUSION_TEXT_002 === "1" ? it : it.skip;

liveIt("completes FUS-TEXT-002 in one Undo step on an explicitly disposable live document", async () => {
  const client = new SdkFusionMcpClient(process.env.CHAMFER_FUSION_MCP_ENDPOINT ?? "http://127.0.0.1:27182/mcp");
  const marker = randomUUID();
  let created = false;
  try {
    await client.connect();
    await executeFusionScript(client, createDisposableDocumentScript(marker));
    created = true;
    const identityResult = await executeFusionScript(client, inspectionDocumentIdentityScript());
    const document = identityResult.document as FusionDocumentIdentityDto;
    expect(document?.id).toBeTruthy();

    const request: FusionActionRequestDto = {
      actionId: `live-${FUS_TEXT_002.id.toLowerCase()}`,
      document,
      expectedEvidenceId: "live-disposable",
      expectedRevision: "live-disposable",
      intent: `Complete ${FUS_TEXT_002.id} on the marked disposable document`,
      strategy: "targeted",
      body: FUS_TEXT_002_ACTION_BODY,
      affectedReferences: [],
      expectedEffects: [...FUS_TEXT_002.expectedEffects],
      model: { provider: "fixture", model: FUS_TEXT_002.id },
      skills: { foundation: { name: "fusion-foundation", version: "1.0.0" }, loaded: [{ name: "fusion-parametric-features", version: "1.0.0" }] },
    };
    const execution = await executeFusionScript(client, fusionActionHarnessScript(request, document, {}));
    expect(execution.undoEntries).toBe(1);

    const captured = await captureFusionInspection(client, document);
    const checks = evaluateFusionChecks(captured.snapshot, FUS_TEXT_002.expectedEffects, {
      views: captured.screenshots.map((screenshot) => screenshot.view), cameraRestored: captured.cameraRestored,
    });
    expect(checks.filter((check) => check.status !== "passed"), JSON.stringify({
      bodies: captured.snapshot.bodies.map((body) => ({ name: body.name, bounds: body.geometrySignature })),
      holes: captured.snapshot.holes,
      gussets: captured.snapshot.featureMeasurements?.filter((measurement) => measurement.kind === "gusset"),
      treatments: captured.snapshot.featureMeasurements?.filter((measurement) => measurement.kind === "fillet" || measurement.kind === "chamfer"),
      materials: captured.snapshot.materials,
    })).toEqual([]);

    const undo = await client.callJson("fusion_mcp_update", { featureType: "undo" });
    expect(JSON.stringify(undo)).toContain("true");
  } finally {
    try {
      if (created) await executeFusionScript(client, closeDisposableDocumentScript(marker));
    } finally {
      await client.close();
    }
  }
}, 180_000);
