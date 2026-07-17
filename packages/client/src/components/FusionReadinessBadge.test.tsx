import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { FusionReadinessDto } from "@chamfer/shared";
import { FusionReadinessBadge } from "./FusionReadinessBadge";

const readiness: FusionReadinessDto = {
  state: "degraded",
  label: "Degraded",
  diagnosis: "A required integrity capability is unavailable; modeling remains blocked.",
  endpoint: "http://127.0.0.1:27182/mcp",
  checkedAt: "2026-07-14T12:00:00.000Z",
  mutationAllowed: false,
};

describe("FusionReadinessBadge", () => {
  it("shows the normalized state and concise diagnosis", () => {
    render(<FusionReadinessBadge readiness={readiness} showDiagnosis />);
    expect(screen.getByText("Degraded")).toBeTruthy();
    expect(screen.getByText(readiness.diagnosis)).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("data-state")).toBe("degraded");
  });
});
