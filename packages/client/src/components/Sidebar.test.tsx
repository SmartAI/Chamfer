import type { ConversationDto } from "@chamfer/shared";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const state = vi.hoisted(() => ({ conversations: [] as ConversationDto[] }));

vi.mock("@/state/chatState", () => ({
  useChatState: () => ({
    conversations: state.conversations,
    activeConversationId: undefined,
    selectConversation: vi.fn(),
    newConversation: vi.fn(),
    removeConversation: vi.fn(),
    refreshSettings: vi.fn(),
  }),
}));
vi.mock("./SettingsModal", () => ({ SettingsModal: () => null }));

function convo(overrides: Partial<ConversationDto>): ConversationDto {
  return {
    id: "conversation-1",
    title: "Overnight bracket",
    cadEnvironment: "build123d",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

afterEach(() => {
  state.conversations = [];
});

describe("Sidebar conversation status dot", () => {
  it("marks an active headless run as ongoing and names the current model", () => {
    state.conversations = [
      convo({ liveRun: { id: "run-1", status: "running", modelName: "Claude CAD", updatedAt: 2 } }),
    ];
    render(<Sidebar settingsOpen={false} onSettingsOpenChange={vi.fn()} />);
    const dot = screen.getByTestId("convo-status-dot");
    expect(dot.getAttribute("data-status")).toBe("ongoing");
    expect(dot.getAttribute("aria-label")).toBe("Headless run active using Claude CAD");
    expect(dot.className).toContain("animate-pulse");
    expect(dot.className).toContain("bg-sky-500");
  });

  it("shows a live run as ongoing even when the last verdict passed", () => {
    state.conversations = [
      convo({
        lastGateStatus: "passed",
        liveRun: { id: "run-1", status: "starting", modelName: "Claude CAD", updatedAt: 2 },
      }),
    ];
    render(<Sidebar settingsOpen={false} onSettingsOpenChange={vi.fn()} />);
    expect(screen.getByTestId("convo-status-dot").getAttribute("data-status")).toBe("ongoing");
  });

  it.each([
    { lastGateStatus: "passed", status: "passed", klass: "bg-emerald-500", label: "Last run verified" },
    { lastGateStatus: "failed", status: "failed", klass: "bg-red-500", label: "Last run failed verification" },
    { lastGateStatus: "error", status: "error", klass: "bg-amber-500", label: "Last run could not be verified" },
  ] as const)("maps a $lastGateStatus verdict to the $status dot", ({ lastGateStatus, status, klass, label }) => {
    state.conversations = [convo({ lastGateStatus })];
    render(<Sidebar settingsOpen={false} onSettingsOpenChange={vi.fn()} />);
    const dot = screen.getByTestId("convo-status-dot");
    expect(dot.getAttribute("data-status")).toBe(status);
    expect(dot.getAttribute("aria-label")).toBe(label);
    expect(dot.className).toContain(klass);
  });

  it("gives a conversation with no run a neutral, non-verdict dot", () => {
    state.conversations = [convo({})];
    render(<Sidebar settingsOpen={false} onSettingsOpenChange={vi.fn()} />);
    const dot = screen.getByTestId("convo-status-dot");
    expect(dot.getAttribute("data-status")).toBe("none");
    expect(dot.getAttribute("aria-label")).toBe("No run yet");
    // A hollow ring, not a filled verdict colour.
    expect(dot.className).toContain("border");
    expect(dot.className).not.toMatch(/bg-(emerald|red|amber|sky)-500/);
  });

  it("renders exactly one status dot for every conversation, regardless of status", () => {
    state.conversations = [
      convo({ id: "a", title: "A", lastGateStatus: "passed" }),
      convo({ id: "b", title: "B", lastGateStatus: "failed" }),
      convo({ id: "c", title: "C" }),
      convo({ id: "d", title: "D", liveRun: { id: "r", status: "running", modelName: "m", updatedAt: 2 } }),
    ];
    render(<Sidebar settingsOpen={false} onSettingsOpenChange={vi.fn()} />);
    expect(screen.getAllByTestId("convo-status-dot")).toHaveLength(4);
  });
});
