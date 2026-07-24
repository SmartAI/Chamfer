import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceLayout } from "./WorkspaceLayout";

describe("WorkspaceLayout", () => {
  it("hides and restores chat history", () => {
    render(<WorkspaceLayout sidebar="History" chat="Chat" viewer="Viewer" />);

    fireEvent.click(screen.getByRole("button", { name: "Hide chat history" }));
    expect(screen.getByTestId("sidebar").getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByRole("separator", { name: "Resize sidebar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show chat history" }));
    expect(screen.getByTestId("sidebar").getAttribute("aria-hidden")).toBeNull();
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeTruthy();
  });

  it("renders chat-only without a viewer column when no viewer is given", () => {
    render(<WorkspaceLayout sidebar="History" chat="Chat" />);

    expect(screen.getByTestId("chat-panel")).toBeTruthy();
    expect(screen.queryByTestId("right-panel")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize 3D panel" })).toBeNull();
  });

  describe("mobile", () => {
    const original = window.matchMedia;
    beforeEach(() => {
      window.matchMedia = ((query: string) =>
        ({
          matches: true,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = original;
    });

    it("switches between chat and 3D instead of showing them side by side", () => {
      render(<WorkspaceLayout sidebar="History" chat="Chat" viewer="Viewer" />);

      // No resizable columns on mobile; a Chat/3D toggle replaces them.
      expect(screen.queryByRole("separator", { name: "Resize 3D panel" })).toBeNull();
      expect(screen.getByTestId("mobile-history")).toBeTruthy();

      // Chat is shown first; the viewer stays mounted but hidden.
      expect(screen.getByTestId("chat-panel").classList.contains("hidden")).toBe(false);
      expect(screen.getByTestId("right-panel").classList.contains("hidden")).toBe(true);

      fireEvent.click(screen.getByTestId("mobile-tab-viewer"));
      expect(screen.getByTestId("chat-panel").classList.contains("hidden")).toBe(true);
      expect(screen.getByTestId("right-panel").classList.contains("hidden")).toBe(false);
    });

    it("opens and dismisses the history drawer", () => {
      render(<WorkspaceLayout sidebar="History" chat="Chat" viewer="Viewer" />);

      const drawer = screen.getByTestId("sidebar");
      expect(drawer.classList.contains("-translate-x-full")).toBe(true);

      fireEvent.click(screen.getByTestId("mobile-history"));
      expect(drawer.classList.contains("translate-x-0")).toBe(true);
      expect(drawer.getAttribute("aria-hidden")).toBeNull();
    });

    it("omits the 3D toggle for chat-only conversations", () => {
      render(<WorkspaceLayout sidebar="History" chat="Chat" />);

      expect(screen.queryByTestId("mobile-tab-viewer")).toBeNull();
      expect(screen.getByTestId("mobile-history")).toBeTruthy();
    });
  });
});
