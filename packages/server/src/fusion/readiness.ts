import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  FusionDocumentIdentityDto,
  FusionDocumentationQueryDto,
  FusionDocumentationResultDto,
  FusionReadinessDto,
  FusionReadinessState,
} from "@chamfer/shared";
import { fusionReadinessAllowsInspection } from "@chamfer/shared";
import { readEffectiveSettings } from "../settingsStore";
import { verifyRequiredToolSchemas } from "./integrityProbe";
import { SdkFusionMcpClient, validateFusionMcpEndpoint, type FusionMcpClient, type FusionMcpSessionInfo } from "./mcpClient";
import { discoverFusionMcpEndpoint } from "./discovery";
import { captureCameraScript, inspectReadinessScript, restoreCameraScript } from "./readinessScripts";
import { executeFusionScript, isRecord, primeFusionRecursionGuard, stableJson } from "./mcpPayload";
import { documentationExcerpts, type FusionDocumentationProvider } from "./documentation";
import {
  captureFusionInspection,
  captureFusionEngineeringState,
  FusionInspectionCaptureError,
  type CapturedFusionInspection,
} from "./inspection";
import { FusionActionLeaseUnavailableError, type FusionActionLeaseContext, type FusionActionRuntime } from "./action";
import { FusionLifecycleRuntimeError, type FusionLifecycleRuntime } from "./lifecycle";
import { fusionActionHarnessScript } from "./actionScripts";
import { fingerprintEngineeringScript } from "./integrityScripts";
import { currentFusionRecovery } from "./recoveryStore";
import type { FusionActionRequestDto } from "@chamfer/shared";
import { fusionIntegrityAccessFromEnv } from "./integrityGate";

const DEFAULT_ENDPOINT = "http://127.0.0.1:27182/mcp";
const READ_TOOL = "fusion_mcp_read";

/** Actionable diagnosis for the one failure that a session cannot recover from:
 * the installed Fusion MCP add-in leaks an interpreter wrapper per script run,
 * and after enough runs any call recurses until the interpreter's C-stack
 * overflows and every tool fails. Reported distinctly (not as a version or
 * schema mismatch) so the user restarts Fusion instead of chasing a non-issue. */
export const FUSION_ADAPTER_EXHAUSTED_DIAGNOSIS =
  "Autodesk Fusion's MCP add-in has run out of interpreter stack - a known Fusion leak that accumulates over a long session. Restart Autodesk Fusion to reconnect; Chamfer detects the new adapter port automatically.";

/** True when an adapter response carries the interpreter-exhaustion signature. */
export function looksLikeFusionAdapterExhaustion(value: string): boolean {
  return /RecursionError|maximum recursion depth|Stack overflow/i.test(value);
}

export interface FusionLiveCapabilities {
  document?: FusionDocumentIdentityDto;
  documentMatchesBinding: boolean;
  writable: boolean;
  busy: boolean;
  supported: boolean;
  inspectorHealthy: boolean;
  cameraRestored: boolean;
  atomicityProven: boolean;
}

export interface DerivedFusionReadiness {
  state: Exclude<FusionReadinessState, "unavailable" | "incompatible">;
  label: string;
  diagnosis: string;
  mutationAllowed: boolean;
}

const READINESS_PRESENTATION: Record<DerivedFusionReadiness["state"], { label: string; diagnosis: string }> = {
  "no-document": { label: "No document", diagnosis: "Open a Fusion design to continue." },
  "wrong-document": { label: "Wrong document", diagnosis: "The active Fusion design is not the conversation's bound document." },
  "read-only": { label: "Read only", diagnosis: "The active Fusion design can be inspected but is not writable." },
  busy: { label: "Busy", diagnosis: "Fusion is running another command. Readiness will update when it finishes." },
  unsupported: { label: "Unsupported", diagnosis: "The active document is outside the supported parametric-part scope." },
  degraded: { label: "Degraded", diagnosis: "A required integrity capability is unavailable; modeling remains blocked." },
  ready: { label: "Ready", diagnosis: "Fusion is connected, compatible, and ready for inspection." },
};

export function deriveFusionReadiness(profile: FusionLiveCapabilities): DerivedFusionReadiness {
  let state: DerivedFusionReadiness["state"];
  if (!profile.document) state = "no-document";
  else if (!profile.documentMatchesBinding) state = "wrong-document";
  else if (!profile.writable) state = "read-only";
  else if (profile.busy) state = "busy";
  else if (!profile.supported) state = "unsupported";
  else if (!profile.inspectorHealthy || !profile.cameraRestored || !profile.atomicityProven) state = "degraded";
  else state = "ready";
  return { state, ...READINESS_PRESENTATION[state], mutationAllowed: state === "ready" };
}

export interface FusionReadinessProvider {
  current(): Promise<FusionReadinessDto>;
  /** Synchronous endpoint lease state for lifecycle guards that must not queue
   * behind the mutation they are supposed to reject. */
  mutationInProgress?(): boolean;
  /** Result of the same trusted inspection used by current(); never exposed to the browser. */
  documentIsOpen?(creationId: string): boolean | undefined;
  /** Trusted read-only engineering snapshot and native evidence capture. */
  captureInspection?(expectedDocument: FusionDocumentIdentityDto, captureViews?: boolean): Promise<CapturedFusionInspection>;
  /** Cheap fingerprint probe that captures full native evidence only after an
   * engineering revision changes. */
  captureInspectionIfChanged?(expectedDocument: FusionDocumentIdentityDto, expectedRevision: string): Promise<CapturedFusionInspection | undefined>;
  /** Camera restoration is a readiness capability and fails closed. */
  markCameraRestoration?(restored: boolean): void;
}

export interface FusionConnectorOptions {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  clientFactory?: (endpoint: string) => FusionMcpClient;
  /** Resolves the live Fusion MCP endpoint when the preferred one is unreachable.
   * Injectable for tests; defaults to probing the local Fusion process's ports. */
  discoverEndpoint?: (preferredEndpoint: string) => Promise<string | undefined>;
}

interface NegotiatedSession {
  endpoint: string;
  client: FusionMcpClient;
  cameraRestored?: boolean;
  atomicityProven: boolean;
  info: FusionMcpSessionInfo;
  fusionVersion?: string;
}

async function verifyInstalledDocumentation(client: FusionMcpClient): Promise<void> {
  for (const query of ["Application", "Design", "Camera"]) {
    const result = await client.callJson(READ_TOOL, {
      queryType: "apiDocumentation",
      searchPattern: query,
      apiCategory: "class",
      filter: query === "Design" ? "adsk.fusion" : "adsk.core",
    });
    const serialized = stableJson(result);
    // A leaked adapter answers every script-backed call (documentation included)
    // with a recursion traceback. Surface that as the restart-needed diagnosis
    // rather than a misleading "documentation is missing" compatibility error.
    if (looksLikeFusionAdapterExhaustion(serialized)) throw new Error(FUSION_ADAPTER_EXHAUSTED_DIAGNOSIS);
    if (!serialized.includes(query)) throw new Error(`Installed Fusion API documentation is missing ${query}`);
  }
}

async function verifyCameraRestoration(client: FusionMcpClient): Promise<boolean> {
  const before = await executeFusionScript(client, captureCameraScript());
  if (!isRecord(before.camera)) throw new Error("Fusion camera inspector returned no camera state");
  await client.callJson(READ_TOOL, {
    queryType: "screenshot",
    width: 64,
    height: 64,
    antiAliasing: false,
    transparentBackground: false,
    direction: "iso-top-right",
  });
  await executeFusionScript(client, restoreCameraScript(before.camera));
  const after = await executeFusionScript(client, captureCameraScript());
  return isRecord(after.camera) && stableJson(after.camera) === stableJson(before.camera);
}

async function readAtomicityProof(path: string | undefined, endpoint: string): Promise<boolean> {
  if (!path) return false;
  try {
    const report = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    return integrityReportProvesAtomicity(report, endpoint);
  } catch {
    return false;
  }
}

const REQUIRED_INTEGRITY_CHECKS = [
  "mcp-session",
  "raw-tool-schemas",
  "installed-api-documentation",
  "disposable-document",
  "coherent-mutation",
  "single-undo-atomicity",
  "deliberate-immediate-verification",
  "deterministic-rollback",
  "recompute-stability",
  "exact-camera-restoration",
  "document-identity-stability",
  "unrelated-document-isolation",
] as const;

function isLoopbackMcpEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    validateFusionMcpEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

export function integrityReportProvesAtomicity(report: Record<string, unknown>, endpoint: string): boolean {
  try {
    // The atomicity proof certifies the behavior of the one local Fusion adapter,
    // not a specific port. Fusion's MCP port can drift between launches, so the
    // report is accepted as long as it and the live endpoint are both valid
    // loopback MCP endpoints - anything else stays fail-closed.
    if (
      report.probeVersion !== 1 ||
      report.verdict !== "go" ||
      !isLoopbackMcpEndpoint(report.endpoint) ||
      !isLoopbackMcpEndpoint(endpoint) ||
      report.safeForBroaderMutation !== true ||
      typeof report.startedAt !== "string" ||
      typeof report.finishedAt !== "string" ||
      !isRecord(report.versions) ||
      !isRecord(report.disposableDocument) ||
      !Array.isArray(report.documentation) || report.documentation.length === 0 ||
      !Array.isArray(report.engineeringSnapshotHashes) || report.engineeringSnapshotHashes.length === 0 ||
      !Array.isArray(report.identitySamples) || report.identitySamples.length === 0 ||
      typeof report.screenshotSha256 !== "string" ||
      !Array.isArray(report.checks)
    ) return false;
    const passed = new Set(
      report.checks
        .filter((check): check is Record<string, unknown> => isRecord(check) && check.passed === true)
        .map((check) => check.id),
    );
    return REQUIRED_INTEGRITY_CHECKS.every((id) => passed.has(id));
  } catch {
    return false;
  }
}

export class FusionConnector implements FusionReadinessProvider, FusionDocumentationProvider, FusionActionRuntime, FusionLifecycleRuntime {
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => Date;
  private readonly clientFactory: (endpoint: string) => FusionMcpClient;
  private readonly discoverEndpoint: (preferredEndpoint: string) => Promise<string | undefined>;
  /** Last endpoint that produced a working session; tried before rediscovering
   * so a stable session does not re-run port discovery on every poll. */
  private lastGoodEndpoint?: string;
  private negotiated?: NegotiatedSession;
  private inFlight?: Promise<FusionReadinessDto>;
  private openDocumentIds?: Set<string>;
  private endpointTail: Promise<void> = Promise.resolve();
  private mutationReserved = false;
  private recoveryFailed = false;

  constructor(private readonly db: DatabaseSync, options: FusionConnectorOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.clientFactory = options.clientFactory ?? ((endpoint) => new SdkFusionMcpClient(endpoint));
    this.discoverEndpoint = options.discoverEndpoint
      ?? ((preferredEndpoint) => discoverFusionMcpEndpoint({ preferredEndpoint }));
  }

  current(): Promise<FusionReadinessDto> {
    if (!this.inFlight) this.inFlight = this.enqueue(() => this.refresh()).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  documentIsOpen(creationId: string): boolean | undefined {
    return this.openDocumentIds?.has(creationId);
  }

  mutationInProgress(): boolean {
    return this.mutationReserved;
  }

  async search(input: FusionDocumentationQueryDto): Promise<FusionDocumentationResultDto> {
    return this.enqueue(async () => {
    await this.refresh();
    const session = this.negotiated;
    if (!session?.fusionVersion) throw new Error("Installed Fusion API documentation is unavailable until Fusion is connected.");
    const raw = await session.client.callJson(READ_TOOL, {
      queryType: "apiDocumentation",
      searchPattern: input.query,
      apiCategory: input.category,
      filter: input.owner ?? input.namespace,
    });
    const excerpts = documentationExcerpts(raw);
    if (excerpts.length === 0) throw new Error(`Installed Fusion API documentation returned no result for ${input.query}`);
    return {
      query: input.query,
      excerpts,
      source: {
        kind: "installed-fusion-api",
        fusionVersion: /^[A-Za-z0-9._-]{1,40}$/.test(session.fusionVersion) ? session.fusionVersion : "unknown",
        mcpProtocolVersion: /^[A-Za-z0-9._-]{1,40}$/.test(session.info.protocolVersion) ? session.info.protocolVersion : "unknown",
        mcpServer: "Autodesk Fusion MCP",
      },
    };
    });
  }

  async captureInspection(expectedDocument: FusionDocumentIdentityDto, captureViews = false): Promise<CapturedFusionInspection> {
    return this.enqueue(async () => {
      await this.refresh();
      return this.captureInspectionUnlocked(expectedDocument, captureViews);
    });
  }

  async captureInspectionIfChanged(expectedDocument: FusionDocumentIdentityDto, expectedRevision: string): Promise<CapturedFusionInspection | undefined> {
    return this.enqueue(async () => {
      await this.refresh();
      if (!this.negotiated) throw new Error("Fusion inspection requires a connected compatible MCP session");
      const engineering = await captureFusionEngineeringState(this.negotiated.client, expectedDocument);
      if (engineering.revision === expectedRevision) return undefined;
      return this.captureInspectionUnlocked(expectedDocument);
    });
  }

  /** Token-free engineering fingerprint of the active design. Runs the same
   * inspector the integrity probe uses; it never reads entityToken, so it leaves
   * the native Undo stack untouched and is safe to call inside a rollback loop. */
  private async engineeringFingerprintUnlocked(document: FusionDocumentIdentityDto): Promise<string> {
    if (!this.negotiated) throw new Error("Fusion fingerprint requires a connected compatible MCP session");
    const payload = await executeFusionScript(this.negotiated.client, fingerprintEngineeringScript(document.id));
    if (!isRecord(payload.fingerprint)) throw new Error("Fusion fingerprint inspector returned no fingerprint");
    return createHash("sha256").update(stableJson(payload.fingerprint)).digest("hex");
  }

  async runExclusive<T>(operation: (context: FusionActionLeaseContext) => Promise<T>): Promise<T> {
    if (this.mutationReserved) throw new FusionActionLeaseUnavailableError("The Fusion endpoint action lease is unavailable.");
    this.mutationReserved = true;
    try {
      return await this.enqueue(async () => operation({
        current: () => this.refresh(),
        captureInspection: (document, captureViews) => this.captureInspectionUnlocked(document, captureViews),
        diagnose: async (document) => {
          await this.disconnect();
          const readiness = await this.refresh();
          if (!this.negotiated || !fusionReadinessAllowsInspection(readiness.state) || readiness.state === "busy") {
            throw new Error("Fusion is not available for read-only recovery diagnosis");
          }
          return this.captureInspectionUnlocked(document);
        },
        execute: async (request: FusionActionRequestDto, references: Record<string, string>) => {
          await this.refresh();
          if (!this.negotiated) throw new Error("Fusion action requires a connected compatible MCP session");
          const configured = Number(this.env.CHAMFER_FUSION_ACTION_TIMEOUT_S);
          const deadlineSeconds = Number.isFinite(configured) && configured > 0 ? configured : 180;
          const result = await executeFusionScript(
            this.negotiated.client,
            fusionActionHarnessScript(request, request.document, references, deadlineSeconds),
            // Give the transport headroom beyond the in-Fusion budget so the
            // harness's own clean "timed out" wins over an MCP transport timeout.
            { timeoutMs: (deadlineSeconds + 30) * 1000 },
          );
          if (typeof result.commandId !== "string" || result.undoEntries !== 1) throw new Error("Fusion action harness returned an invalid transaction result");
          return { commandId: result.commandId, undoEntries: 1 };
        },
        undo: async () => {
          if (!this.negotiated) throw new Error("Fusion Undo requires a connected compatible MCP session");
          const result = await this.negotiated.client.callJson("fusion_mcp_update", { featureType: "undo" });
          if (isRecord(result) && result.success === false) throw new Error("Fusion refused automatic Undo");
        },
        engineeringFingerprint: (document) => this.engineeringFingerprintUnlocked(document),
        verifiedUndo: async (document, target, maxSteps) => {
          // Trusted post-action inspection reads entityToken on the new entities,
          // which pushes extra native Undo entries on top of the command. A single
          // blind Undo would pop one of those, not the command, leaving the
          // mutation in place - so undo repeatedly and check a token-free
          // fingerprint (which never perturbs the Undo stack) until the baseline
          // geometry returns. This is the same verified-rollback loop the
          // integrity probe proves against live Fusion.
          for (let step = 0; step < maxSteps; step += 1) {
            if (!this.negotiated) throw new Error("Fusion Undo requires a connected compatible MCP session");
            const result = await this.negotiated.client.callJson("fusion_mcp_update", { featureType: "undo" });
            if (isRecord(result) && result.success === false) throw new Error("Fusion refused automatic Undo");
            if ((await this.engineeringFingerprintUnlocked(document)) === target) return true;
          }
          return false;
        },
        markRecoveryFailure: () => { this.recoveryFailed = true; },
        clearRecoveryFailure: () => { this.recoveryFailed = false; },
      }));
    } finally {
      this.mutationReserved = false;
    }
  }

  async save(expectedDocument: FusionDocumentIdentityDto, expectedRevision: string) {
    if (this.mutationReserved) throw new FusionLifecycleRuntimeError("Fusion is busy with another action.", "busy");
    this.mutationReserved = true;
    try {
      return await this.enqueue(async () => {
        const beforeReadiness = await this.refresh();
        if (beforeReadiness.state !== "ready" || !beforeReadiness.document ||
            beforeReadiness.document.id !== expectedDocument.id ||
            (expectedDocument.dataFileId !== undefined && beforeReadiness.document.dataFileId !== expectedDocument.dataFileId)) {
          throw new FusionLifecycleRuntimeError("The active Fusion document no longer matches the Save target.", "wrong-document");
        }
        if (expectedDocument.dataFileId && beforeReadiness.documentModified !== true) {
          throw new FusionLifecycleRuntimeError("The bound Fusion document has no unpersisted changes.", "already-saved");
        }
        const before = await this.captureInspectionUnlocked(expectedDocument);
        if (before.revision !== expectedRevision) {
          throw new FusionLifecycleRuntimeError("The verified Fusion revision changed before Save.", "stale-revision");
        }
        if (!this.negotiated) throw new FusionLifecycleRuntimeError("Fusion is not connected.", "failed");
        let raw: unknown;
        try {
          raw = await this.negotiated.client.callJson("fusion_mcp_execute", {
            featureType: "document",
            object: { operation: "save" },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new FusionLifecycleRuntimeError(message, /cancel/i.test(message) ? "canceled" : "failed");
        }
        if (isRecord(raw) && raw.success === false) {
          const message = String(raw.error ?? raw.message ?? "Fusion Save failed.");
          const canceled = raw.canceled === true || raw.cancelled === true || /cancel/i.test(message);
          throw new FusionLifecycleRuntimeError(message, canceled ? "canceled" : "failed");
        }
        const afterReadiness = await this.refresh();
        const document = afterReadiness.document;
        if (!document || document.id !== expectedDocument.id || !document.dataFileId) {
          throw new FusionLifecycleRuntimeError("Fusion Save did not return durable identity for the bound document.", "wrong-document");
        }
        const captured = await this.captureInspectionUnlocked(document);
        const finalReadiness = await this.refresh();
        if (finalReadiness.documentModified === true) {
          throw new FusionLifecycleRuntimeError("Fusion still reports unpersisted changes after Save.", "failed");
        }
        return { document, captured, readiness: finalReadiness };
      });
    } finally {
      this.mutationReserved = false;
    }
  }

  private async captureInspectionUnlocked(expectedDocument: FusionDocumentIdentityDto, captureViews = false): Promise<CapturedFusionInspection> {
    if (!this.negotiated) throw new Error("Fusion inspection requires a connected compatible MCP session");
    try {
      const captured = await captureFusionInspection(this.negotiated.client, expectedDocument, captureViews);
      this.markCameraRestoration(captured.cameraRestored);
      return captured;
    } catch (error) {
      if (error instanceof FusionInspectionCaptureError) this.markCameraRestoration(error.cameraRestored);
      throw error;
    }
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.endpointTail;
    let release!: () => void;
    this.endpointTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  markCameraRestoration(restored: boolean): void {
    if (this.negotiated) this.negotiated.cameraRestored = restored;
  }

  private base(endpoint: string, state: "unavailable" | "incompatible", diagnosis: string): FusionReadinessDto {
    return {
      state,
      label: state === "unavailable" ? "Unavailable" : "Incompatible",
      diagnosis,
      endpoint,
      checkedAt: this.now().toISOString(),
      mutationAllowed: false,
    };
  }

  private async refresh(): Promise<FusionReadinessDto> {
    const { settings } = readEffectiveSettings(this.db, this.env);
    // Preferred order: an explicit user setting, then the last endpoint that
    // worked, then Fusion's default port. Discovery only runs if this fails.
    const preferredEndpoint = settings.fusionMcpEndpoint ?? this.lastGoodEndpoint ?? DEFAULT_ENDPOINT;
    if (!fusionIntegrityAccessFromEnv(this.env).enabled) {
      return this.base(preferredEndpoint, "unavailable", "The experimental Fusion connector is disabled.");
    }
    // An explicit endpoint change invalidates a cached session bound to the old one.
    if (this.negotiated && settings.fusionMcpEndpoint && this.negotiated.endpoint !== settings.fusionMcpEndpoint) {
      await this.disconnect();
    }

    let session = this.negotiated;
    let endpoint = session?.endpoint ?? preferredEndpoint;
    if (!session) {
      const connected = await this.connectFusion(preferredEndpoint, !settings.fusionMcpEndpoint);
      if (!connected) {
        return this.base(preferredEndpoint, "unavailable", "Chamfer cannot reach the local Fusion MCP endpoint.");
      }
      endpoint = connected.endpoint;
      this.lastGoodEndpoint = endpoint;
      try {
        verifyRequiredToolSchemas(connected.info.tools);
        await primeFusionRecursionGuard(connected.client);
        await verifyInstalledDocumentation(connected.client);
        const atomicityProven = await readAtomicityProof(this.env.CHAMFER_FUSION_INTEGRITY_REPORT, endpoint);
        session = { endpoint, client: connected.client, atomicityProven, info: connected.info };
        this.negotiated = session;
      } catch (error) {
        await connected.client.close().catch(() => undefined);
        const diagnosis = error instanceof Error ? error.message : String(error);
        return this.base(endpoint, "incompatible", diagnosis);
      }
    }

    const negotiated = session;
    try {
      const inspected = await executeFusionScript(negotiated.client, inspectReadinessScript());
      this.openDocumentIds = Array.isArray(inspected.openDocumentIds) &&
        inspected.openDocumentIds.every((id) => typeof id === "string")
        ? new Set(inspected.openDocumentIds as string[])
        : undefined;
      if (typeof inspected.fusionVersion === "string") negotiated.fusionVersion = inspected.fusionVersion;
      const rawDocument = inspected.document;
      const document = isRecord(rawDocument) && typeof rawDocument.id === "string" && typeof rawDocument.name === "string"
        ? {
            id: rawDocument.id,
            name: rawDocument.name,
            ...(typeof rawDocument.dataFileId === "string" ? { dataFileId: rawDocument.dataFileId } : {}),
            ...(typeof rawDocument.versionId === "string" ? { versionId: rawDocument.versionId } : {}),
            ...(typeof rawDocument.versionNumber === "number" ? { versionNumber: rawDocument.versionNumber } : {}),
          }
        : undefined;
      if (document && negotiated.cameraRestored === undefined) {
        try {
          negotiated.cameraRestored = await verifyCameraRestoration(negotiated.client);
        } catch {
          // Camera failure is a degraded integrity capability, not permission to
          // hide an otherwise inspectable document behind a connection error.
          negotiated.cameraRestored = false;
        }
      }
      // The ledger is the authority on unresolved recovery, and every
      // recovery-failure latch is paired with an unresolved ledger row. When
      // that row is gone (resolved, or released because its owning conversation
      // was deleted), the in-memory latch is stale and must not keep degrading
      // an endpoint that fresh trusted inspection can serve again.
      if (this.recoveryFailed && !currentFusionRecovery(this.db, endpoint)) {
        this.recoveryFailed = false;
      }
      const profile: FusionLiveCapabilities = {
        document,
        // Conversation bindings are server-owned and compared locally. A raw MCP
        // payload cannot authorize or redirect work by claiming that a tab matches.
        documentMatchesBinding: true,
        writable: inspected.writable !== false,
        busy: inspected.busy === true,
        supported: inspected.supported !== false,
        inspectorHealthy: inspected.inspectorHealthy === true && !this.recoveryFailed,
        cameraRestored: negotiated.cameraRestored === true,
        atomicityProven: negotiated.atomicityProven,
      };
      const derived = deriveFusionReadiness(profile);
      return {
        ...derived,
        endpoint,
        checkedAt: this.now().toISOString(),
        document,
        documentModified: inspected.isModified === true,
        ...(negotiated.cameraRestored !== undefined ? { cameraRestored: negotiated.cameraRestored } : {}),
      };
    } catch {
      await this.disconnect();
      return this.base(endpoint, "unavailable", "The Fusion MCP session disconnected; Chamfer will reconnect automatically.");
    }
  }

  private async disconnect(): Promise<void> {
    const existing = this.negotiated;
    this.negotiated = undefined;
    this.openDocumentIds = undefined;
    await existing?.client.close().catch(() => undefined);
  }

  /** Connects to the preferred Fusion MCP endpoint, falling back to discovering
   * the live adapter port when that endpoint does not answer. Returns the open
   * client and the endpoint that actually worked, or undefined when Fusion is
   * unreachable. Discovery runs only on a connect miss, never on every poll —
   * and never when the endpoint was configured explicitly: a pinned endpoint
   * that is down must read as unavailable rather than silently drifting to a
   * different Fusion instance that would then diagnose as wrong-document. */
  private async connectFusion(
    preferred: string,
    allowDiscovery: boolean,
  ): Promise<{ client: FusionMcpClient; info: FusionMcpSessionInfo; endpoint: string } | undefined> {
    const tryConnect = async (candidate: string) => {
      let client: FusionMcpClient | undefined;
      try {
        client = this.clientFactory(candidate);
        const info = await client.connect();
        return { client, info, endpoint: candidate };
      } catch {
        await client?.close().catch(() => undefined);
        return undefined;
      }
    };
    const direct = await tryConnect(preferred);
    if (direct) return direct;
    if (!allowDiscovery) return undefined;
    const discovered = await this.discoverEndpoint(preferred).catch(() => undefined);
    if (discovered && discovered !== preferred) return tryConnect(discovered);
    return undefined;
  }
}
