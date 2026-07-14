import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ConversationDto, MessageDto, SettingsResponseDto } from "@chamfer/shared";
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
    steer: vi.fn(async () => "consumed" as const),
    cancelSteering: vi.fn(),
    prioritizeSteering: vi.fn(),
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
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", sources: {} } as SettingsResponseDto);
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
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", sources: {} } as SettingsResponseDto);
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
    mockedRest.getSettings.mockResolvedValue({ modelJson: undefined, sources: {} } as SettingsResponseDto);
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

  it("passes the configured maxCadRuns into the session it creates", async () => {
    const convA = makeConversation("conv-a");
    mockedRest.listConversations.mockResolvedValue([convA]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", maxCadRuns: "7", sources: {} } as SettingsResponseDto);
    mockedRest.listMessages.mockResolvedValue([] as MessageDto[]);
    mockedRest.listArtifacts.mockResolvedValue([]);

    const createSessionMock = vi.fn().mockReturnValue(makeFakeSession("conv-a"));
    let latest: ReturnType<typeof useChatState> | undefined;
    render(
      <ChatProvider __createSession={createSessionMock}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));
    act(() => latest?.selectConversation("conv-a"));

    await waitFor(() => expect(createSessionMock).toHaveBeenCalled());
    expect(createSessionMock.mock.calls[0]?.[0]).toMatchObject({ maxCadRuns: 7 });
  });

  it("exposes the configured model name and CAD-run cap for the status strip", async () => {
    const convA = makeConversation("conv-a");
    mockedRest.listConversations.mockResolvedValue([convA]);
    mockedRest.getSettings.mockResolvedValue({
      modelJson: JSON.stringify({ id: "claude-opus-4-8", name: "Claude Opus 4.8" }),
      maxCadRuns: "100",
      sources: {},
    } as SettingsResponseDto);
    mockedRest.listMessages.mockResolvedValue([] as MessageDto[]);
    mockedRest.listArtifacts.mockResolvedValue([]);

    const createSessionMock = vi.fn().mockReturnValue(makeFakeSession("conv-a"));
    let latest: ReturnType<typeof useChatState> | undefined;
    render(
      <ChatProvider __createSession={createSessionMock}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));
    await waitFor(() => expect(latest?.modelName).toBe("Claude Opus 4.8"));

    act(() => latest?.selectConversation("conv-a"));
    await waitFor(() => expect(latest?.session).not.toBeNull());
    expect(latest?.maxCadRuns).toBe(100);
  });

  it("falls back to the default CAD-run cap when the setting is absent", async () => {
    mockedRest.listConversations.mockResolvedValue([]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", sources: {} } as SettingsResponseDto);

    let latest: ReturnType<typeof useChatState> | undefined;
    render(
      <ChatProvider __createSession={vi.fn()}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));
    expect(latest?.maxCadRuns).toBe(10);
  });

  it("refreshSettings re-fetches settings so settings-gated UI enables after saving", async () => {
    mockedRest.listConversations.mockResolvedValue([]);
    // No model configured at mount time.
    mockedRest.getSettings.mockResolvedValue({ sources: {} } as SettingsResponseDto);

    let latest: ReturnType<typeof useChatState> | undefined;

    render(
      <ChatProvider __createSession={vi.fn()}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );

    await waitFor(() => expect(latest?.loading).toBe(false));
    expect(latest?.settingsPresent).toBe(false);

    // The user saves a model + key in SettingsModal, which calls refreshSettings().
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", sources: {} } as SettingsResponseDto);
    await act(async () => {
      await latest?.refreshSettings();
    });

    expect(latest?.settingsPresent).toBe(true);
  });
});

describe("ChatProvider message queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** Fake session whose send() promise resolves only when the test ends the turn,
   * mirroring the real session where send() settles after the full agent turn. */
  function makeQueueSession(conversationId: string) {
    const listeners = new Set<(state: SessionState) => void>();
    const pendingResolvers: Array<() => void> = [];
    const steeringResolvers = new Map<string, (outcome: "consumed" | "cancelled") => void>();
    const session: ChatSession = {
      conversationId,
      send: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            pendingResolvers.push(resolve);
          }),
      ),
      steer: vi.fn(
        (id: string) =>
          new Promise<"consumed" | "cancelled">((resolve) => {
            steeringResolvers.set(id, resolve);
          }),
      ),
      cancelSteering: vi.fn((id: string) => {
        steeringResolvers.get(id)?.("cancelled");
        steeringResolvers.delete(id);
      }),
      prioritizeSteering: vi.fn(),
      abort: vi.fn(() => {
        for (const resolve of steeringResolvers.values()) resolve("cancelled");
        steeringResolvers.clear();
      }),
      subscribe: (listener: (state: SessionState) => void) => {
        listeners.add(listener);
        listener({ messages: [], streaming: false });
        return () => listeners.delete(listener);
      },
    };
    return {
      session,
      emit: (state: SessionState) => {
        for (const listener of listeners) listener(state);
      },
      finishTurn: () => {
        for (const resolve of steeringResolvers.values()) resolve("cancelled");
        steeringResolvers.clear();
        pendingResolvers.shift()?.();
      },
      finishSteering: (id: string, outcome: "consumed" | "cancelled" = "consumed") => {
        steeringResolvers.get(id)?.(outcome);
        steeringResolvers.delete(id);
      },
    };
  }

  async function renderQueueHarness() {
    mockedRest.listConversations.mockResolvedValue([makeConversation("conv-a"), makeConversation("conv-b")]);
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", sources: {} } as SettingsResponseDto);
    mockedRest.listMessages.mockResolvedValue([] as MessageDto[]);
    mockedRest.listArtifacts.mockResolvedValue([]);

    const fakeA = makeQueueSession("conv-a");
    const fakeB = makeQueueSession("conv-b");
    const createSessionMock = vi.fn((opts: { conversationId: string }) =>
      opts.conversationId === "conv-a" ? fakeA.session : fakeB.session,
    );

    let latest: ReturnType<typeof useChatState> | undefined;
    render(
      <ChatProvider __createSession={createSessionMock as never}>
        <Harness onValue={(v) => (latest = v)} />
      </ChatProvider>,
    );
    await waitFor(() => expect(latest?.loading).toBe(false));
    act(() => latest?.selectConversation("conv-a"));
    await waitFor(() => expect(latest?.session).toBe(fakeA.session));
    return { fakeA, getLatest: () => latest };
  }

  it("sends immediately when idle, queues while streaming, and drains FIFO at turn end", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
    expect(fakeA.session.send).toHaveBeenCalledWith("first", []);

    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => getLatest()?.sendMessage("second", []));
    act(() => getLatest()?.sendMessage("third", []));

    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
    expect(getLatest()?.queuedMessages.map((m) => m.text)).toEqual(["second", "third"]);

    // Turn ends: streaming stops and the send() promise settles.
    await act(async () => {
      fakeA.emit({ messages: [], streaming: false });
      fakeA.finishTurn();
      await Promise.resolve();
    });

    expect(fakeA.session.send).toHaveBeenCalledTimes(2);
    expect(fakeA.session.send).toHaveBeenLastCalledWith("second", []);
    expect(getLatest()?.queuedMessages.map((m) => m.text)).toEqual(["third"]);
  });

  it("steers a busy session and keeps the correction pending until pi consumes it", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => {
      getLatest()?.sendMessage("make it 40 mm wide", []);
      expect(fakeA.session.steer).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => expect(fakeA.session.steer).toHaveBeenCalledTimes(1));
    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
    const pending = getLatest()?.queuedMessages[0];
    expect(pending?.text).toBe("make it 40 mm wide");
    expect(fakeA.session.steer).toHaveBeenCalledWith(pending?.id, "make it 40 mm wide", []);

    await act(async () => {
      fakeA.finishSteering(pending!.id);
      await Promise.resolve();
    });

    expect(getLatest()?.queuedMessages).toHaveLength(0);
    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
  });

  it("stopAgent aborts the session and pauses draining, keeping queued items", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => getLatest()?.sendMessage("second", []));

    act(() => getLatest()?.stopAgent());
    expect(fakeA.session.abort).toHaveBeenCalledTimes(1);

    await act(async () => {
      fakeA.emit({ messages: [], streaming: false });
      fakeA.finishTurn();
      await Promise.resolve();
    });

    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
    expect(getLatest()?.queuePaused).toBe(true);
    expect(getLatest()?.queuedMessages.map((m) => m.text)).toEqual(["second"]);
  });

  it("sendQueuedNow resumes draining with the chosen item first", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => getLatest()?.sendMessage("second", []));
    act(() => getLatest()?.sendMessage("third", []));
    act(() => getLatest()?.stopAgent());
    await act(async () => {
      fakeA.emit({ messages: [], streaming: false });
      fakeA.finishTurn();
      await Promise.resolve();
    });

    const third = getLatest()?.queuedMessages.find((m) => m.text === "third");
    await act(async () => {
      getLatest()?.sendQueuedNow(third!.id);
      await Promise.resolve();
    });

    expect(fakeA.session.send).toHaveBeenCalledTimes(2);
    expect(fakeA.session.send).toHaveBeenLastCalledWith("third", []);
    expect(getLatest()?.queuePaused).toBe(false);
    expect(getLatest()?.queuedMessages.map((m) => m.text)).toEqual(["second"]);
  });

  it("removeQueued discards an item without sending it", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => getLatest()?.sendMessage("second", []));
    act(() => getLatest()?.sendMessage("third", []));

    const second = getLatest()?.queuedMessages.find((m) => m.text === "second");
    act(() => getLatest()?.removeQueued(second!.id));

    expect(getLatest()?.queuedMessages.map((m) => m.text)).toEqual(["third"]);
    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
  });

  it("does not auto-drain into a turn that ended in error", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => getLatest()?.sendMessage("second", []));

    await act(async () => {
      fakeA.emit({ messages: [], streaming: false, error: { kind: "generic", message: "boom" } });
      fakeA.finishTurn();
      await Promise.resolve();
    });

    expect(fakeA.session.send).toHaveBeenCalledTimes(1);
    expect(getLatest()?.queuedMessages.map((m) => m.text)).toEqual(["second"]);
  });

  it("clears the queue when switching conversations", async () => {
    const { fakeA, getLatest } = await renderQueueHarness();

    act(() => getLatest()?.sendMessage("first", []));
    act(() => fakeA.emit({ messages: [], streaming: true }));
    act(() => getLatest()?.sendMessage("second", []));
    expect(getLatest()?.queuedMessages).toHaveLength(1);

    act(() => getLatest()?.selectConversation("conv-b"));

    expect(getLatest()?.queuedMessages).toHaveLength(0);
    expect(getLatest()?.queuePaused).toBe(false);
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
        steer: vi.fn(async () => "consumed" as const),
        cancelSteering: vi.fn(),
        prioritizeSteering: vi.fn(),
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
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}", sources: {} } as SettingsResponseDto);
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
