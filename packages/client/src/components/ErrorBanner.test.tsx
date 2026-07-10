import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "./ErrorBanner";

describe("ErrorBanner", () => {
  it("renders the settings hint and an Open Settings action for invalid-key errors", () => {
    const onOpenSettings = vi.fn();
    render(
      <ErrorBanner
        error={{ kind: "invalid-key", message: "Proxy error: 401 invalid x-api-key" }}
        onOpenSettings={onOpenSettings}
      />,
    );

    const banner = screen.getByTestId("error-banner");
    expect(banner.textContent).toContain("Check your API key in Settings");

    fireEvent.click(screen.getByTestId("error-open-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("renders the message and a Retry action for rate-limited errors", () => {
    const onRetry = vi.fn();
    render(
      <ErrorBanner error={{ kind: "rate-limited", message: "429 rate limit exceeded" }} onRetry={onRetry} />,
    );

    expect(screen.getByTestId("error-banner").textContent).toContain("429 rate limit exceeded");

    fireEvent.click(screen.getByTestId("error-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders only the message text for generic errors", () => {
    render(<ErrorBanner error={{ kind: "generic", message: "persist-failed: db unreachable" }} />);

    expect(screen.getByTestId("error-banner").textContent).toContain("persist-failed: db unreachable");
    expect(screen.queryByTestId("error-open-settings")).toBeNull();
    expect(screen.queryByTestId("error-retry")).toBeNull();
  });

  it("omits actions when no callbacks are provided", () => {
    render(<ErrorBanner error={{ kind: "invalid-key", message: "401" }} />);
    expect(screen.queryByTestId("error-open-settings")).toBeNull();

    render(<ErrorBanner error={{ kind: "rate-limited", message: "429" }} />);
    expect(screen.queryByTestId("error-retry")).toBeNull();
  });
});
