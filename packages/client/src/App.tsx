import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { RightPanel } from "./components/RightPanel";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { ChatProvider, useChatState } from "./state/chatState";
import { AppStateProvider } from "./state/appState";
import { FusionReadinessProvider } from "./state/fusionReadiness";

/** Fusion conversations are chat-only: the native Fusion canvas is the
 * authoritative 3D view, so no right panel renders at all. */
function Workspace({ settingsOpen, onSettingsOpenChange, onOpenSettings }: {
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onOpenSettings: () => void;
}) {
  const { activeConversationId, conversations } = useChatState();
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const chatOnly = activeConversation?.cadEnvironment === "fusion";
  return (
    <WorkspaceLayout
      sidebar={<Sidebar settingsOpen={settingsOpen} onSettingsOpenChange={onSettingsOpenChange} />}
      chat={<ChatPanel onOpenSettings={onOpenSettings} />}
      {...(chatOnly ? {} : { viewer: <RightPanel /> })}
    />
  );
}

export default function App() {
  // Settings modal state lives here (not in Sidebar) so the chat panel's invalid-key
  // error banner can open the same modal the Sidebar gear button does.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = useCallback(() => setSettingsOpen(true), []);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => console.log("health check:", data))
      .catch((err) => console.error("health check failed:", err));
  }, []);

  return (
    <AppStateProvider>
      <FusionReadinessProvider>
        <ChatProvider>
          <Workspace
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
            onOpenSettings={openSettings}
          />
        </ChatProvider>
      </FusionReadinessProvider>
    </AppStateProvider>
  );
}
