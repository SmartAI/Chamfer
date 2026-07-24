import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BufferGeometry } from "three";
import { Viewer } from "./Viewer";

/** jsdom's Blob has no arrayBuffer(); FileReader is the portable read. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to perspective projection and disables fit without geometry", () => {
    render(<Viewer geometry={null} />);

    expect(screen.getByTestId("viewer").getAttribute("data-projection")).toBe("perspective");
    expect((screen.getByTestId("viewer-fit") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Perspective view" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("switches projection and keeps fit available for a model", () => {
    const geometry = {} as BufferGeometry;
    render(<Viewer geometry={geometry} />);

    expect((screen.getByTestId("viewer-fit") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Orthographic view" }));

    expect(screen.getByTestId("viewer").getAttribute("data-projection")).toBe("orthographic");
    expect(screen.getByRole("button", { name: "Orthographic view" }).getAttribute("aria-pressed")).toBe("true");

  });

  it("starts with auto-rotate off and toggles it on", () => {
    const geometry = {} as BufferGeometry;
    render(<Viewer geometry={geometry} />);

    const toggle = screen.getByRole("button", { name: "Toggle auto-rotate" });
    expect(screen.getByTestId("viewer").getAttribute("data-auto-rotate")).toBe("false");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(toggle);

    expect(screen.getByTestId("viewer").getAttribute("data-auto-rotate")).toBe("true");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a speed slider only while auto-rotate is on, and adjusts the speed", () => {
    const geometry = {} as BufferGeometry;
    render(<Viewer geometry={geometry} />);

    expect(screen.queryByTestId("auto-rotate-speed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle auto-rotate" }));

    const speedChip = screen.getByTestId("auto-rotate-speed");
    const slider = within(speedChip).getByRole("slider");
    expect(screen.getByTestId("viewer").getAttribute("data-auto-rotate-speed")).toBe("2.5");

    fireEvent.keyDown(slider, { key: "End" });
    expect(screen.getByTestId("viewer").getAttribute("data-auto-rotate-speed")).toBe("10");

    fireEvent.click(screen.getByRole("button", { name: "Toggle auto-rotate" }));
    expect(screen.queryByTestId("auto-rotate-speed")).toBeNull();
  });

  it("disables export until an artifact is loaded", () => {
    render(<Viewer geometry={{} as BufferGeometry} />);

    expect((screen.getByTestId("viewer-export") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("viewer-export-menu")).toBeNull();
  });

  it("opens the export menu listing all formats", () => {
    render(<Viewer geometry={{} as BufferGeometry} artifactData={new ArrayBuffer(4)} />);

    fireEvent.click(screen.getByTestId("viewer-export"));

    const menu = screen.getByTestId("viewer-export-menu");
    expect(within(menu).getByTestId("viewer-export-stl")).toBeTruthy();
    expect(within(menu).getByTestId("viewer-export-obj")).toBeTruthy();
    expect(within(menu).getByTestId("viewer-export-glb")).toBeTruthy();
  });

  it("downloads the exact artifact bytes as STL under the export name", async () => {
    const downloads: string[] = [];
    const blobs: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return "blob:test";
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });

    render(
      <Viewer
        geometry={{} as BufferGeometry}
        artifactData={new Uint8Array([1, 2, 3]).buffer}
        exportName="cylindrical-spacer"
      />,
    );
    fireEvent.click(screen.getByTestId("viewer-export"));
    fireEvent.click(screen.getByTestId("viewer-export-stl"));

    await waitFor(() => expect(downloads).toEqual(["cylindrical-spacer.stl"]));
    expect(blobs[0]!.type).toBe("model/stl");
    expect(await blobBytes(blobs[0]!)).toEqual(new Uint8Array([1, 2, 3]));
    // A finished export closes the menu.
    expect(screen.queryByTestId("viewer-export-menu")).toBeNull();
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
