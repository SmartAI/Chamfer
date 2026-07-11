import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface Position {
  x: number;
  y: number;
}

export interface DraggableOverlayProps {
  /** localStorage key the moved position persists under. */
  storageKey: string;
  /** Positioning classes used until the user moves the overlay (e.g. "right-3 top-3"). */
  defaultPositionClassName: string;
  className?: string;
  children: ReactNode;
}

function loadPosition(storageKey: string): Position | null {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Position | null;
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  } catch {
    // Corrupt storage simply falls back to the default position.
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Absolutely-positioned overlay the user can reposition by dragging any child
 * marked with `data-drag-handle`. Sits at `defaultPositionClassName` until
 * moved; afterwards the position is inline (left/top relative to the nearest
 * positioned ancestor) and persisted under `storageKey`.
 */
export function DraggableOverlay({
  storageKey,
  defaultPositionClassName,
  className,
  children,
}: DraggableOverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position | null>(() => loadPosition(storageKey));

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!(event.target as Element).closest("[data-drag-handle]")) return;
    const overlay = overlayRef.current;
    const parent = overlay?.parentElement;
    if (!overlay || !parent) return;
    event.preventDefault();

    const parentRect = parent.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const start: Position = { x: overlayRect.left - parentRect.left, y: overlayRect.top - parentRect.top };
    const origin = { x: event.clientX, y: event.clientY };
    const maxX = Math.max(0, parentRect.width - overlayRect.width);
    const maxY = Math.max(0, parentRect.height - overlayRect.height);
    let latest: Position | null = null;

    const move = (moveEvent: PointerEvent) => {
      latest = {
        x: clamp(start.x + (moveEvent.clientX - origin.x), 0, maxX),
        y: clamp(start.y + (moveEvent.clientY - origin.y), 0, maxY),
      };
      setPosition(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      if (!latest) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(latest));
      } catch {
        // The panel stays movable even when storage is unavailable.
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <div
      ref={overlayRef}
      data-testid="draggable-overlay"
      onPointerDown={startDrag}
      className={cn("absolute", position === null && defaultPositionClassName, className)}
      style={position !== null ? { left: position.x, top: position.y } : undefined}
    >
      {children}
    </div>
  );
}
