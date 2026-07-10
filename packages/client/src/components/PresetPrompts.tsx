import { PRESET_PROMPTS } from "@/presets";

const DIFFICULTY_LABEL: Record<(typeof PRESET_PROMPTS)[number]["id"], string> = {
  easy: "Easy",
  intermediate: "Intermediate",
  hard: "Hard",
};

export interface PresetPromptsProps {
  disabled: boolean;
  disabledHint?: string;
  onSelect: (prompt: string) => void;
}

/** Three verified example prompts rendered on the empty chat states; clicking one starts a
 * generation immediately through the normal send flow. */
export function PresetPrompts({ disabled, disabledHint, onSelect }: PresetPromptsProps) {
  return (
    <div data-testid="preset-prompts" className="flex w-full max-w-3xl flex-col gap-2 px-4">
      <p className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Try an example
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        {PRESET_PROMPTS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid={`preset-${preset.id}`}
            disabled={disabled}
            onClick={() => onSelect(preset.prompt)}
            className="flex flex-col gap-1 rounded-lg border bg-background p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-background"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{preset.label}</span>
              <span className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {DIFFICULTY_LABEL[preset.id]}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">{preset.description}</span>
            <span className="line-clamp-3 text-xs text-muted-foreground/80">{preset.prompt}</span>
          </button>
        ))}
      </div>
      {disabled && disabledHint && (
        <p data-testid="preset-disabled-hint" className="text-center text-xs text-muted-foreground">
          {disabledHint}
        </p>
      )}
    </div>
  );
}
