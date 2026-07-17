import { createHash, randomUUID } from "node:crypto";
import type { FusionMcpClient, FusionMcpSessionInfo, FusionRawTool } from "./mcpClient";
import { SdkFusionMcpClient } from "./mcpClient";
import {
  closeDisposableDocumentScript,
  commandMutationScript,
  createDisposableDocumentScript,
  fingerprintEngineeringScript,
  inspectCameraScript,
  inspectEngineeringScript,
  restoreCameraScript,
} from "./integrityScripts";
import { screenshotPayload } from "./inspection";
import { executeFusionScript as executeScript, isRecord, stableJson } from "./mcpPayload";
import { reconcileFusionSnapshots } from "./reconciliation";
import type { FusionEngineeringSnapshotDto } from "@chamfer/shared";

const EXECUTE_TOOL = "fusion_mcp_execute";
const READ_TOOL = "fusion_mcp_read";
const UPDATE_TOOL = "fusion_mcp_update";
const ELECTRONICS_READ_TOOL = "fusion_mcp_electronics_read";
// adsk.fusion.DesignTypes: DirectDesignType = 0, ParametricDesignType = 1.
const PARAMETRIC_DESIGN_TYPE = 1;

interface ProbeCheck {
  id: string;
  passed: boolean;
  detail: string;
}

export interface FusionIntegrityProbeOptions {
  endpoint: string;
  createDisposable: boolean;
}

export interface FusionIntegrityReport {
  probeVersion: 1;
  startedAt: string;
  finishedAt: string;
  endpoint: string;
  verdict: "go" | "no-go";
  safeForBroaderMutation: boolean;
  versions?: {
    fusion: string;
    mcpProtocol: string;
    mcpServerName: string;
    mcpServer: string;
  };
  disposableDocument?: {
    probeToken: string;
    documentName: string;
    dataFileId: string | null;
    rootEntityToken: string;
  };
  documentation: Array<{ query: string; sha256: string }>;
  engineeringSnapshotHashes: string[];
  screenshotSha256?: string;
  identitySamples: unknown[];
  checks: ProbeCheck[];
  failure?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function schemaObject(tool: FusionRawTool): Record<string, unknown> {
  if (!isRecord(tool.inputSchema)) throw new Error(`${tool.name} inputSchema is not an object`);
  return tool.inputSchema;
}

function schemaProperties(schema: Record<string, unknown>, label: string): Record<string, unknown> {
  const properties = schema.properties;
  if (!isRecord(properties)) throw new Error(`${label} has no properties object`);
  return properties;
}

function requireArrayIncludes(value: unknown, expected: string[], label: string): void {
  if (!Array.isArray(value) || expected.some((item) => !value.includes(item))) {
    throw new Error(`${label} must include ${expected.join(", ")}`);
  }
}

function requirePropertyEnum(properties: Record<string, unknown>, name: string, expected: string[], label: string): void {
  const property = properties[name];
  if (!isRecord(property)) throw new Error(`${label}.${name} is missing`);
  requireArrayIncludes(property.enum, expected, `${label}.${name}.enum`);
}

export function verifyRequiredToolSchemas(tools: FusionRawTool[]): void {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of [EXECUTE_TOOL, READ_TOOL, UPDATE_TOOL, ELECTRONICS_READ_TOOL]) {
    if (!byName.has(name)) throw new Error(`Required Fusion MCP tool is missing: ${name}`);
  }

  const execute = schemaObject(byName.get(EXECUTE_TOOL)!);
  requireArrayIncludes(execute.required, ["featureType", "object"], `${EXECUTE_TOOL}.required`);
  const executeProperties = schemaProperties(execute, EXECUTE_TOOL);
  requirePropertyEnum(executeProperties, "featureType", ["script", "document"], EXECUTE_TOOL);
  const executeObject = executeProperties.object;
  if (!isRecord(executeObject)) throw new Error(`${EXECUTE_TOOL}.object is missing`);
  const executeObjectProperties = schemaProperties(executeObject, `${EXECUTE_TOOL}.object`);
  requirePropertyEnum(executeObjectProperties, "operation", ["open", "close", "save"], `${EXECUTE_TOOL}.object`);
  if (!isRecord(executeObjectProperties.script) || executeObjectProperties.script.type !== "string") {
    throw new Error(`${EXECUTE_TOOL}.object.script must be a string`);
  }

  const read = schemaObject(byName.get(READ_TOOL)!);
  requireArrayIncludes(read.required, ["queryType"], `${READ_TOOL}.required`);
  const readProperties = schemaProperties(read, READ_TOOL);
  requirePropertyEnum(
    readProperties,
    "queryType",
    ["apiDocumentation", "screenshot", "document", "projects", "activeCommand"],
    READ_TOOL,
  );
  requirePropertyEnum(
    readProperties,
    "direction",
    ["current", "front", "back", "top", "iso-top-right"],
    READ_TOOL,
  );

  const update = schemaObject(byName.get(UPDATE_TOOL)!);
  requireArrayIncludes(update.required, ["featureType"], `${UPDATE_TOOL}.required`);
  requirePropertyEnum(schemaProperties(update, UPDATE_TOOL), "featureType", ["undo", "redo"], UPDATE_TOOL);

  const electronics = schemaObject(byName.get(ELECTRONICS_READ_TOOL)!);
  requireArrayIncludes(electronics.required, ["entity_type"], `${ELECTRONICS_READ_TOOL}.required`);
  const electronicsProperties = schemaProperties(electronics, ELECTRONICS_READ_TOOL);
  if (!isRecord(electronicsProperties.entity_type) || !Array.isArray(electronicsProperties.entity_type.enum)) {
    throw new Error(`${ELECTRONICS_READ_TOOL}.entity_type must declare its enum`);
  }
}

async function readOpenDocuments(client: FusionMcpClient): Promise<unknown> {
  return client.callJson(READ_TOOL, { queryType: "document", operation: "open" });
}

async function inspectEngineering(client: FusionMcpClient, marker: string, recompute = false) {
  const result = await executeScript(client, inspectEngineeringScript(marker, recompute));
  if (!isRecord(result.identity) || !isRecord(result.snapshot)) {
    throw new Error("Engineering inspector returned an incomplete result");
  }
  return { identity: result.identity, snapshot: result.snapshot, hash: sha256(stableJson(result.snapshot)) };
}

async function inspectCamera(client: FusionMcpClient, marker: string) {
  const result = await executeScript(client, inspectCameraScript(marker));
  if (!isRecord(result.identity) || !isRecord(result.camera)) {
    throw new Error("Camera inspector returned an incomplete result");
  }
  return { identity: result.identity, camera: result.camera };
}

async function undoOnce(client: FusionMcpClient): Promise<void> {
  const result = await client.callJson(UPDATE_TOOL, { featureType: "undo" });
  if (!isRecord(result) || result.success !== true) {
    throw new Error(`Fusion Undo failed: ${stableJson(result)}`);
  }
}

function identityKey(value: unknown): string {
  if (!isRecord(value)) throw new Error("Document identity sample is invalid");
  return stableJson({
    probeToken: value.probeToken,
    dataFileId: value.dataFileId,
    rootEntityToken: value.rootEntityToken,
    productType: value.productType,
  });
}

function check(report: FusionIntegrityReport, id: string, passed: boolean, detail: string): void {
  report.checks.push({ id, passed, detail });
  if (!passed) throw new Error(`${id}: ${detail}`);
}

async function fingerprintEngineering(client: FusionMcpClient, marker: string): Promise<string> {
  const payload = await executeScript(client, fingerprintEngineeringScript(marker));
  if (!isRecord(payload.fingerprint)) throw new Error("Fusion fingerprint inspector returned no fingerprint");
  return sha256(stableJson(payload.fingerprint));
}

async function undoUntilFingerprint(
  client: FusionMcpClient,
  marker: string,
  target: string,
  maxSteps: number,
): Promise<number | undefined> {
  for (let step = 1; step <= maxSteps; step += 1) {
    await undoOnce(client);
    if ((await fingerprintEngineering(client, marker)) === target) return step;
  }
  return undefined;
}

function ambiguityIsRejected(snapshot: unknown): boolean {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.bodies) || !isRecord(snapshot.bodies[0])) return false;
  const nativeToken = snapshot.bodies[0].entityToken;
  if (typeof nativeToken !== "string" || nativeToken.length === 0) return false;
  const entity = { kind: "body" as const, id: `native:${nativeToken}`, name: "Integrity body", nativeToken };
  const preceding: FusionEngineeringSnapshotDto = {
    designIntent: { designType: "parametric", rootComponent: "Integrity", timelineMarker: 1 },
    units: { distance: "mm", angle: "deg", internalDistance: "cm" },
    parameters: [], sketches: [], features: [], bodies: [], materials: [], entities: [entity],
  };
  const observed: FusionEngineeringSnapshotDto = { ...preceding, entities: [entity, { ...entity }] };
  return reconcileFusionSnapshots(preceding, observed).reason === "ambiguous-entity-identity";
}

async function readInstalledDocs(client: FusionMcpClient, report: FusionIntegrityReport): Promise<void> {
  const queries = [
    { searchPattern: "CommandDefinition", apiCategory: "class", filter: "adsk.core" },
    { searchPattern: "execute", apiCategory: "member", filter: "adsk.core.CommandDefinition" },
    { searchPattern: "Camera", apiCategory: "class", filter: "adsk.core" },
  ];
  for (const query of queries) {
    const value = await client.callJson(READ_TOOL, { queryType: "apiDocumentation", ...query });
    const serialized = stableJson(value);
    if (!serialized.includes(query.searchPattern)) {
      throw new Error(`Installed Fusion API documentation returned no result for ${query.searchPattern}`);
    }
    report.documentation.push({ query: query.searchPattern, sha256: sha256(serialized) });
  }
}

function sessionVersions(session: FusionMcpSessionInfo) {
  return {
    mcpProtocol: session.protocolVersion,
    mcpServerName: session.serverName,
    mcpServer: session.serverVersion,
  };
}

export async function runFusionIntegrityProbe(
  options: FusionIntegrityProbeOptions,
  injectedClient?: FusionMcpClient,
): Promise<FusionIntegrityReport> {
  const startedAt = new Date();
  const report: FusionIntegrityReport = {
    probeVersion: 1,
    startedAt: startedAt.toISOString(),
    finishedAt: startedAt.toISOString(),
    endpoint: options.endpoint,
    verdict: "no-go",
    safeForBroaderMutation: false,
    documentation: [],
    engineeringSnapshotHashes: [],
    identitySamples: [],
    checks: [],
  };
  if (!options.createDisposable) {
    report.checks.push({
      id: "disposable-authority",
      passed: false,
      detail: "Probe refused to connect because createDisposable was not explicitly authorized",
    });
    report.failure = "Explicit authority to create and discard a disposable Fusion document is required";
    report.finishedAt = new Date().toISOString();
    return report;
  }

  const client = injectedClient ?? new SdkFusionMcpClient(options.endpoint);
  const marker = randomUUID();
  let created = false;
  let baselineOpenDocuments: unknown;
  try {
    const session = await client.connect();
    check(report, "mcp-session", true, `${session.serverName} ${session.serverVersion} using ${session.protocolVersion}`);
    verifyRequiredToolSchemas(session.tools);
    check(report, "raw-tool-schemas", true, "All four required Fusion MCP tool schemas are compatible");
    await readInstalledDocs(client, report);
    check(report, "installed-api-documentation", true, "Required installed API documentation was returned");

    baselineOpenDocuments = await readOpenDocuments(client);
    const createdDocument = await executeScript(client, createDisposableDocumentScript(marker));
    created = true;
    if (
      createdDocument.probeToken !== marker ||
      typeof createdDocument.documentName !== "string" ||
      typeof createdDocument.rootEntityToken !== "string" ||
      Number(createdDocument.documentCountAfter) !== Number(createdDocument.documentCountBefore) + 1
    ) {
      throw new Error(
        `Fusion did not prove creation and marking of exactly one disposable document: ${stableJson(createdDocument)}`,
      );
    }
    report.disposableDocument = {
      probeToken: marker,
      documentName: createdDocument.documentName,
      dataFileId: typeof createdDocument.dataFileId === "string" ? createdDocument.dataFileId : null,
      rootEntityToken: createdDocument.rootEntityToken,
    };
    report.versions = { fusion: String(createdDocument.fusionVersion), ...sessionVersions(session) };
    check(report, "disposable-document", true, "Created and marked exactly one new unsaved Fusion design");

    const baseline = await inspectEngineering(client, marker);
    report.identitySamples.push(baseline.identity);
    report.engineeringSnapshotHashes.push(baseline.hash);
    check(
      report,
      "design-eligibility",
      String(baseline.identity.productType).includes("Design") &&
        baseline.snapshot.designType === PARAMETRIC_DESIGN_TYPE,
      "The disposable document is a history-enabled Fusion design eligible for parametric-part mutation",
    );
    const baselineFingerprint = await fingerprintEngineering(client, marker);

    // Single-Undo atomicity is only defined with nothing between the action
    // and its Undo: any interleaved script that reads entityToken pushes its
    // own entry onto the native Undo stack and would be popped instead.
    await executeScript(client, commandMutationScript(marker, "single_undo"));
    await undoOnce(client);
    const undone = await inspectEngineering(client, marker);
    report.identitySamples.push(undone.identity);
    report.engineeringSnapshotHashes.push(undone.hash);
    check(
      report,
      "single-undo-atomicity",
      undone.hash === baseline.hash,
      `One immediate Undo ${undone.hash === baseline.hash ? "restored" : "did not restore"} the exact pre-action snapshot`,
    );

    await executeScript(client, commandMutationScript(marker, "coherent_mutation"));
    const mutated = await inspectEngineering(client, marker);
    report.identitySamples.push(mutated.identity);
    report.engineeringSnapshotHashes.push(mutated.hash);
    check(report, "coherent-mutation", mutated.hash !== baseline.hash, "Command handler created native design state");
    check(
      report,
      "manual-edit-detection",
      mutated.hash !== baseline.hash,
      "An out-of-band MCP mutation changed the trusted engineering fingerprint before reconciliation",
    );
    check(
      report,
      "entity-ambiguity-handling",
      ambiguityIsRejected(mutated.snapshot),
      "The production reconciliation policy rejected duplicate identity resolution using a live Fusion entity token",
    );
    // The token-reading inspection above pushed its own Undo entry, so rolling
    // the mutation back requires the verified loop rather than one blind Undo.
    const mutationRollbackSteps = await undoUntilFingerprint(client, marker, baselineFingerprint, 4);
    if (mutationRollbackSteps === undefined) {
      throw new Error("deterministic-rollback: verified Undo could not restore the baseline after an inspected mutation");
    }

    await executeScript(client, commandMutationScript(marker, "failed_verification"));
    const rejected = await inspectEngineering(client, marker);
    report.identitySamples.push(rejected.identity);
    report.engineeringSnapshotHashes.push(rejected.hash);
    const deliberatelyFailed = isRecord(rejected.snapshot) && Array.isArray(rejected.snapshot.bodies)
      ? rejected.snapshot.bodies.length === 2
      : false;
    check(
      report,
      "deliberate-immediate-verification",
      !deliberatelyFailed,
      "Deliberate expectation of two bodies failed as intended",
    );
    const rejectionRollbackSteps = await undoUntilFingerprint(client, marker, baselineFingerprint, 4);
    const rolledBack = rejectionRollbackSteps === undefined ? undefined : await inspectEngineering(client, marker);
    if (rolledBack) {
      report.identitySamples.push(rolledBack.identity);
      report.engineeringSnapshotHashes.push(rolledBack.hash);
    }
    check(
      report,
      "deterministic-rollback",
      rolledBack !== undefined && rolledBack.hash === baseline.hash,
      `Verified Undo ${rolledBack && rolledBack.hash === baseline.hash ? "restored" : "did not restore"} the authoritative snapshot (${mutationRollbackSteps} then ${rejectionRollbackSteps ?? "> 4"} steps)`,
    );

    const recomputed = await inspectEngineering(client, marker, true);
    report.identitySamples.push(recomputed.identity);
    report.engineeringSnapshotHashes.push(recomputed.hash);
    check(report, "recompute-stability", recomputed.hash === baseline.hash, "computeAll preserved engineering state");

    const cameraBefore = await inspectCamera(client, marker);
    report.identitySamples.push(cameraBefore.identity);
    const screenshot = await client.callJson(READ_TOOL, {
      queryType: "screenshot",
      width: 640,
      height: 480,
      antiAliasing: true,
      transparentBackground: false,
      direction: "iso-top-right",
    });
    report.screenshotSha256 = sha256(screenshotPayload(screenshot).data);
    const displaced = await inspectCamera(client, marker);
    report.identitySamples.push(displaced.identity);
    await executeScript(client, restoreCameraScript(marker, cameraBefore.camera));
    const cameraAfter = await inspectCamera(client, marker);
    report.identitySamples.push(cameraAfter.identity);
    check(
      report,
      "exact-camera-restoration",
      stableJson(cameraAfter.camera) === stableJson(cameraBefore.camera),
      "Standardized screenshot capture restored every recorded camera field exactly",
    );

    const expectedIdentity = identityKey(baseline.identity);
    check(
      report,
      "document-identity-stability",
      report.identitySamples.every((sample) => identityKey(sample) === expectedIdentity),
      "Document identity stayed stable across inspection, mutation, Undo, recompute, and camera movement",
    );

    await executeScript(client, closeDisposableDocumentScript(marker));
    created = false;
    const finalOpenDocuments = await readOpenDocuments(client);
    check(
      report,
      "unrelated-document-isolation",
      stableJson(finalOpenDocuments) === stableJson(baselineOpenDocuments),
      "Open document state returned exactly to its pre-probe value",
    );
    report.verdict = "go";
    report.safeForBroaderMutation = true;
  } catch (error) {
    report.failure = error instanceof Error ? error.message : String(error);
  } finally {
    if (created) {
      try {
        await executeScript(client, closeDisposableDocumentScript(marker));
        created = false;
        if (baselineOpenDocuments !== undefined) {
          const finalOpenDocuments = await readOpenDocuments(client);
          const isolated = stableJson(finalOpenDocuments) === stableJson(baselineOpenDocuments);
          report.checks.push({
            id: "failed-probe-isolation",
            passed: isolated,
            detail: isolated
              ? "Failed probe cleanup restored the pre-probe open document state"
              : "Failed probe cleanup did not restore the pre-probe open document state",
          });
          if (!isolated) {
            report.failure = report.failure
              ? `${report.failure}; failed probe changed unrelated open document state`
              : "Failed probe changed unrelated open document state";
          }
        }
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        report.checks.push({ id: "disposable-cleanup", passed: false, detail: message });
        report.failure = report.failure ? `${report.failure}; cleanup failed: ${message}` : `Cleanup failed: ${message}`;
      }
    }
    try {
      await client.close();
    } catch (closeError) {
      const message = closeError instanceof Error ? closeError.message : String(closeError);
      report.checks.push({ id: "mcp-session-close", passed: false, detail: message });
      report.failure = report.failure ? `${report.failure}; session close failed: ${message}` : message;
      report.verdict = "no-go";
      report.safeForBroaderMutation = false;
    }
    report.finishedAt = new Date().toISOString();
  }
  return report;
}
