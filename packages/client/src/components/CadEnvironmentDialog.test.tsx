import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CadEnvironmentDialog } from "./CadEnvironmentDialog";

describe("CadEnvironmentDialog", () => {
  it("does not expose Autodesk Fusion without the experimental flag", () => {
    render(<CadEnvironmentDialog open value="build123d" creating={false} fusionEnabled={false} onValueChange={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByRole("radio", { name: /Autodesk Fusion/ })).toBeNull();
  });

  it("shows controlled testers the current integrity verdict and limitations", () => {
    render(<CadEnvironmentDialog open value="build123d" creating={false} fusionEnabled fusionIntegrity={{
      access: "experimental", verdict: "no-go",
      limitations: ["Live Fusion coverage has not passed."],
    }} onValueChange={() => undefined} onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText(/Integrity gate: no-go/i)).toBeTruthy();
    expect(screen.getByText(/Live Fusion coverage has not passed/i)).toBeTruthy();
  });
});
