import { useState } from "react";
import { Box, Check, Copy, LoaderCircle } from "lucide-react";
import { useOptionalAppState } from "@/state/appState";

interface CadCodeActionsProps {
  code: string;
  disabled?: boolean;
}

export function CadCodeActions({ code, disabled = false }: CadCodeActionsProps) {
  const appState = useOptionalAppState();
  const [copied, setCopied] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [failed, setFailed] = useState(false);

  async function copyCode(): Promise<void> {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  async function renderCode(): Promise<void> {
    if (!appState) return;
    setRendering(true);
    setFailed(false);
    try {
      await appState.runScript(code);
    } catch {
      setFailed(true);
    } finally {
      setRendering(false);
    }
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="Copy code"
        title="Copy code"
        onClick={() => void copyCode()}
        className="flex h-7 items-center gap-1.5 rounded border bg-background px-2 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <button
        type="button"
        data-testid="render-code"
        disabled={disabled || rendering || appState?.isRendering || !appState?.cad || code.trim().length === 0}
        onClick={() => void renderCode()}
        className="flex h-7 items-center gap-1.5 rounded bg-foreground px-2 text-[11px] font-medium text-background hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {rendering ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Box className="h-3.5 w-3.5" />}
        {rendering ? "Rendering" : failed ? "Failed" : "Render 3D"}
      </button>
    </div>
  );
}
