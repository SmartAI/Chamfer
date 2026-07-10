import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/state/appState";
import { renderViewSheet } from "@/viewer/viewSheet";

function bootStatusLabel(status: ReturnType<typeof useAppState>["bootStatus"]): string {
  switch (status.phase) {
    case "downloading":
      return `Downloading: ${status.detail}`;
    case "installing":
      return `Installing: ${status.detail}`;
    case "ready":
      return "Ready";
    case "error":
      return `Error: ${status.detail}`;
  }
}

export function ScriptPanel() {
  const { bootStatus, runScript, runError, measurements, mesh } = useAppState();
  const [expanded, setExpanded] = useState(false);
  const [code, setCode] = useState("");
  const [running, setRunning] = useState(false);
  const [renderingSheet, setRenderingSheet] = useState(false);
  const [sheetUrl, setSheetUrl] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (sheetUrl) URL.revokeObjectURL(sheetUrl);
    },
    [sheetUrl],
  );

  async function handleRun(): Promise<void> {
    setRunning(true);
    try {
      await runScript(code);
    } catch {
      // runScript publishes the error through app state for the panel below.
    } finally {
      setRunning(false);
    }
  }

  async function handleViewSheet(): Promise<void> {
    if (!mesh) return;
    setRenderingSheet(true);
    try {
      const blob = await renderViewSheet(mesh);
      // Create the URL outside the state updater: StrictMode double-invokes
      // updaters, which would mint (and leak) a second object URL. The
      // useEffect cleanup above is the sole revoke path, including for the
      // previous sheet URL when this one replaces it.
      setSheetUrl(URL.createObjectURL(blob));
    } finally {
      setRenderingSheet(false);
    }
  }

  return (
    <div className="border-t">
      <button
        type="button"
        data-testid="script-panel-toggle"
        onClick={() => setExpanded((v) => !v)}
        className="flex h-9 w-full items-center justify-between px-3 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span>Script (dev)</span>
        <span className="text-xs text-muted-foreground">{expanded ? "hide" : "show"}</span>
      </button>

      {expanded && (
        <div className="flex flex-col gap-2 p-4 pt-0">
          <div
            data-testid="boot-status"
            className="rounded-md border bg-muted px-3 py-2 text-xs text-muted-foreground"
          >
            {bootStatusLabel(bootStatus)}
          </div>

          <textarea
            data-testid="script-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={8}
            className="w-full rounded-md border bg-background p-2 font-mono text-xs"
            placeholder="from build123d import *&#10;result = Box(10, 20, 30)"
          />

          <Button data-testid="script-run" onClick={handleRun} disabled={running}>
            {running ? "Running..." : "Run"}
          </Button>

          <Button
            data-testid="script-viewsheet"
            variant="outline"
            onClick={handleViewSheet}
            disabled={!mesh || renderingSheet}
          >
            {renderingSheet ? "Rendering views..." : "Render views"}
          </Button>

          {sheetUrl && (
            <img
              data-testid="view-sheet-image"
              src={sheetUrl}
              alt="Seven orthographic CAD views and overall dimensions"
              className="h-auto w-full border"
            />
          )}

          {runError && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
              {runError}
            </pre>
          )}

          <div data-testid="measurements" className="rounded-md border p-2 text-xs">
            {measurements ? (
              <ul className="space-y-1">
                <li>bbox (mm): {measurements.bboxMm.join(" x ")}</li>
                <li>volume (mm3): {measurements.volumeMm3}</li>
                <li>area (mm2): {measurements.areaMm2}</li>
                {measurements.children.length > 0 && (
                  <li>children: {JSON.stringify(measurements.children)}</li>
                )}
              </ul>
            ) : (
              <span className="text-muted-foreground">No measurements yet</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
