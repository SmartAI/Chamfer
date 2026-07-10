import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("renders the three zones", () => {
    render(<App />);
    expect(screen.getByTestId("sidebar")).toBeTruthy();
    expect(screen.getByTestId("chat-panel")).toBeTruthy();
    expect(screen.getByTestId("right-panel")).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeTruthy();
    expect(screen.getByRole("separator", { name: "Resize 3D panel" })).toBeTruthy();
  });
});
