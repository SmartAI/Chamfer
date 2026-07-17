import { describe, expect, it } from "vitest";
import { runFusionIntegrityProbe, verifyRequiredToolSchemas } from "./integrityProbe";
import type { FusionMcpClient, FusionMcpSessionInfo, FusionRawTool } from "./mcpClient";

function property(type: string, values?: string[]) {
  return values ? { type, enum: values } : { type };
}

function requiredTools(): FusionRawTool[] {
  return [
    {
      name: "fusion_mcp_execute",
      inputSchema: {
        type: "object",
        required: ["featureType", "object"],
        properties: {
          featureType: property("string", ["script", "document"]),
          object: {
            type: "object",
            properties: {
              operation: property("string", ["open", "close", "save"]),
              script: property("string"),
            },
          },
        },
      },
    },
    {
      name: "fusion_mcp_read",
      inputSchema: {
        type: "object",
        required: ["queryType"],
        properties: {
          queryType: property("string", ["apiDocumentation", "screenshot", "document", "projects", "activeCommand"]),
          direction: property("string", ["current", "front", "back", "top", "iso-top-right"]),
        },
      },
    },
    {
      name: "fusion_mcp_update",
      inputSchema: {
        type: "object",
        required: ["featureType"],
        properties: { featureType: property("string", ["undo", "redo"]) },
      },
    },
    {
      name: "fusion_mcp_electronics_read",
      inputSchema: {
        type: "object",
        required: ["entity_type"],
        properties: { entity_type: property("string", ["electronics.Board"]) },
      },
    },
  ];
}

const IDENTITY = {
  probeToken: "replaced per call",
  documentName: "Untitled",
  dataFileId: null,
  rootEntityToken: "root-token",
  productType: "DesignProductType",
};

class FakeFusionMcp implements FusionMcpClient {
  connectCount = 0;
  closeCount = 0;
  closedDocument = false;
  mutated = false;
  camera = {
    eye: [1, 2, 3],
    target: [0, 0, 0],
    upVector: [0, 1, 0],
    cameraType: 0,
    perspectiveAngle: 0.5,
    viewExtents: 12,
    isFitView: false,
  };
  private marker = "";
  private readonly baselineDocuments = {
    success: true,
    results: [{ name: "User part", isActive: true, isModified: false, isSaved: true }],
  };

  constructor(private readonly tools = requiredTools()) {}

  async connect(): Promise<FusionMcpSessionInfo> {
    this.connectCount += 1;
    return {
      protocolVersion: "2025-11-25",
      serverName: "MCP Server Adapter",
      serverVersion: "1.0.0",
      tools: this.tools,
    };
  }

  async callJson(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (toolName === "fusion_mcp_read") return this.read(args);
    if (toolName === "fusion_mcp_update") {
      this.mutated = false;
      return { success: true, message: "Undo completed successfully", canRedo: true };
    }
    if (toolName !== "fusion_mcp_execute") throw new Error(`Unexpected tool ${toolName}`);
    const object = args.object as { script: string };
    return this.execute(object.script);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  private identity() {
    return { ...IDENTITY, probeToken: this.marker };
  }

  private read(args: Record<string, unknown>): unknown {
    if (args.queryType === "apiDocumentation") {
      return { success: true, classes: [{ name: args.searchPattern }], members: [{ name: args.searchPattern }] };
    }
    if (args.queryType === "document") return this.baselineDocuments;
    if (args.queryType === "screenshot") {
      this.camera = { ...this.camera, eye: [9, 9, 9] };
      return { type: "image", mimeType: "image/png", base64Data: "cG5n" };
    }
    throw new Error(`Unexpected read ${JSON.stringify(args)}`);
  }

  private scriptResult(value: unknown) {
    return { success: true, message: `${JSON.stringify(value)}\n` };
  }

  private execute(script: string): unknown {
    if (script.includes("documents.add")) {
      const match = script.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
      if (!match) throw new Error("Probe marker not found in create script");
      this.marker = match[0];
      return this.scriptResult({
        ...this.identity(),
        documentCountBefore: 1,
        documentCountAfter: 2,
        fusionVersion: "2704.1.23",
      });
    }
    if (!script.includes(this.marker)) throw new Error("Script did not carry the disposable marker");
    if (script.includes("doc.close(False)")) {
      this.closedDocument = true;
      return this.scriptResult({ closed: true, identity: this.identity() });
    }
    if (script.includes("_ExecuteHandler")) {
      this.mutated = true;
      return this.scriptResult({ identity: this.identity(), commandId: "probe-command" });
    }
    if (script.includes("state = json.loads")) {
      this.camera = {
        eye: [1, 2, 3],
        target: [0, 0, 0],
        upVector: [0, 1, 0],
        cameraType: 0,
        perspectiveAngle: 0.5,
        viewExtents: 12,
        isFitView: false,
      };
      return this.scriptResult({ identity: this.identity() });
    }
    if (script.includes('"camera": {')) {
      return this.scriptResult({ identity: this.identity(), camera: this.camera });
    }
    if (script.includes('"fingerprint"')) {
      return this.scriptResult({
        fingerprint: {
          designType: 1,
          defaultLengthUnits: "mm",
          parameters: [],
          sketches: this.mutated ? [{ name: "probe" }] : [],
          extrudes: this.mutated ? [{ name: "probe" }] : [],
          bodies: this.mutated ? [{ name: "probe" }] : [],
        },
      });
    }
    if (script.includes('"snapshot": snapshot')) {
      return this.scriptResult({
        identity: this.identity(),
        snapshot: {
          designType: 1,
          defaultLengthUnits: "mm",
          parameters: [],
          sketches: this.mutated ? [{ name: "probe" }] : [],
          extrudes: this.mutated ? [{ name: "probe" }] : [],
          bodies: this.mutated ? [{ name: "probe", entityToken: "live-body-token" }] : [],
        },
      });
    }
    throw new Error("Unexpected probe script");
  }
}

describe("verifyRequiredToolSchemas", () => {
  it("accepts the required compatible raw surface", () => {
    expect(() => verifyRequiredToolSchemas(requiredTools())).not.toThrow();
  });

  it("fails closed when a required tool is absent", () => {
    expect(() => verifyRequiredToolSchemas(requiredTools().slice(0, 3))).toThrow(
      "Required Fusion MCP tool is missing: fusion_mcp_electronics_read",
    );
  });
});

describe("runFusionIntegrityProbe", () => {
  it("refuses before connecting without explicit disposable authority", async () => {
    const client = new FakeFusionMcp();
    const report = await runFusionIntegrityProbe(
      { endpoint: "http://127.0.0.1:27182/mcp", createDisposable: false },
      client,
    );
    expect(report.verdict).toBe("no-go");
    expect(report.safeForBroaderMutation).toBe(false);
    expect(client.connectCount).toBe(0);
  });

  it("proves the complete passing integrity path against a protocol-faithful fake", async () => {
    const client = new FakeFusionMcp();
    const report = await runFusionIntegrityProbe(
      { endpoint: "http://127.0.0.1:27182/mcp", createDisposable: true },
      client,
    );
    expect(report.failure).toBeUndefined();
    expect(report.verdict).toBe("go");
    expect(report.safeForBroaderMutation).toBe(true);
    expect(report.versions).toEqual({
      fusion: "2704.1.23",
      mcpProtocol: "2025-11-25",
      mcpServerName: "MCP Server Adapter",
      mcpServer: "1.0.0",
    });
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(report.checks.map((check) => check.id)).toEqual([
      "mcp-session",
      "raw-tool-schemas",
      "installed-api-documentation",
      "disposable-document",
      "design-eligibility",
      "single-undo-atomicity",
      "coherent-mutation",
      "manual-edit-detection",
      "entity-ambiguity-handling",
      "deliberate-immediate-verification",
      "deterministic-rollback",
      "recompute-stability",
      "exact-camera-restoration",
      "document-identity-stability",
      "unrelated-document-isolation",
    ]);
    expect(client.closedDocument).toBe(true);
    expect(client.closeCount).toBe(1);
  });

  it("stops before document creation when the discovered schema is incompatible", async () => {
    const client = new FakeFusionMcp(requiredTools().slice(0, 3));
    const report = await runFusionIntegrityProbe(
      { endpoint: "http://127.0.0.1:27182/mcp", createDisposable: true },
      client,
    );
    expect(report.verdict).toBe("no-go");
    expect(report.disposableDocument).toBeUndefined();
    expect(client.closedDocument).toBe(false);
  });
});
