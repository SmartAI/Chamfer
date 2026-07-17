import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as rest from "@/api/rest";
import { ResultFeedback } from "./ResultFeedback";

vi.mock("@/api/rest", () => ({
  getLatestAgentRun: vi.fn(),
  postAgentRunFeedback: vi.fn(),
}));

describe("ResultFeedback", () => {
  beforeEach(() => {
    vi.mocked(rest.getLatestAgentRun).mockResolvedValue({ id: "run-1", status: "completed" } as never);
    vi.mocked(rest.postAgentRunFeedback).mockResolvedValue({
      rating: "positive",
      createdAt: 1,
      syncStatus: "unavailable",
    });
  });

  it("links a concise rating to the latest completed result without exposing its identifiers", async () => {
    render(<ResultFeedback conversationId="conversation-1" resultKey={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Helpful result" }));
    await waitFor(() => {
      expect(rest.postAgentRunFeedback).toHaveBeenCalledWith("conversation-1", "run-1", "positive");
    });
    expect((await screen.findByTestId("result-feedback-confirmation")).textContent).toContain("Thanks for the feedback.");
    expect(document.body.textContent).not.toContain("run-1");
    expect(document.body.textContent).not.toContain("conversation-1");
  });

  it("keeps synchronization failures isolated in the feedback surface", async () => {
    vi.mocked(rest.postAgentRunFeedback).mockRejectedValue(new Error("offline"));
    render(<ResultFeedback conversationId="conversation-1" resultKey={2} />);
    fireEvent.click(await screen.findByRole("button", { name: "Unhelpful result" }));
    expect((await screen.findByTestId("result-feedback-error")).textContent).toContain("could not be saved");
  });
});
