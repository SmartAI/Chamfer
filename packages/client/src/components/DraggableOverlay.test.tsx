import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraggableOverlay } from "./DraggableOverlay";

/** This jsdom has no PointerEvent, and fireEvent's fallback drops clientX/Y.
 * MouseEvent dispatched under the pointer-event type name carries coordinates
 * and still reaches both React's onPointerDown and window listeners. */
function firePointer(target: EventTarget, type: string, coords: { clientX: number; clientY: number }) {
  act(() => {
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true, ...coords }));
  });
}

const STORAGE_KEY = "chamfer.test-overlay-pos";

function renderOverlay() {
  const utils = render(
    <div style={{ position: "relative" }}>
      <DraggableOverlay storageKey={STORAGE_KEY} defaultPositionClassName="right-3 top-3">
        <div>
          <span data-drag-handle data-testid="grip">
            grip
          </span>
          <p>panel body</p>
        </div>
      </DraggableOverlay>
    </div>,
  );
  const overlay = screen.getByTestId("draggable-overlay");
  const parent = overlay.parentElement as HTMLElement;
  // jsdom has no layout: give the parent and overlay real-looking boxes.
  vi.spyOn(parent, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
    toJSON: () => ({}),
  } as DOMRect);
  vi.spyOn(overlay, "getBoundingClientRect").mockReturnValue({
    x: 420, y: 12, left: 420, top: 12, right: 780, bottom: 212, width: 360, height: 200,
    toJSON: () => ({}),
  } as DOMRect);
  return { ...utils, overlay };
}

describe("DraggableOverlay", () => {
  beforeEach(() => window.localStorage.removeItem(STORAGE_KEY));
  afterEach(() => vi.restoreAllMocks());

  it("uses the default position classes until the user moves it", () => {
    const { overlay } = renderOverlay();
    expect(overlay.className).toContain("right-3");
    expect(overlay.style.left).toBe("");
  });

  it("dragging by the handle moves the overlay and persists the position", () => {
    const { overlay } = renderOverlay();
    const grip = screen.getByTestId("grip");

    firePointer(grip, "pointerdown", { clientX: 500, clientY: 20 });
    firePointer(window, "pointermove", { clientX: 450, clientY: 120 });
    firePointer(window, "pointerup", { clientX: 0, clientY: 0 });

    // Started at (420, 12), moved by (-50, +100).
    expect(overlay.style.left).toBe("370px");
    expect(overlay.style.top).toBe("112px");
    expect(overlay.className).not.toContain("right-3");
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({ x: 370, y: 112 });
  });

  it("clamps the drag inside the parent container", () => {
    const { overlay } = renderOverlay();
    const grip = screen.getByTestId("grip");

    firePointer(grip, "pointerdown", { clientX: 500, clientY: 20 });
    firePointer(window, "pointermove", { clientX: -2000, clientY: 5000 });
    firePointer(window, "pointerup", { clientX: 0, clientY: 0 });

    expect(overlay.style.left).toBe("0px");
    // parent height 600 - overlay height 200 = 400.
    expect(overlay.style.top).toBe("400px");
  });

  it("does not start a drag from the panel body", () => {
    const { overlay } = renderOverlay();

    firePointer(screen.getByText("panel body"), "pointerdown", { clientX: 500, clientY: 20 });
    firePointer(window, "pointermove", { clientX: 450, clientY: 120 });
    firePointer(window, "pointerup", { clientX: 0, clientY: 0 });

    expect(overlay.style.left).toBe("");
    expect(overlay.className).toContain("right-3");
  });

  it("restores a persisted position on mount", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: 40, y: 60 }));
    const { overlay } = renderOverlay();

    expect(overlay.style.left).toBe("40px");
    expect(overlay.style.top).toBe("60px");
    expect(overlay.className).not.toContain("right-3");
  });
});
