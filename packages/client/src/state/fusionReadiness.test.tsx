import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FusionReadinessDto, SettingsResponseDto } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { FusionReadinessProvider, useFusionReadiness } from "./fusionReadiness";

vi.mock("@/api/rest");
const mockedRest = vi.mocked(rest);

const settings: SettingsResponseDto = {
  sources: {}, experimentalFusionEnabled: true, fusionEnabled: true,
  fusionIntegrity: { access: "experimental", verdict: "no-go", limitations: ["Test fixture"] },
};
const ready: FusionReadinessDto = {
  state: "ready",
  label: "Ready",
  diagnosis: "Connected",
  endpoint: "http://127.0.0.1:27182/mcp",
  checkedAt: "2026-07-14T12:00:00.000Z",
  mutationAllowed: false,
};

function State() {
  return <span>{useFusionReadiness().readiness?.state ?? "checking"}</span>;
}

describe("FusionReadinessProvider", () => {
  beforeEach(() => vi.resetAllMocks());

  it("replaces a ready snapshot with unavailable when the readiness API stops responding", async () => {
    mockedRest.getSettings.mockResolvedValue(settings);
    mockedRest.getFusionReadiness.mockResolvedValueOnce(ready).mockRejectedValue(new Error("offline"));
    render(<FusionReadinessProvider __pollIntervalMs={10}><State /></FusionReadinessProvider>);

    expect(await screen.findByText("ready")).toBeTruthy();
    expect(await screen.findByText("unavailable", {}, { timeout: 1_000 })).toBeTruthy();
  });
});
