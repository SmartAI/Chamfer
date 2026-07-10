import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConversationDto, MessageDto, SettingsDto } from "@chamfer/shared";
import * as rest from "@/api/rest";
import type { ChatSession, SessionState } from "@/agent/session";
import { ChatProvider, useChatState } from "@/state/chatState";

vi.mock("@/api/rest");

const mockedRest = vi.mocked(rest);

function makeConversation(id: string): ConversationDto {
  return {
    id,
    title: `Conversation ${id}`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ConversationDto;
}

/** Fake ChatSession whose abort() is a spy, so tests can assert the outgoing session was
 * aborted rather than left streaming headless after a conversation switch/delete. */
function makeFakeSession(conversationId: string): ChatSession {
  const listeners = new Set<(state: SessionState) => void>();
  return {
    conversationId,
    send: vi.fn(async () => {}),
    abort: vi.fn(),
    subscribe: vi.fn((listener: (state: SessionState) => void) => {
      listeners.add(listener);
      listener({ messages: [], streaming: true });
      return () => listeners.delete(listener);
    }),
  };
}

/** Test harness exposing ChatContext's actions/values as plain values for assertions,
 * mirroring how ChatPanel.test.tsx consumes the context, but driven through the real
 * ChatProvider so switchTo()'s internals are exercised. */
function Harness({ onValue }: { onValue: (value: ReturnType<typeof useChatState>) => void }) {
  const value = useChatState();
  onValue(value);
  return null;
}

describe("ChatProvider conversation switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aborts the in-flight session when switching to another conversation mid-stream", async () => {
    const convA = makeConversation("conv-a");
    const convB = makeConversation("conv-b");
    mockedRest.listConversations.mockResolvedValue([convA, convB]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}" } as SettingsDto);
    mockedRest.listMessages.mockResolvedValue([] as MessageDto[]);

    const sessionA = makeFakeSession("conv-a");
    const sessionB = makeFakeSession("conv-b");
    const createSessionMock = vi
      .fn()
      .mockReturnValueOnce(sessionA)
      .mockReturnValueOnce(sessionB);

    let latest: ReturnType<typeof useChatState> | undefined;

    render(
      <ChatProvider __createSession={createSessionMock}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));

    act(() => {
      latest?.selectConversation("conv-a");
    });
    await waitFor(() => expect(latest?.session).toBe(sessionA));

    // Simulate an in-flight streaming turn on conv-a's session, then switch to conv-b
    // before it finishes.
    act(() => {
      latest?.selectConversation("conv-b");
    });

    expect(sessionA.abort).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(latest?.session).toBe(sessionB));
  });

  it("aborts the in-flight session when the active conversation is deleted", async () => {
    const convA = makeConversation("conv-a");
    mockedRest.listConversations.mockResolvedValue([convA]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}" } as SettingsDto);
    mockedRest.listMessages.mockResolvedValue([] as MessageDto[]);
    mockedRest.deleteConversation.mockResolvedValue(undefined);

    const sessionA = makeFakeSession("conv-a");
    const createSessionMock = vi.fn().mockReturnValueOnce(sessionA);

    let latest: ReturnType<typeof useChatState> | undefined;

    render(
      <ChatProvider __createSession={createSessionMock}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));

    act(() => {
      latest?.selectConversation("conv-a");
    });
    await waitFor(() => expect(latest?.session).toBe(sessionA));

    await act(async () => {
      await latest?.removeConversation("conv-a");
    });

    expect(sessionA.abort).toHaveBeenCalledTimes(1);
  });

  it("replays saved messages even when model settings are not configured", async () => {
    const convA = makeConversation("conv-a");
    const savedMessage = {
      id: "message-1",
      conversationId: convA.id,
      seq: 0,
      role: "user",
      contentJson: JSON.stringify({ role: "user", content: "Saved history", timestamp: 1 }),
      createdAt: Date.now(),
    } as MessageDto;
    mockedRest.listConversations.mockResolvedValue([convA]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: undefined } as SettingsDto);
    mockedRest.listMessages.mockResolvedValue([savedMessage]);
    mockedRest.listArtifacts.mockResolvedValue([]);

    let latest: ReturnType<typeof useChatState> | undefined;
    render(
      <ChatProvider __createSession={vi.fn()}>
        <Harness onValue={(value) => (latest = value)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));
    act(() => latest?.selectConversation(convA.id));

    await waitFor(() =>
      expect(latest?.sessionState.messages).toEqual([
        { role: "user", content: "Saved history", timestamp: 1 },
      ]),
    );
    expect(latest?.session).toBeNull();
  });

  it("refreshSettings re-fetches settings so settings-gated UI enables after saving", async () => {
    mockedRest.listConversations.mockResolvedValue([]);
    // No model configured at mount time.
    mockedRest.getSettings.mockResolvedValue({} as SettingsDto);

    let latest: ReturnType<typeof useChatState> | undefined;

    render(
      <ChatProvider __createSession={vi.fn()}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));
    expect(latest?.settingsPresent).toBe(false);

    // The user saves a model + key in SettingsModal, which calls refreshSettings().
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}" } as SettingsDto);
    await act(async () => {
      await latest?.refreshSettings();
    });

    expect(latest?.settingsPresent).toBe(true);
  });
});

describe("ChatProvider auto-titling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Fake session whose subscriber can be driven from the test, simulating a
   * streaming turn ending with an assistant reply. */
  function makeEmittingSession(conversationId: string): {
    session: ChatSession;
    emit: (state: SessionState) => void;
  } {
    const listeners = new Set<(state: SessionState) => void>();
    return {
      session: {
        conversationId,
        send: vi.fn(async () => {}),
        abort: vi.fn(),
        subscribe: (listener: (state: SessionState) => void) => {
          listeners.add(listener);
          listener({ messages: [], streaming: false });
          return () => listeners.delete(listener);
        },
      },
      emit: (state) => {
        for (const listener of listeners) listener(state);
      },
    };
  }

  function firstExchange(): SessionState {
    return {
      messages: [
        { role: "user", content: "make me a gear", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 2 },
      ],
      streaming: false,
    };
  }

  async function renderWithConversation(title: string) {
    const conv = { ...makeConversation("conv-a"), title };
    mockedRest.listConversations.mockResolvedValue([conv]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}" } as SettingsDto);
    mockedRest.listMessages.mockResolvedValue([] as MessageDto[]);
    mockedRest.listArtifacts.mockResolvedValue([]);

    const emitting = makeEmittingSession("conv-a");
    const createSessionMock = vi.fn().mockReturnValue(emitting.session);

    let latest: ReturnType<typeof useChatState> | undefined;
    render(
      <ChatProvider __createSession={createSessionMock}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );
    await waitFor(() => expect(latest?.loading).toBe(false));
    act(() => latest?.selectConversation("conv-a"));
    await waitFor(() => expect(latest?.session).toBe(emitting.session));
    return { emitting, getLatest: () => latest };
  }

  it("asks the server for a title after the first exchange and updates the sidebar", async () => {
    mockedRest.generateTitle.mockResolvedValue({ title: "Parametric Gear Design", generated: true });
    const { emitting, getLatest } = await renderWithConversation("New chat");

    // No assistant reply yet: nothing should fire.
    expect(mockedRest.generateTitle).not.toHaveBeenCalled();

    act(() => emitting.emit(firstExchange()));

    await waitFor(() =>
      expect(getLatest()?.conversations.find((c) => c.id === "conv-a")?.title).toBe("Parametric Gear Design"),
    );
    expect(mockedRest.generateTitle).toHaveBeenCalledTimes(1);
    expect(mockedRest.generateTitle).toHaveBeenCalledWith("conv-a");

    // Later turns must not regenerate.
    act(() => emitting.emit(firstExchange()));
    expect(mockedRest.generateTitle).toHaveBeenCalledTimes(1);
  });

  it("does not auto-title a conversation that already has a generated title", async () => {
    const { emitting } = await renderWithConversation("Parametric Gear Design");

    act(() => emitting.emit(firstExchange()));

    expect(mockedRest.generateTitle).not.toHaveBeenCalled();
  });

  it("retries a failed generation when the conversation is opened again", async () => {
    mockedRest.generateTitle
      .mockRejectedValueOnce(new Error("502"))
      .mockResolvedValueOnce({ title: "Parametric Gear Design", generated: true });
    const { emitting, getLatest } = await renderWithConversation("New chat");

    act(() => emitting.emit(firstExchange()));
    await waitFor(() => expect(mockedRest.generateTitle).toHaveBeenCalledTimes(1));
    expect(getLatest()?.conversations.find((c) => c.id === "conv-a")?.title).toBe("New chat");

    // Clicking the conversation again re-arms the attempt latch; the next
    // completed exchange (or replayed history) triggers a fresh generation.
    act(() => getLatest()?.selectConversation("conv-a"));
    await waitFor(() => expect(getLatest()?.session).not.toBeNull());
    act(() => emitting.emit(firstExchange()));

    await waitFor(() => expect(mockedRest.generateTitle).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(getLatest()?.conversations.find((c) => c.id === "conv-a")?.title).toBe("Parametric Gear Design"),
    );
  });

  it("keeps the default title when generation fails, without surfacing an error", async () => {
    mockedRest.generateTitle.mockRejectedValue(new Error("502"));
    const { emitting, getLatest } = await renderWithConversation("New chat");

    act(() => emitting.emit(firstExchange()));

    await waitFor(() => expect(mockedRest.generateTitle).toHaveBeenCalledTimes(1));
    expect(getLatest()?.conversations.find((c) => c.id === "conv-a")?.title).toBe("New chat");
    expect(getLatest()?.error).toBeNull();
  });
});
