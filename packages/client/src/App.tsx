import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ChatPanel } from "./components/ChatPanel";
import { RightPanel } from "./components/RightPanel";
import { WorkspaceLayout } from "./components/WorkspaceLayout";
import { ChatProvider } from "./state/chatState";
import { AppStateProvider } from "./state/appState";

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
      <ChatProvider>
        <WorkspaceLayout
          sidebar={<Sidebar settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen} />}
          chat={<ChatPanel onOpenSettings={openSettings} />}
          viewer={<RightPanel />}
        />
      </ChatProvider>
    </AppStateProvider>
  );
}
