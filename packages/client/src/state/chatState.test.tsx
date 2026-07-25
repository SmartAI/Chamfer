import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/rest");
vi.mock("@/api/agentTransport");

// A stable appState so the provider's loadArtifact / clearWorkspace are spies we
// can assert the gate against (the real ones come from AppStateProvider, absent
// here). Stable identity keeps switchTo's useCallback deps from thrashing.
const { appState } = vi.hoisted(() => ({
  appState: { loadArtifact: vi.fn(), clearWorkspace: vi.fn() },
}));
vi.mock("@/state/appState", () => ({ useOptionalAppState: () => appState }));

import * as rest from "@/api/rest";
import { openAgentEvents } from "@/api/agentTransport";
import { ChatProvider, useChatState } from "./chatState";

const mockedRest = vi.mocked(rest);
const mockedOpenAgentEvents = vi.mocked(openAgentEvents);

function Consumer() {
  const { selectConversation, agentHostingOffline } = useChatState();
  return (
    <div>
      <span data-testid="hosting">{agentHostingOffline ? "offline" : "online"}</span>
      <button type="button" onClick={() => selectConversation("c1")}>
        open
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ChatProvider>
      <Consumer />
    </ChatProvider>,
  );
}

// PR #36 gated the composer on capabilities.agentHosting, but opening a
// conversation still subscribed to /api/agent/*/events and fetched /artifact
// unconditionally - two 404s per open on a deployment that doesn't host agents.
// These cover the state seam (chatState.switchTo) so the wiring stays gated.
describe("chatState agent-hosting gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRest.getSettings.mockResolvedValue({ modelJson: "{}" } as never);
    mockedRest.listConversations.mockResolvedValue([]);
    mockedRest.listMessages.mockResolvedValue([]);
    mockedRest.getOnlineBudget.mockResolvedValue(null);
    mockedOpenAgentEvents.mockReturnValue({ close: vi.fn() } as unknown as EventSource);
  });

  it("skips the events stream and artifact fetch when agentHosting is off", async () => {
    mockedRest.getRuntimeCapabilities.mockResolvedValue({
      headlessRuns: false,
      agentHosting: false,
      demoQuota: false,
    });
    renderProvider();

    // Wait until the capabilities probe has resolved offline; only then is the
    // gate's ref set, so a switch after this point must not open the stream.
    await waitFor(() => expect(screen.getByTestId("hosting").textContent).toBe("offline"));

    fireEvent.click(screen.getByRole("button", { name: "open" }));

    // switchTo reaches its listMessages resolution...
    await waitFor(() => expect(mockedRest.listMessages).toHaveBeenCalledWith("c1"));
    // ...but never opens the SSE stream nor fetches the artifact on a
    // non-hosting deployment.
    expect(mockedOpenAgentEvents).not.toHaveBeenCalled();
    expect(appState.loadArtifact).not.toHaveBeenCalled();
  });

  it("opens the events stream when agentHosting is on", async () => {
    mockedRest.getRuntimeCapabilities.mockResolvedValue({
      headlessRuns: false,
      agentHosting: true,
      demoQuota: false,
    });
    renderProvider();

    await waitFor(() => expect(mockedRest.getRuntimeCapabilities).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "open" }));

    await waitFor(() =>
      expect(mockedOpenAgentEvents).toHaveBeenCalledWith("c1", expect.any(Function)),
    );
    // The artifact restore fires too when hosting is on.
    await waitFor(() => expect(appState.loadArtifact).toHaveBeenCalledWith("c1"));
  });
});
