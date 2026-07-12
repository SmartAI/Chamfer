import { cn } from "@/lib/utils";
import { CadCodeActions } from "./CadCodeActions";

interface CadCodeBlockProps {
  code: string;
  /** Whether the code body renders (the showCadCode setting). The header row
   * with Copy / Render 3D is always there, so hiding never costs function. */
  show: boolean;
  disabled?: boolean;
  className?: string;
}

/** The chat rendering of CAD code, shared by the run_build123d tool card and
 * python fences in assistant prose. */
export function CadCodeBlock({ code, show, disabled = false, className }: CadCodeBlockProps) {
  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      <div className={cn("flex items-center justify-between bg-muted/40 px-2 py-1.5", show && "border-b")}>
        <span className="font-mono text-[11px] text-muted-foreground">CAD code</span>
        <CadCodeActions code={code} disabled={disabled} />
      </div>
      {show && (
        <pre data-testid="cad-code" className="max-h-72 overflow-auto whitespace-pre-wrap p-2 font-mono text-xs">
          {code}
        </pre>
      )}
    </div>
  );
}
