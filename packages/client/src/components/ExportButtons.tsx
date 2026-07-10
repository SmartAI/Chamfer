import { useState } from "react";
import { Download } from "lucide-react";
import type { ExportFormat } from "@chamfer/shared";
import { Button } from "@/components/ui/button";
import { useAppState } from "@/state/appState";

const FORMATS: Array<{ format: ExportFormat; label: string }> = [
  { format: "step", label: "STEP" },
  { format: "stl", label: "STL" },
  { format: "3mf", label: "3MF" },
  { format: "py", label: ".py" },
];

function triggerDownload(data: Uint8Array, filename: string): void {
  // Copy into a plain ArrayBuffer-backed view: BlobPart rejects the
  // Uint8Array<ArrayBufferLike> that crosses the worker boundary.
  const bytes = new Uint8Array(data);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ExportButtons() {
  const { currentScript, exportModel } = useAppState();
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleExport(format: ExportFormat): Promise<void> {
    setBusy(format);
    setError(null);
    try {
      const { data, filename } = await exportModel(format);
      triggerDownload(data, filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t bg-muted/20 px-3 py-1.5">
      <div className="flex items-center gap-1.5">
        <Download className="mr-0.5 h-3.5 w-3.5 text-muted-foreground" />
        <span className="mr-1 text-xs font-medium text-muted-foreground">Export</span>
        {FORMATS.map(({ format, label }) => (
          <Button
            key={format}
            data-testid={`export-${format}`}
            variant="outline"
            size="sm"
            disabled={currentScript === null || busy !== null}
            onClick={() => handleExport(format)}
            className="h-7 px-2.5 text-xs shadow-none"
          >
            {busy === format ? "..." : label}
          </Button>
        ))}
      </div>
      {error && (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </pre>
      )}
    </div>
  );
}
