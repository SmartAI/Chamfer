import type { CadEnvironment, FusionReadinessDto, SettingsResponseDto } from "@chamfer/shared";
import { Box, PanelsTopLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { FusionReadinessBadge } from "./FusionReadinessBadge";

interface CadEnvironmentDialogProps {
  open: boolean;
  value: CadEnvironment;
  creating: boolean;
  error?: string;
  onValueChange: (environment: CadEnvironment) => void;
  onConfirm: () => void;
  onCancel: () => void;
  fusionEnabled: boolean;
  fusionReadiness?: FusionReadinessDto;
  fusionIntegrity?: SettingsResponseDto["fusionIntegrity"];
}

const OPTIONS: Array<{
  value: CadEnvironment;
  label: string;
  description: string;
  icon: typeof Box;
  badge?: string;
}> = [
  {
    value: "build123d",
    label: "Local build123d",
    description: "Build with build123d on a real CAD kernel, then view and export the result here.",
    icon: Box,
  },
  {
    value: "fusion",
    label: "Autodesk Fusion",
    description: "Bind this conversation to the authoritative design in Autodesk Fusion.",
    icon: PanelsTopLeft,
    badge: "Experimental",
  },
];

export function CadEnvironmentDialog({
  open,
  value,
  creating,
  error,
  onValueChange,
  onConfirm,
  onCancel,
  fusionEnabled,
  fusionReadiness,
  fusionIntegrity,
}: CadEnvironmentDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !creating && onCancel()}>
      <DialogContent className="max-w-xl" onEscapeKeyDown={(event) => creating && event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Choose a CAD environment</DialogTitle>
          <DialogDescription>
            This choice is permanent for the conversation and determines which CAD tools the agent can use.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="grid gap-3" disabled={creating}>
          <legend className="sr-only">CAD environment</legend>
          {OPTIONS.filter((option) => option.value !== "fusion" || fusionEnabled).map((option) => {
            const Icon = option.icon;
            const selected = value === option.value;
            return (
              <label
                key={option.value}
                className={cn(
                  "flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors",
                  "hover:border-foreground/30 hover:bg-accent/40",
                  selected && "border-foreground bg-accent/60 ring-1 ring-foreground",
                )}
              >
                <input
                  type="radio"
                  name="cad-environment"
                  value={option.value}
                  checked={selected}
                  onChange={() => onValueChange(option.value)}
                  className="mt-1 h-4 w-4 accent-foreground"
                />
                <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-medium">
                    {option.label}
                    {option.badge && (
                      <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {option.badge}
                      </span>
                    )}
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                    {option.description}
                  </span>
                  {option.value === "fusion" && (
                    <>
                      <FusionReadinessBadge readiness={fusionReadiness} showDiagnosis className="mt-2 text-xs" />
                      {fusionIntegrity && (
                        <span className="mt-2 block text-xs text-muted-foreground">
                          <span className="font-medium">Integrity gate: {fusionIntegrity.verdict}</span>
                          {fusionIntegrity.limitations.length > 0 && (
                            <span className="mt-1 block">{fusionIntegrity.limitations.join(" ")}</span>
                          )}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={creating} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={creating} onClick={onConfirm}>
            {creating ? "Creating..." : "Start conversation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
