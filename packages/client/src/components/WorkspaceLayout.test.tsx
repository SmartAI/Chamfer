import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
