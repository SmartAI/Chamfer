import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, GripVertical, SlidersHorizontal } from "lucide-react";
import type { ParamSpec } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useAppState } from "@/state/appState";
import { useChatState } from "@/state/chatState";

/** Commits are debounced so a burst of slider releases / input edits collapses
 * into one setParams -> run round-trip. */
const COMMIT_DEBOUNCE_MS = 300;

export interface ParamsPanelProps {
  params: ParamSpec[];
  /** Called with the full current value map on every (debounced) commit. A
   * rejection is rendered as the panel's inline error. */
  onChange: (values: Record<string, number>) => Promise<void>;
}

function valuesFromSpecs(params: ParamSpec[]): Record<string, number> {
  return Object.fromEntries(params.map((p) => [p.name, p.value]));
}

function stepFor(spec: ParamSpec): number {
  return Number.isInteger(spec.value) && Number.isInteger(spec.min) && Number.isInteger(spec.max)
    ? 1
    : 0.1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sameValues(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/** Presentational panel: one slider + numeric input row per ParamSpec. All
 * CAD/persistence side effects are injected through onChange, which is what
 * the unit tests drive directly. */
export function ParamsPanel({ params, onChange }: ParamsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<Record<string, number>>(() => valuesFromSpecs(params));
  const [error, setError] = useState<string | null>(null);
  // Refs mirror the latest values/onChange so the debounce timer never
  // dispatches a stale snapshot.
  const valuesRef = useRef(values);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Last value map known to be reflected in the script; commits that would be
  // no-ops (e.g. blur without an edit) are skipped against this.
  const committedRef = useRef<Record<string, number>>(valuesFromSpecs(params));

  // params is re-parsed from the script after every successful run, so it is
  // the source of truth the local edit state resyncs from.
  useEffect(() => {
    // Except while an edit is pending commit: the re-parse that lands after a
    // successful commit must not overwrite a value the user changed during
    // that commit's flight (the debounce timer would then dispatch the reset
    // snapshot and skip it as a no-op, silently reverting the edit).
    if (timerRef.current !== null) return;
    const next = valuesFromSpecs(params);
    valuesRef.current = next;
    committedRef.current = next;
    setValues(next);
    setError(null);
  }, [params]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  function setValue(name: string, value: number): void {
    const next = { ...valuesRef.current, [name]: value };
    valuesRef.current = next;
    setValues(next);
  }

  function scheduleCommit(): void {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const snapshot = { ...valuesRef.current };
      if (sameValues(snapshot, committedRef.current)) {
        setError(null);
        return;
      }
      setError(null);
      onChangeRef.current(snapshot).then(
        () => {
          committedRef.current = snapshot;
          // Clear any inline error a slower, older commit left behind after
          // this one was dispatched. Commits settle FIFO (the CAD worker runs
          // requests in order), so a success here means the latest values are
          // good and any visible error is stale.
          setError(null);
        },
        (err: unknown) => {
          // Python (or persistence) errors stay inline in the panel; the
          // sliders remain usable so the user can just pick another value.
          setError(err instanceof Error ? err.message : String(err));
        },
      );
    }, COMMIT_DEBOUNCE_MS);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") scheduleCommit();
  }

  if (params.length === 0) return null;

  return (
    <section data-testid="params-panel" className="bg-background">
      <div className="flex items-stretch">
        <span
          data-drag-handle
          data-testid="params-drag-handle"
          title="Move panel"
          className="flex cursor-grab touch-none items-center pl-2 text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </span>
        <button
          type="button"
          data-testid="params-panel-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className="flex h-10 flex-1 items-center gap-2 px-2 text-left text-sm font-medium transition-colors hover:bg-accent"
        >
        <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
        <span>Parameters</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {params.length}
        </span>
        <ChevronDown
          className={`ml-auto h-4 w-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
        />
        </button>
      </div>
      {expanded && (
        <div className="max-h-[38vh] overflow-y-auto border-t px-3 py-1.5">
          {params.map((spec) => {
            const value = values[spec.name] ?? spec.value;
            return (
              <div
                key={spec.name}
                data-testid={`param-${spec.name}`}
                className="grid min-h-9 grid-cols-[minmax(92px,0.8fr)_minmax(100px,1.4fr)_68px] items-center gap-3 border-b border-border/60 last:border-0"
              >
              <label
                htmlFor={`param-input-${spec.name}`}
                title={spec.description || spec.name}
                className="truncate text-xs font-medium"
              >
                {spec.name}
              </label>
              <Slider
                min={spec.min}
                max={spec.max}
                step={stepFor(spec)}
                value={[value]}
                onValueChange={(next) => {
                  if (next[0] !== undefined) setValue(spec.name, next[0]);
                }}
                onValueCommit={() => scheduleCommit()}
                aria-label={spec.name}
                className="min-w-0"
              />
              <Input
                id={`param-input-${spec.name}`}
                data-testid={`param-input-${spec.name}`}
                type="number"
                min={spec.min}
                max={spec.max}
                step={stepFor(spec)}
                value={value}
                onChange={(event) => {
                  const parsed = Number(event.target.value);
                  if (Number.isFinite(parsed)) setValue(spec.name, clamp(parsed, spec.min, spec.max));
                }}
                onBlur={() => scheduleCommit()}
                onKeyDown={handleInputKeyDown}
                aria-label={`${spec.name} value`}
                className="h-7 w-full px-2 text-right text-xs tabular-nums"
              />
              </div>
            );
          })}
          {error && (
            <p
              data-testid="param-error"
              className="whitespace-pre-wrap rounded-md border border-destructive bg-destructive/10 p-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Wires the panel to the app: applies committed values via the CAD worker and
 * persists each successful edit as a new artifact version on the active
 * conversation. Lives here (not in appState) because appState knows nothing
 * about conversations and chatState nothing about params; this component is
 * the composition point. */
export function ConnectedParamsPanel() {
  const { params, applyParams } = useAppState();
  const { activeConversationId } = useChatState();

  async function handleChange(values: Record<string, number>): Promise<void> {
    await applyParams(
      values,
      activeConversationId
        ? async (code) => {
            await rest.postArtifact(activeConversationId, {
              pySource: code,
              paramsJson: JSON.stringify(values),
            });
          }
        : undefined,
    );
  }

  return <ParamsPanel params={params} onChange={handleChange} />;
}
