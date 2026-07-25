import type { ConversationDto } from "@chamfer/shared";
import { Plus, Settings, Trash2 } from "lucide-react";
import { SettingsModal } from "./SettingsModal";
import { cn } from "@/lib/utils";
import { useChatState } from "@/state/chatState";

export interface SidebarProps {
  /** Settings modal state is owned by App so the chat panel's error banner can open it too. */
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
}

type ConversationStatus = "ongoing" | "passed" | "built" | "failed" | "error" | "none";

interface ConversationStatusDot {
  status: ConversationStatus;
  /** Trailing Tailwind classes that paint the dot; a fill for a settled/active
   * state, a hollow ring for "no run yet" so it never reads as a verdict. */
  className: string;
  label: string;
}

/** Every conversation shows exactly one dot so the list reads as a single
 * consistent status column. An active headless run wins over the stale verdict;
 * then the last verify-gate result speaks (the Fusion / pre-pivot flow); then a
 * produced model turns the dot green for the build123d flow, which emits no gate
 * verdict; a conversation with nothing built yet is neutral. */
function conversationStatusDot(conversation: ConversationDto): ConversationStatusDot {
  const live = conversation.liveRun;
  if (live && (live.status === "starting" || live.status === "running")) {
    return {
      status: "ongoing",
      className: "animate-pulse bg-sky-500",
      label: `Headless run active using ${live.modelName}`,
    };
  }
  switch (conversation.lastGateStatus) {
    case "passed":
      return { status: "passed", className: "bg-emerald-500", label: "Last run verified" };
    case "failed":
      return { status: "failed", className: "bg-red-500", label: "Last run failed verification" };
    case "error":
      return { status: "error", className: "bg-amber-500", label: "Last run could not be verified" };
  }
  // No gate verdict (the build123d flow): a produced model is the success signal.
  if (conversation.hasArtifact) {
    return { status: "built", className: "bg-emerald-500", label: "Produced a model" };
  }
  return { status: "none", className: "border border-muted-foreground/50", label: "No run yet" };
}

export function Sidebar({ settingsOpen, onSettingsOpenChange }: SidebarProps) {
  const { conversations, activeConversationId, selectConversation, newConversation, removeConversation, refreshSettings } =
    useChatState();

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-3 pb-3 pt-3">
        <div className="mb-3 flex h-8 items-center gap-2 px-1">
          <img src="/brand/chamfer-mark.svg" alt="" className="h-7 w-7" />
          <span className="text-sm font-semibold">Chamfer</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => newConversation()}
            className="flex h-9 flex-1 items-center justify-center gap-2 rounded-md bg-foreground px-3 text-sm font-medium text-background transition-opacity hover:opacity-85"
          >
            <Plus className="h-4 w-4" />
            New chat
          </button>
          <button
            type="button"
            aria-label="Settings"
            onClick={() => onSettingsOpenChange(true)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border hover:bg-accent"
          >
            <Settings className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 pb-1 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Conversations</h2>
        <span className="text-[10px] tabular-nums text-muted-foreground">{conversations.length}</span>
      </div>
      {conversations.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          No conversations yet
        </div>
      ) : (
        <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {conversations.map((conversation) => {
            const active = conversation.id === activeConversationId;
            const dot = conversationStatusDot(conversation);
            return (
              <li key={conversation.id}>
                <div
                  className={cn(
                    "group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent",
                    active && "bg-background font-medium shadow-sm ring-1 ring-border",
                  )}
                >
                  <span
                    data-testid="convo-status-dot"
                    data-status={dot.status}
                    role="img"
                    aria-label={dot.label}
                    title={dot.label}
                    className={cn("h-2 w-2 shrink-0 rounded-full", dot.className)}
                  />
                  <button
                    type="button"
                    data-conversation-id={conversation.id}
                    onClick={() => selectConversation(conversation.id)}
                    aria-current={active ? "true" : undefined}
                    className="min-w-0 flex-1 truncate text-left"
                  >
                    {conversation.title}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${conversation.title}`}
                    onClick={() => void removeConversation(conversation.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 hover:bg-destructive/10 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SettingsModal
        open={settingsOpen}
        onOpenChange={onSettingsOpenChange}
        onSaved={() => void refreshSettings()}
      />
    </div>
  );
}
