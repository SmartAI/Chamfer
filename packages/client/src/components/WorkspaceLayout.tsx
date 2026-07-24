import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Box, Menu, MessageSquare, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_SIDEBAR_WIDTH = 180;
const MIN_CHAT_WIDTH = 320;
const MIN_VIEWER_WIDTH = 360;
const DEFAULT_SIDEBAR_WIDTH = 256;
const DEFAULT_VIEWER_WIDTH = 560;
const STORAGE_KEY = "chamfer.workspace-layout.v1";

// Below Tailwind's `md` breakpoint the three-column desktop grid can no longer
// fit side by side (sidebar + chat + viewer demand ~900px), so the layout
// switches to a single full-screen panel with a history drawer and a Chat/3D
// toggle. Kept in sync with the `md:` utilities used here.
const MOBILE_QUERY = "(max-width: 767px)";

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

/** Tracks the mobile breakpoint. Defaults to desktop when `matchMedia` is
 * unavailable (SSR, older jsdom), so the resizable grid stays the default. */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(MOBILE_QUERY).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

export function WorkspaceLayout({ sidebar, chat, viewer }: WorkspaceLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState(loadWidths);
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"chat" | "viewer">("chat");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const hasViewer = viewer !== undefined && viewer !== null;

  useEffect(() => {
    try {
      localStorage?.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {
      // Layout resizing remains functional when storage is unavailable.
    }
  }, [widths]);

  // Leaving the mobile breakpoint dismisses the overlay drawer; a chat-only
  // (Fusion) conversation has no viewer to switch to, so fall back to chat.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);
  useEffect(() => {
    if (!hasViewer) setMobileView("chat");
  }, [hasViewer]);

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

  if (isMobile) {
    const showViewer = hasViewer && mobileView === "viewer";
    const tabClass = (active: boolean) =>
      cn(
        "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
      );
    return (
      <div className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground">
        {/* History as an overlay drawer: it slides over the panel rather than
            claiming a column there is no room for. */}
        <div
          aria-hidden="true"
          onClick={() => setDrawerOpen(false)}
          className={cn(
            "fixed inset-0 z-40 bg-black/40 transition-opacity duration-200",
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        />
        <aside
          data-testid="sidebar"
          aria-hidden={!drawerOpen || undefined}
          onClick={(event) => {
            // Picking a conversation (or New chat) should reveal it, so close
            // the drawer once the tap lands on an actionable control.
            if ((event.target as HTMLElement).closest("button, a")) setDrawerOpen(false);
          }}
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-[84vw] max-w-xs overflow-hidden bg-background shadow-xl transition-transform duration-200",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {sidebar}
        </aside>

        {/* Both panels stay mounted; the inactive one is hidden so the viewer
            keeps its WebGL context and the chat keeps its scroll position. */}
        <main
          data-testid="chat-panel"
          className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden", showViewer && "hidden")}
        >
          {chat}
        </main>
        {hasViewer && (
          <aside
            data-testid="right-panel"
            className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", !showViewer && "hidden")}
          >
            {viewer}
          </aside>
        )}

        <nav className="flex shrink-0 items-center justify-between gap-2 border-t bg-background px-3 py-1.5">
          <button
            type="button"
            data-testid="mobile-history"
            aria-label="Show chat history"
            onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Menu className="h-4 w-4" />
            History
          </button>
          {hasViewer && (
            <div role="tablist" aria-label="Switch panel" className="flex items-center gap-1 rounded-lg bg-muted p-0.5">
              <button
                type="button"
                role="tab"
                aria-selected={!showViewer}
                data-testid="mobile-tab-chat"
                onClick={() => setMobileView("chat")}
                className={tabClass(!showViewer)}
              >
                <MessageSquare className="h-4 w-4" />
                Chat
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={showViewer}
                data-testid="mobile-tab-viewer"
                onClick={() => setMobileView("viewer")}
                className={tabClass(showViewer)}
              >
                <Box className="h-4 w-4" />
                3D
              </button>
            </div>
          )}
        </nav>
      </div>
    );
  }

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
