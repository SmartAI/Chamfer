import { useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatSession, SessionState } from "@/agent/session";
import { ChatContext, type ChatContextValue } from "@/state/chatState";
import { PRESET_PROMPTS } from "@/presets";
import { ChatPanel } from "./ChatPanel";

const USER_MESSAGE = { role: "user", content: "Hello there", timestamp: 1 };

const ASSISTANT_PARTIAL_1 = {
  role: "assistant",
  content: [{ type: "text", text: "Hi" }],
  timestamp: 2,
};

const ASSISTANT_PARTIAL_2 = {
  role: "assistant",
  content: [{ type: "text", text: "Hi, **friend**!" }],
  timestamp: 2,
};

const ASSISTANT_FINAL = {
  role: "assistant",
  content: [{ type: "text", text: "Hi, **friend**! How can I help?" }],
  timestamp: 2,
};

/** Scripted SessionState sequence driving the fake session's subscribers, mirroring how the
 * real createSession() notifies listeners as a turn streams in. */
const STATE_SEQUENCE: SessionState[] = [
  { messages: [USER_MESSAGE], streaming: true },
  { messages: [USER_MESSAGE, ASSISTANT_PARTIAL_1], streaming: true },
  { messages: [USER_MESSAGE, ASSISTANT_PARTIAL_2], streaming: true },
  { messages: [USER_MESSAGE, ASSISTANT_FINAL], streaming: false },
];

function makeFakeSession(conversationId = "conv-1") {
  const listeners = new Set<(state: SessionState) => void>();
  let state: SessionState = { messages: [], streaming: false };

  const session: ChatSession = {
    conversationId,
    send: vi.fn(async (_text: string) => {
      for (const next of STATE_SEQUENCE) {
        state = next;
        for (const listener of listeners) listener(state);
      }
    }),
    steer: vi.fn(async () => "consumed" as const),
    cancelSteering: vi.fn(),
    prioritizeSteering: vi.fn(),
    abort: vi.fn(),
    subscribe: vi.fn((listener: (s: SessionState) => void) => {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    }),
  };

  return session;
}

function makeContextValue(overrides: Partial<ChatContextValue>): ChatContextValue {
  const value: ChatContextValue = {
    conversations: [],
    activeConversationId: "conv-1",
    session: null,
    sessionState: { messages: [], streaming: false },
    settingsPresent: true,
    loading: false,
    error: null,
    selectConversation: vi.fn(),
    newConversation: vi.fn(),
    removeConversation: vi.fn(async () => {}),
    refreshSettings: vi.fn(async () => {}),
    clearError: vi.fn(),
    queuedMessages: [],
    queuePaused: false,
    sendMessage: vi.fn(),
    stopAgent: vi.fn(),
    resumeAfterFusionReconciliation: vi.fn(),
    removeQueued: vi.fn(),
    sendQueuedNow: vi.fn(),
    modelName: "Test Model",
    maxCadRuns: 10,
    showCadCode: false,
    ...overrides,
  };
  // Unless a test overrides it, sendMessage behaves like the idle-path provider:
  // it forwards straight to the session, so existing session.send assertions hold.
  if (!overrides.sendMessage) {
    value.sendMessage = vi.fn((text: string, images: File[]) => {
      void value.session?.send(text, images);
    });
  }
  return value;
}

function panelWithContext(overrides: Partial<ChatContextValue>, onOpenSettings?: () => void) {
  return (
    <ChatContext.Provider value={makeContextValue(overrides)}>
      <ChatPanel onOpenSettings={onOpenSettings} />
    </ChatContext.Provider>
  );
}

function renderWithContext(overrides: Partial<ChatContextValue>, onOpenSettings?: () => void) {
  return render(panelWithContext(overrides, onOpenSettings));
}

describe("ChatPanel", () => {
  it("renders durable source requirements separately from plan progress", () => {
    renderWithContext({
      session: makeFakeSession(),
      sessionState: {
        messages: [{
          role: "toolResult",
          toolName: "update_plan",
          details: {
            plan: {
              goal: "plate",
              components: [{ id: "plate", description: "plate", bbox_mm: [30, 20, 4], checks: [], status: "todo", free_floating_reason: "single" }],
              interfaces: [],
            },
          },
        }],
        sourceSpecifications: [{
          id: "plate-width",
          conversationId: "conv-1",
          requirement: "The plate must be 30 mm wide.",
          source: { messageId: "message-1", text: "30 mm plate", start: 8, end: 19 },
          actor: "agent",
          status: "active",
          timestamp: 1,
        }, {
          id: "front-orientation-v1",
          conversationId: "conv-1",
          requirement: "Use the original front orientation.",
          source: {
            attachmentId: "reference-1",
            observation: "The original front orientation is shown here.",
            region: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
          },
          actor: "agent",
          status: "superseded",
          supersededBySpecificationId: "front-orientation-v2",
          timestamp: 2,
        }, {
          id: "front-orientation-v2",
          conversationId: "conv-1",
          requirement: "Use the corrected front orientation.",
          source: {
            attachmentId: "reference-2",
            observation: "The corrected front orientation is authoritative.",
            region: { x: 0.2, y: 0.1, width: 0.6, height: 0.5 },
          },
          supersedesSpecificationId: "front-orientation-v1",
          actor: "agent",
          status: "active",
          timestamp: 3,
        }],
        streaming: false,
      },
    });

    expect(screen.getByTestId("source-specifications-card")).toBeTruthy();
    expect(screen.getByTestId("plan-card")).toBeTruthy();
    expect(screen.getByTestId("source-specifications-card").textContent).toContain("2 active · 1 history");
    expect(screen.queryByTestId("source-specification")).toBeNull();
    fireEvent.click(screen.getByTestId("source-specifications-toggle"));
    const sourceRows = screen.getAllByTestId("source-specification");
    expect(sourceRows).toHaveLength(3);
    expect(sourceRows[0]?.textContent).toContain("The plate must be 30 mm wide.");
    expect(sourceRows[0]?.textContent).toContain("30 mm plate");
    expect(sourceRows[1]?.textContent).toContain("superseded");
    expect(sourceRows[2]?.textContent).toContain("Attachment reference-2");
    expect(screen.getAllByTestId("source-specification-region")).toHaveLength(2);
  });

  it("renders the user bubble, streams assistant markdown in, and keeps the composer usable while streaming", async () => {
    const session = makeFakeSession();

    const { rerender } = renderWithContext({
      session,
      sessionState: { messages: [], streaming: false },
    });

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    const sendButton = screen.getByTestId("composer-send");

    fireEvent.change(input, { target: { value: "Hello there" } });
    fireEvent.click(sendButton);

    expect(session.send).toHaveBeenCalledWith("Hello there", []);

    // Drive the scripted state sequence through the context, as the real ChatProvider would
    // after each session notification.
    for (const next of STATE_SEQUENCE) {
      act(() => {
        rerender(panelWithContext({ session, sessionState: next }));
      });

      if (next.streaming) {
        expect(screen.getByTestId("generation-status").textContent).toContain("Agent is working");
        // The composer stays usable while a turn is streaming (messages queue),
        // and a Stop control appears.
        await waitFor(() => {
          expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false);
          expect(screen.getByTestId("composer-stop")).toBeTruthy();
        });
      }
    }

    // User bubble appears with the sent text.
    expect(await screen.findByText("Hello there")).toBeTruthy();

    // Assistant markdown streamed in and rendered (bold markdown produces a streamdown "strong"
    // node, rendered as a styled <span data-streamdown="strong"> rather than a <strong> tag).
    const messageList = screen.getByTestId("message-list");
    await waitFor(() => {
      expect(within(messageList).getByText(/How can I help\?/)).toBeTruthy();
    });
    expect(messageList.querySelector('[data-streamdown="strong"]')?.textContent).toBe("friend");

    // After the final non-streaming state, the Stop control is gone again.
    await waitFor(() => {
      expect(screen.queryByTestId("composer-stop")).toBeNull();
    });
    expect(screen.getByTestId("generation-status").textContent).toContain("Done");
  });

  it("routes sends through sendMessage and wires the Stop button to stopAgent", () => {
    const sendMessage = vi.fn();
    const stopAgent = vi.fn();
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: true },
      sendMessage,
      stopAgent,
    });

    const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "queued while busy" } });
    fireEvent.click(screen.getByTestId("composer-send"));
    expect(sendMessage).toHaveBeenCalledWith("queued while busy", []);

    fireEvent.click(screen.getByTestId("composer-stop"));
    expect(stopAgent).toHaveBeenCalledTimes(1);
  });

  it("renders queued messages with send-now and remove controls", () => {
    const removeQueued = vi.fn();
    const sendQueuedNow = vi.fn();
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: true },
      queuedMessages: [
        { id: "q1", text: "refine the neck", images: [] },
        { id: "q2", text: "add the vent slots", images: [] },
      ],
      removeQueued,
      sendQueuedNow,
    });

    const items = screen.getAllByTestId("queued-message");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("refine the neck");

    fireEvent.click(within(items[0]!).getByTestId("queued-send-now"));
    expect(sendQueuedNow).toHaveBeenCalledWith("q1");

    fireEvent.click(within(items[1]!).getByTestId("queued-remove"));
    expect(removeQueued).toHaveBeenCalledWith("q2");
  });

  it("shows the model, LLM-call count, and CAD-run usage above the composer", () => {
    renderWithContext({
      session: makeFakeSession(),
      modelName: "Claude Opus 4.8",
      maxCadRuns: 100,
      sessionState: {
        messages: [
          USER_MESSAGE,
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "c1", name: "run_build123d", arguments: {} }],
            timestamp: 2,
          },
          ASSISTANT_FINAL,
        ],
        streaming: true,
      },
    });

    const strip = screen.getByTestId("agent-status");
    expect(strip.textContent).toContain("Claude Opus 4.8");
    expect(strip.textContent).toMatch(/LLM calls\s*2/);
    expect(strip.textContent).toMatch(/CAD runs\s*1\s*\/\s*100/);
  });

  it("hides the status strip when no model is configured", () => {
    renderWithContext({
      session: null,
      settingsPresent: false,
      modelName: null,
      sessionState: { messages: [], streaming: false },
    });

    expect(screen.queryByTestId("agent-status")).toBeNull();
  });

  it("shows a paused notice when the queue is paused", () => {
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: false },
      queuedMessages: [{ id: "q1", text: "later", images: [] }],
      queuePaused: true,
    });

    expect(screen.getByTestId("queue-paused").textContent).toMatch(/paused/i);
  });

  it("shows generation progress before the first assistant token arrives", () => {
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: true },
    });

    const status = screen.getByTestId("generation-status");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Agent is working");
  });

  it("does not show a completed status unless the latest visible message is from the assistant", () => {
    const { rerender } = renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [], streaming: false },
    });

    expect(screen.queryByTestId("generation-status")).toBeNull();

    rerender(panelWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: false },
    }));
    expect(screen.queryByTestId("generation-status")).toBeNull();
  });

  it("shows a generic error banner when sessionState.error is set", () => {
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [], streaming: false, error: { kind: "generic", message: "boom" } },
    });

    expect(screen.getByTestId("error-banner").textContent).toContain("boom");
    expect(screen.queryByTestId("generation-status")).toBeNull();
  });

  it("invalid-key errors show the settings hint and the button opens settings", () => {
    const onOpenSettings = vi.fn();
    renderWithContext(
      {
        session: makeFakeSession(),
        sessionState: {
          messages: [],
          streaming: false,
          error: { kind: "invalid-key", message: "Proxy error: 401 invalid x-api-key" },
        },
      },
      onOpenSettings,
    );

    expect(screen.getByTestId("error-banner").textContent).toContain("Check your API key in Settings");
    fireEvent.click(screen.getByTestId("error-open-settings"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("rate-limited errors show a Retry button that re-sends the last user message text", () => {
    const session = makeFakeSession();
    renderWithContext({
      session,
      sessionState: {
        messages: [
          { role: "user", content: [{ type: "text", text: "make a box" }], timestamp: 1 },
          { role: "assistant", content: [], errorMessage: "429", timestamp: 2 },
        ],
        streaming: false,
        error: { kind: "rate-limited", message: "429 rate limit exceeded" },
      },
    });

    expect(screen.getByTestId("error-banner").textContent).toContain("429 rate limit exceeded");
    fireEvent.click(screen.getByTestId("error-retry"));
    expect(session.send).toHaveBeenCalledWith("make a box");
  });

  it("renders a chat provider error as a dismissible banner and clears it on dismiss", () => {
    function Harness() {
      const [error, setError] = useState<string | null>("could not create conversation");
      return (
        <ChatContext.Provider value={makeContextValue({ error, clearError: () => setError(null) })}>
          <ChatPanel />
        </ChatContext.Provider>
      );
    }
    render(<Harness />);

    const banner = screen.getByTestId("provider-error-banner");
    expect(banner.textContent).toContain("could not create conversation");

    fireEvent.click(within(banner).getByTestId("error-dismiss"));
    expect(screen.queryByTestId("provider-error-banner")).toBeNull();
  });

  it("renders the provider error banner in the no-conversation state too", () => {
    renderWithContext({
      activeConversationId: undefined,
      session: null,
      error: "failed to load conversations",
    });

    expect(screen.getByTestId("provider-error-banner").textContent).toContain(
      "failed to load conversations",
    );
  });

  it("keeps long conversations inside a scrollable history above the composer", () => {
    const longText = "Long pasted content ".repeat(500);
    renderWithContext({
      session: makeFakeSession(),
      sessionState: {
        messages: [
          { role: "user", content: longText },
          { role: "assistant", content: longText },
        ],
        streaming: false,
      },
    });

    const messageList = screen.getByTestId("message-list");
    expect(messageList.className).toContain("min-h-0");
    expect(messageList.className).toContain("overflow-y-auto");
    expect(screen.getByTestId("composer").className).toContain("shrink-0");
  });

  it("disables the composer with a hint when settings are not configured", () => {
    renderWithContext({
      session: null,
      settingsPresent: false,
      sessionState: { messages: [], streaming: false },
    });

    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getAllByText(/settings/i).length).toBeGreaterThan(0);
  });

  it("shows the settings hint exactly once in an active empty conversation", () => {
    renderWithContext({
      session: null,
      settingsPresent: false,
      sessionState: { messages: [], streaming: false },
    });

    // The composer explains why everything is disabled; the preset grid above
    // it must not repeat the same sentence.
    expect(screen.getAllByText("Configure a model and API key in Settings to start chatting.")).toHaveLength(1);
    expect(screen.queryByTestId("preset-disabled-hint")).toBeNull();
  });
});

describe("ChatPanel preset prompts", () => {
  const INTERMEDIATE = PRESET_PROMPTS.find((p) => p.id === "intermediate")!;

  it("hides build123d presets until a conversation has an explicit environment", () => {
    renderWithContext({
      activeConversationId: undefined,
      session: null,
    });

    expect(screen.getByText("No conversation selected")).toBeTruthy();
    expect(screen.queryByTestId("preset-prompts")).toBeNull();
  });

  it("does not expose build123d presets in a Fusion conversation", () => {
    renderWithContext({
      conversations: [{
        id: "conv-1",
        title: "Fusion design",
        cadEnvironment: "fusion",
        createdAt: 1,
        updatedAt: 1,
      }],
      session: makeFakeSession(),
    });

    expect(screen.queryByTestId("preset-prompts")).toBeNull();
    expect(screen.getByText(/bound Autodesk Fusion environment/)).toBeTruthy();
  });

  it("sends only once when a preset is double-clicked in an active-but-empty conversation", () => {
    const session = makeFakeSession();
    renderWithContext({ session, sessionState: { messages: [], streaming: false } });

    const card = screen.getByTestId("preset-intermediate");
    fireEvent.click(card);
    fireEvent.click(card);

    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.send).toHaveBeenCalledWith(INTERMEDIATE.prompt, []);
  });

  it("sends the preset immediately in an active-but-empty conversation", () => {
    const session = makeFakeSession();
    renderWithContext({ session, sessionState: { messages: [], streaming: false } });

    fireEvent.click(screen.getByTestId("preset-intermediate"));
    expect(session.send).toHaveBeenCalledWith(INTERMEDIATE.prompt, []);
  });

  it("disables the presets and shows the shared settings hint when settings are not configured", () => {
    renderWithContext({
      session: null,
      settingsPresent: false,
    });

    expect((screen.getByTestId("preset-easy") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("preset-disabled-hint")).toBeNull();
    expect(screen.getByText(/configure a model and api key in settings/i)).toBeTruthy();
  });

  it("hides the presets once the conversation has messages", () => {
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: false },
    });

    expect(screen.queryByTestId("preset-prompts")).toBeNull();
  });
});
