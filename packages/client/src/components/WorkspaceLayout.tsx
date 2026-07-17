import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const MIN_SIDEBAR_WIDTH = 180;
const MIN_CHAT_WIDTH = 320;
const MIN_VIEWER_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 256;
const DEFAULT_VIEWER_WIDTH = 560;
const STORAGE_KEY = "chamfer.workspace-layout.v1";

interface WorkspaceLayoutProps {
  sidebar: ReactNode;
  chat: ReactNode;
  /** Omit for chat-only workspaces (Fusion conversations render no right panel). */
  viewer?: ReactNode;
}

interface LayoutWidths {
  sidebar: number;
  viewer: number;
  sidebarCollapsed: boolean;
}

function loadWidths(): LayoutWidths {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<LayoutWidths> | null;
    return {
      sidebar: Math.max(MIN_SIDEBAR_WIDTH, saved?.sidebar ?? DEFAULT_SIDEBAR_WIDTH),
      viewer: Math.max(MIN_VIEWER_WIDTH, saved?.viewer ?? DEFAULT_VIEWER_WIDTH),
      sidebarCollapsed: saved?.sidebarCollapsed ?? false,
    };
  } catch {
    return { sidebar: DEFAULT_SIDEBAR_WIDTH, viewer: DEFAULT_VIEWER_WIDTH, sidebarCollapsed: false };
  }
}

export function WorkspaceLayout({ sidebar, chat, viewer }: WorkspaceLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState(loadWidths);

  useEffect(() => {
    try {
      localStorage?.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Layout resizing remains functional when storage is unavailable.
    }
  }, [widths]);

  const clampWidths = useCallback((next: LayoutWidths): LayoutWidths => {
    const available = containerRef.current?.clientWidth ?? window.innerWidth;
    const sidebarMax = Math.max(MIN_SIDEBAR_WIDTH, available - MIN_CHAT_WIDTH - MIN_VIEWER_WIDTH - 8);
    const sidebar = Math.min(Math.max(next.sidebar, MIN_SIDEBAR_WIDTH), sidebarMax);
    const viewerMax = Math.max(MIN_VIEWER_WIDTH, available - MIN_CHAT_WIDTH - sidebar - 8);
    return {
      sidebar,
      viewer: Math.min(Math.max(next.viewer, MIN_VIEWER_WIDTH), viewerMax),
      sidebarCollapsed: next.sidebarCollapsed,
    };
  }, []);

  function startDrag(side: "sidebar" | "viewer", event: React.PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidths = widths;

    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setWidths(clampWidths({
        sidebar: side === "sidebar" ? startWidths.sidebar + delta : startWidths.sidebar,
        viewer: side === "viewer" ? startWidths.viewer - delta : startWidths.viewer,
        sidebarCollapsed: startWidths.sidebarCollapsed,
      }));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function adjustWithKeyboard(side: "sidebar" | "viewer", event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 16 : -16;
    setWidths((current) => clampWidths({
      sidebar: side === "sidebar" ? current.sidebar + delta : current.sidebar,
      viewer: side === "viewer" ? current.viewer - delta : current.viewer,
      sidebarCollapsed: current.sidebarCollapsed,
    }));
  }

  const separator = (side: "sidebar" | "viewer", label: string) => (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={(event) => startDrag(side, event)}
      onKeyDown={(event) => adjustWithKeyboard(side, event)}
      className="group relative z-10 cursor-col-resize touch-none bg-border outline-none focus-visible:bg-ring"
    >
      <div className="absolute inset-y-0 left-1/2 w-3 -translate-x-1/2 group-hover:bg-foreground/10" />
    </div>
  );

  const hasViewer = viewer !== undefined && viewer !== null;
  const viewerColumns = hasViewer ? ` 4px ${widths.viewer}px` : "";
  return (
    <div
      ref={containerRef}
      className="relative grid h-screen overflow-hidden bg-background text-foreground"
      style={{
        gridTemplateColumns: widths.sidebarCollapsed
          ? `0 0 minmax(${MIN_CHAT_WIDTH}px, 1fr)${viewerColumns}`
          : `${widths.sidebar}px 4px minmax(${MIN_CHAT_WIDTH}px, 1fr)${viewerColumns}`,
      }}
    >
      <aside
        data-testid="sidebar"
        aria-hidden={widths.sidebarCollapsed || undefined}
        className="min-w-0 overflow-hidden bg-muted/30"
      >
        {sidebar}
      </aside>
      {widths.sidebarCollapsed ? <div /> : separator("sidebar", "Resize sidebar")}
      <button
        type="button"
        data-testid="sidebar-collapse"
        aria-label={widths.sidebarCollapsed ? "Show chat history" : "Hide chat history"}
        title={widths.sidebarCollapsed ? "Show chat history" : "Hide chat history"}
        onClick={() => setWidths((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}
        className="absolute top-2 z-30 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ left: widths.sidebarCollapsed ? 12 : widths.sidebar + 12 }}
      >
        {widths.sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
      </button>
      <main data-testid="chat-panel" className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        {chat}
      </main>
      {hasViewer && separator("viewer", "Resize 3D panel")}
      {hasViewer && (
        <aside data-testid="right-panel" className="min-w-0 overflow-hidden">
          {viewer}
        </aside>
      )}
    </div>
  );
}
