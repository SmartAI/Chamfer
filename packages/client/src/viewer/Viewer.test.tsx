import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BufferGeometry } from "three";
import { Viewer } from "./Viewer";

vi.mock("@react-three/fiber", () => ({
  Canvas: () => null,
}));

vi.mock("@react-three/drei", () => ({
  Bounds: () => null,
  GizmoHelper: () => null,
  GizmoViewcube: () => null,
  Grid: () => null,
  OrbitControls: () => null,
  OrthographicCamera: () => null,
  PerspectiveCamera: () => null,
  useBounds: () => ({ refresh: vi.fn() }),
}));

describe("Viewer controls", () => {
  it("defaults to orthographic projection and disables fit without geometry", () => {
    render(<Viewer geometry={null} />);

    expect(screen.getByTestId("viewer").getAttribute("data-projection")).toBe("orthographic");
    expect((screen.getByTestId("viewer-fit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Orthographic view" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("switches projection and keeps fit available for a model", () => {
    const geometry = {} as BufferGeometry;
    render(<Viewer geometry={geometry} />);

    expect((screen.getByTestId("viewer-fit") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Perspective view" }));

    expect(screen.getByTestId("viewer").getAttribute("data-projection")).toBe("perspective");
    expect(screen.getByRole("button", { name: "Perspective view" }).getAttribute("aria-pressed")).toBe("true");

  });

  it("shows the edge overlay by default and toggles it off", () => {
    const geometry = {} as BufferGeometry;
    render(<Viewer geometry={geometry} />);

    const toggle = screen.getByRole("button", { name: "Toggle edge lines" });
    expect(screen.getByTestId("viewer").getAttribute("data-edges")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(toggle);

    expect(screen.getByTestId("viewer").getAttribute("data-edges")).toBe("false");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });
});
