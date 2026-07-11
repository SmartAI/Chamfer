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
    newConversation: vi.fn(async () => "conv-1"),
    removeConversation: vi.fn(async () => {}),
    refreshSettings: vi.fn(async () => {}),
    clearError: vi.fn(),
    queuedMessages: [],
    queuePaused: false,
    sendMessage: vi.fn(),
    stopAgent: vi.fn(),
    removeQueued: vi.fn(),
    sendQueuedNow: vi.fn(),
    modelName: "Test Model",
    maxCadRuns: 10,
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
  const EASY = PRESET_PROMPTS.find((p) => p.id === "easy")!;
  const INTERMEDIATE = PRESET_PROMPTS.find((p) => p.id === "intermediate")!;

  it("creates a conversation from the no-conversation state, then sends the preset once the session exists", async () => {
    const newConversation = vi.fn(async () => "conv-1");
    const { rerender } = renderWithContext({
      activeConversationId: undefined,
      session: null,
      newConversation,
    });

    expect(screen.getByText("No conversation selected")).toBeTruthy();
    fireEvent.click(screen.getByTestId("preset-easy"));
    expect(newConversation).toHaveBeenCalledTimes(1);
    // Let newConversation resolve so the pending preset learns the created id.
    await act(async () => {});

    // As the real ChatProvider would after newConversation(): an active id appears first,
    // then the async switch produces the session.
    rerender(panelWithContext({ activeConversationId: "conv-1", session: null, newConversation }));
    const session = makeFakeSession("conv-1");
    rerender(panelWithContext({ activeConversationId: "conv-1", session, newConversation }));

    await waitFor(() => {
      expect(session.send).toHaveBeenCalledWith(EASY.prompt, []);
    });
    expect(session.send).toHaveBeenCalledTimes(1);
  });

  it("only creates one conversation when a preset is double-clicked on the homepage", async () => {
    const newConversation = vi.fn(async () => "conv-1");
    renderWithContext({
      activeConversationId: undefined,
      session: null,
      newConversation,
    });

    const card = screen.getByTestId("preset-easy");
    fireEvent.click(card);
    fireEvent.click(card);
    fireEvent.click(screen.getByTestId("preset-hard"));
    await act(async () => {});

    expect(newConversation).toHaveBeenCalledTimes(1);
  });

  it("does not fire the preset into the next conversation when creation fails", async () => {
    const newConversation = vi.fn(async (): Promise<string> => {
      throw new Error("boom");
    });
    const { rerender } = renderWithContext({
      activeConversationId: undefined,
      session: null,
      newConversation,
    });

    fireEvent.click(screen.getByTestId("preset-easy"));
    await act(async () => {});
    expect(newConversation).toHaveBeenCalledTimes(1);

    // User later opens some other conversation; the stale preset must not be sent into it.
    const session = makeFakeSession("conv-other");
    rerender(
      panelWithContext({ activeConversationId: "conv-other", session, newConversation }),
    );
    await act(async () => {});

    expect(session.send).not.toHaveBeenCalled();
    // And the cards are re-armed: clicking again retries the create.
    rerender(
      panelWithContext({ activeConversationId: undefined, session: null, newConversation }),
    );
    fireEvent.click(screen.getByTestId("preset-easy"));
    expect(newConversation).toHaveBeenCalledTimes(2);
  });

  it("drops the preset when the user opens another conversation during the create window", async () => {
    const newConversation = vi.fn(async () => "conv-new");
    const { rerender } = renderWithContext({
      activeConversationId: undefined,
      session: null,
      newConversation,
    });

    fireEvent.click(screen.getByTestId("preset-easy"));
    await act(async () => {});

    // Before conv-new's session is built, the user clicks an existing conversation and its
    // session appears; the preset must not be sent into that old conversation.
    const oldSession = makeFakeSession("conv-old");
    rerender(
      panelWithContext({ activeConversationId: "conv-old", session: oldSession, newConversation }),
    );
    await act(async () => {});

    expect(oldSession.send).not.toHaveBeenCalled();

    // Even if conv-new's session shows up afterwards, the preset stays dropped.
    const newSession = makeFakeSession("conv-new");
    rerender(
      panelWithContext({ activeConversationId: "conv-new", session: newSession, newConversation }),
    );
    await act(async () => {});

    expect(newSession.send).not.toHaveBeenCalled();
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

  it("disables the presets with a hint when settings are not configured", () => {
    renderWithContext({
      activeConversationId: undefined,
      session: null,
      settingsPresent: false,
    });

    expect((screen.getByTestId("preset-easy") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("preset-disabled-hint").textContent).toMatch(/settings/i);
  });

  it("hides the presets once the conversation has messages", () => {
    renderWithContext({
      session: makeFakeSession(),
      sessionState: { messages: [USER_MESSAGE], streaming: false },
    });

    expect(screen.queryByTestId("preset-prompts")).toBeNull();
  });
});
