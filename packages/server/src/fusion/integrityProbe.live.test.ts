import { expect, it } from "vitest";
import { runFusionIntegrityProbe } from "./integrityProbe";

const liveIt = process.env.CHAMFER_LIVE_FUSION === "1" ? it : it.skip;

liveIt("passes the integrity gate against a disposable live Fusion document", async () => {
  const report = await runFusionIntegrityProbe({
    endpoint: process.env.CHAMFER_FUSION_MCP_ENDPOINT ?? "http://127.0.0.1:27182/mcp",
    createDisposable: true,
  });
  expect(report, report.failure).toMatchObject({ verdict: "go", safeForBroaderMutation: true });
});
