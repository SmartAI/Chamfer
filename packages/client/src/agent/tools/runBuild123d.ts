import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Gate, Measurements, MeshPayload } from "@chamfer/shared";
import type { CadClient } from "@/cad/cadClient";
import { renderViewSheet } from "@/viewer/viewSheet";

const parameters = Type.Object({
  code: Type.String({
    description: "Complete build123d Python script. Must assign the finished geometry to a top-level `result` variable.",
  }),
});

async function blobToBase64(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read inspection sheet"));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Inspection sheet did not produce a data URL"));
        return;
      }
      const separator = result.indexOf(",");
      if (separator < 0) {
        reject(new Error("Inspection sheet data URL is malformed"));
        return;
      }
      resolve(result.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function gateText(gate: Gate | undefined): string {
  if (!gate) return "";
  if (gate.status === "passed") {
    return `Verify gate: PASSED (${gate.checks.length} checks).\n`;
  }
  if (gate.status === "error") {
    const detail = gate.checks.map((c) => c.detail).join("; ");
    return `Verify gate: unavailable (${detail}). Rely on the inspection sheet and measurements.\n`;
  }
  const failures = gate.checks.filter((c) => !c.passed).map((c) => `- ${c.detail}`);
  return `Verify gate: FAILED\n${failures.join("\n")}\nFix every failing check before declaring success.\n`;
}

export function createRunBuild123dTool(deps: {
  cad: CadClient;
  onSuccess: (args: {
    code: string;
    mesh: MeshPayload;
    measurements: Measurements;
    sheetPng: Blob;
  }) => Promise<void>;
}): AgentTool<typeof parameters, { measurements: Measurements }> {
  return {
    name: "run_build123d",
    label: "Run build123d",
    description:
      "Execute one complete, self-contained build123d Python script. The script must assign the finished geometry to a top-level result variable.",
    parameters,
    execute: async (_toolCallId, { code }) => {
      const { stdout, measurements, mesh, gate } = await deps.cad.run(code);
      const sheetPng = await renderViewSheet(mesh);
      await deps.onSuccess({ code, mesh, measurements, sheetPng });
      const data = await blobToBase64(sheetPng);
      const prefix = stdout ? `${stdout}\n` : "";
      return {
        content: [
          {
            type: "text",
            text: `${prefix}Measurements: ${JSON.stringify(measurements)}\n${gateText(gate)}Multi-view inspection sheet attached. Inspect every view before declaring success.`,
          },
          { type: "image", data, mimeType: "image/png" },
        ],
        details: { measurements },
      };
    },
  };
}
