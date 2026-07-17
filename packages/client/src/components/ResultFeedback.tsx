import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import type { AgentRunFeedbackRating } from "@chamfer/shared";
import * as rest from "@/api/rest";

export function ResultFeedback({ conversationId, resultKey }: {
  conversationId: string;
  resultKey: number;
}) {
  const [runId, setRunId] = useState<string>();
  const [state, setState] = useState<"loading" | "ready" | "submitting" | "submitted" | "error">("loading");

  useEffect(() => {
    let current = true;
    setState("loading");
    setRunId(undefined);
    void rest.getLatestAgentRun(conversationId)
      .then((run) => {
        if (!current || run.status !== "completed") return;
        setRunId(run.id);
        setState("ready");
      })
      .catch(() => {
        if (current) setState("error");
      });
    return () => { current = false; };
  }, [conversationId, resultKey]);

  async function rate(rating: AgentRunFeedbackRating) {
    if (!runId || state !== "ready") return;
    setState("submitting");
    try {
      await rest.postAgentRunFeedback(conversationId, runId, rating);
      setState("submitted");
    } catch {
      setState("error");
    }
  }

  if (state === "loading") return null;
  if (state === "submitted") {
    return <p data-testid="result-feedback-confirmation" className="text-xs text-muted-foreground">Thanks for the feedback.</p>;
  }
  if (state === "error") {
    return <p data-testid="result-feedback-error" className="text-xs text-muted-foreground">Feedback could not be saved.</p>;
  }
  return (
    <div data-testid="result-feedback" className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>Was this result helpful?</span>
      <button
        type="button"
        aria-label="Helpful result"
        title="Helpful result"
        disabled={state === "submitting"}
        onClick={() => void rate("positive")}
        className="rounded p-1 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label="Unhelpful result"
        title="Unhelpful result"
        disabled={state === "submitting"}
        onClick={() => void rate("negative")}
        className="rounded p-1 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
