import { Plus, Settings, Trash2 } from "lucide-react";
import { SettingsModal } from "./SettingsModal";
import { cn } from "@/lib/utils";
import { useChatState } from "@/state/chatState";

export interface SidebarProps {
  /** Settings modal state is owned by App so the chat panel's error banner can open it too. */
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
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
      {conversations.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          No conversations yet
        </div>
      ) : (
        <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {conversations.map((conversation) => {
            const active = conversation.id === activeConversationId;
            return (
              <li key={conversation.id}>
                <div
                  className={cn(
                    "group flex items-center gap-1 rounded-md px-2 py-2 text-sm transition-colors hover:bg-accent",
                    active && "bg-background font-medium shadow-sm ring-1 ring-border",
                  )}
                >
                  {conversation.lastGateStatus && (
                    <span
                      data-testid="convo-gate-dot"
                      data-status={conversation.lastGateStatus}
                      aria-label={
                        conversation.lastGateStatus === "passed"
                          ? "Last run verified"
                          : "Last run not verified"
                      }
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        conversation.lastGateStatus === "passed" ? "bg-emerald-500" : "bg-red-500",
                      )}
                    />
                  )}
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
