import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ConversationDto } from "@chamfer/shared";
import { ChatPanel } from "./ChatPanel";
import { ChatContext, type ChatContextValue } from "@/state/chatState";
import { EMPTY_SESSION_STATE } from "@/state/agentEventFold";

const conversation: ConversationDto = {
  id: "c1",
  title: "Bracket",
  cadEnvironment: "build123d",
  createdAt: 0,
  updatedAt: 0,
};

function contextValue(overrides: Partial<ChatContextValue>): ChatContextValue {
  return {
    conversations: [conversation],
    activeConversationId: conversation.id,
    sessionState: EMPTY_SESSION_STATE,
    settingsPresent: true,
    agentHostingOffline: false,
    loading: false,
    error: null,
    clearError: vi.fn(),
    selectConversation: vi.fn(),
    newConversation: vi.fn(),
    removeConversation: vi.fn(async () => {}),
    refreshSettings: vi.fn(async () => {}),
    sendMessage: vi.fn(),
    stopAgent: vi.fn(),
    resumeAfterFusionReconciliation: vi.fn(),
    modelName: "Test Model",
    missingProviderKey: null,
    showCadCode: false,
    demoBudget: null,
    ...overrides,
  };
}

function renderPanel(overrides: Partial<ChatContextValue>) {
  return render(
    <ChatContext.Provider value={contextValue(overrides)}>
      <ChatPanel />
    </ChatContext.Provider>,
  );
}

// The deployed Worker cannot host agent turns after the pi pivot; when it
// declares agentHosting:false, users must see a notice and a disabled composer
// instead of prompts that die as /api/agent 404s.
describe("ChatPanel agent-hosting gate", () => {
  it("shows the offline notice and disables the composer when hosting is off", () => {
    renderPanel({ agentHostingOffline: true });
    expect(screen.getByTestId("agent-offline-banner")).toBeTruthy();
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows the notice even before any conversation is selected", () => {
    renderPanel({ agentHostingOffline: true, activeConversationId: undefined });
    expect(screen.getByTestId("agent-offline-banner")).toBeTruthy();
  });

  it("stays out of the way on deployments that host the agent", () => {
    renderPanel({ agentHostingOffline: false });
    expect(screen.queryByTestId("agent-offline-banner")).toBeNull();
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false);
  });
});

// Issue #53 defect 2: a settings model whose provider has no key (and no demo
// fallback) must not leave the composer live - the turn would only die at the
// proxy. The hint has to name the exact fix.
describe("ChatPanel provider-aware composer gate", () => {
  it("disables the composer and names the missing provider key", () => {
    renderPanel({ missingProviderKey: "Google" });
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText("Add your Google API key in Settings to run the selected model.")).toBeTruthy();
  });

  it("keeps the composer live when the turn is fundable", () => {
    renderPanel({ missingProviderKey: null });
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false);
  });

  it("shows the model that will actually run in the status bar", () => {
    renderPanel({ modelName: "Claude Sonnet 5 (demo)" });
    expect(screen.getByTestId("agent-status").textContent).toContain("Claude Sonnet 5 (demo)");
  });
});

// A prompt on a cold hosted container gets no SSE event for tens of seconds;
// without immediate feedback the wait reads as a frozen app. The composer must
// also treat that window as busy so the user cannot fire a second send.
describe("ChatPanel turn-start feedback", () => {
  it("shows the prompt and a 'Starting the agent' hint while it is in flight", () => {
    renderPanel({
      sessionState: { messages: [], streaming: false, submitting: true, pendingPrompt: "make a box" },
    });
    expect(screen.getByTestId("pending-user-message").textContent).toContain("make a box");
    expect(screen.getByTestId("generation-status").textContent).toContain("Starting the agent");
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.getByTestId("composer-stop")).toBeTruthy();
    // Preset cards must not linger behind the optimistic bubble.
    expect(screen.queryByText("Start the conversation")).toBeNull();
  });

  it("renders the free-demo meter when the deployment reports a balance", () => {
    renderPanel({
      demoBudget: { spentUsd: 0.5, capUsd: 2, spentMicroUsd: 500000, capMicroUsd: 2000000 },
    });
    expect(screen.getByTestId("demo-quota-meter").textContent).toContain("$1.50 left of $2.00");
  });

  it("hides the meter on deployments with no demo quota", () => {
    renderPanel({ demoBudget: null });
    expect(screen.queryByTestId("demo-quota-meter")).toBeNull();
  });
});
