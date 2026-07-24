import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CadCodeBlockProps {
  code: string;
  /** Whether the code body renders (the showCadCode setting). The header row
   * with Copy is always there, so hiding never costs function. */
  show: boolean;
  disabled?: boolean;
  className?: string;
}

/** The chat rendering of CAD code (python fences in assistant prose). */
export function CadCodeBlock({ code, show, disabled = false, className }: CadCodeBlockProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denial leaves the button in its idle state.
    }
  }

  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      <div className={cn("flex items-center justify-between bg-muted/40 px-2 py-1.5", show && "border-b")}>
        <span className="font-mono text-[11px] text-muted-foreground">CAD code</span>
        <button
          type="button"
          aria-label="Copy code"
          title="Copy code"
          disabled={disabled}
          onClick={() => void copy()}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
      {show && (
        <pre data-testid="cad-code" className="max-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-xs">
          {code}
        </pre>
      )}
    </div>
  );
}
