import { runFusionIntegrityProbe } from "./integrityProbe";

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const endpoint = argumentValue("--endpoint") ?? process.env.CHAMFER_FUSION_MCP_ENDPOINT ?? "http://127.0.0.1:27182/mcp";
const createDisposable = process.argv.includes("--create-disposable");
const report = await runFusionIntegrityProbe({ endpoint, createDisposable });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.verdict !== "go") process.exitCode = 1;
