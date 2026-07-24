import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { OnlineBudgetDto } from "@chamfer/shared";
import { DemoQuotaMeter } from "./DemoQuotaMeter";

function budget(spentUsd: number, capUsd = 2): OnlineBudgetDto {
  return { spentUsd, capUsd, spentMicroUsd: spentUsd * 1e6, capMicroUsd: capUsd * 1e6 };
}

describe("DemoQuotaMeter", () => {
  it("shows remaining credit against the deployment's cap (never a hardcoded $2)", () => {
    render(<DemoQuotaMeter budget={budget(1.5, 10)} />);
    expect(screen.getByTestId("demo-quota-meter").textContent).toContain("$8.50 left of $10.00");
    expect(screen.queryByTestId("demo-quota-exhausted")).toBeNull();
  });

  it("switches to the bring-your-own-key prompt when exhausted", () => {
    const onOpenSettings = vi.fn();
    render(<DemoQuotaMeter budget={budget(2)} onOpenSettings={onOpenSettings} />);
    expect(screen.queryByTestId("demo-quota-meter")).toBeNull();
    expect(screen.getByTestId("demo-quota-exhausted")).toBeTruthy();
    fireEvent.click(screen.getByTestId("demo-quota-add-key"));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("renders nothing when the deployment reports no cap", () => {
    const { container } = render(<DemoQuotaMeter budget={budget(0, 0)} />);
    expect(container.firstChild).toBeNull();
  });
});
