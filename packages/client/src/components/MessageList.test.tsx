import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";
import * as rest from "../api/rest";

vi.mock("../api/rest", () => ({
  downloadAttachment: vi.fn(),
  listAttachments: vi.fn(async () => []),
  attachmentUrl: (id: string) => `/api/attachments/${id}`,
}));

function userMessage(text: string) {
  return { role: "user", content: text };
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function setScrollTop(list: HTMLElement, value: number) {
  Object.defineProperty(list, "scrollTop", { value, writable: true, configurable: true });
  fireEvent.scroll(list);
}

/** Simulates the user having scrolled up: land at the bottom first (as the
 * autoscroll leaves us), then move the viewport upward away from it. */
function scrollUp(list: HTMLElement) {
  Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
  setScrollTop(list, 590);
  setScrollTop(list, 100);
}

describe("MessageList scroll anchoring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("autoscrolls to the bottom while the user is pinned there", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <MessageList messages={[userMessage("hi")]} streaming={false} />,
    );
    spy.mockClear();

    rerender(
      <MessageList messages={[userMessage("hi"), assistantMessage("hello")]} streaming={false} />,
    );

    expect(spy).toHaveBeenCalled();
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("does not autoscroll when the user has scrolled up; shows a jump pill instead", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <MessageList messages={[userMessage("hi")]} streaming={true} />,
    );
    scrollUp(screen.getByTestId("message-list"));
    spy.mockClear();

    rerender(
      <MessageList messages={[userMessage("hi"), assistantMessage("streaming…")]} streaming={true} />,
    );

    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId("jump-to-latest")).toBeTruthy();
  });

  it("jump pill scrolls to the latest message and re-pins", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <MessageList messages={[userMessage("hi")]} streaming={true} />,
    );
    scrollUp(screen.getByTestId("message-list"));
    rerender(
      <MessageList messages={[userMessage("hi"), assistantMessage("more")]} streaming={true} />,
    );
    spy.mockClear();

    fireEvent.click(screen.getByTestId("jump-to-latest"));

    expect(spy).toHaveBeenCalled();
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("scrolling back to the bottom dismisses the jump pill and re-pins", () => {
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <MessageList messages={[userMessage("hi")]} streaming={true} />,
    );
    const list = screen.getByTestId("message-list");
    scrollUp(list);
    rerender(
      <MessageList messages={[userMessage("hi"), assistantMessage("more")]} streaming={true} />,
    );
    expect(screen.getByTestId("jump-to-latest")).toBeTruthy();

    // Back at the bottom (scrollHeight - scrollTop - clientHeight < threshold).
    Object.defineProperty(list, "scrollTop", { value: 600, writable: true, configurable: true });
    fireEvent.scroll(list);
    spy.mockClear();

    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
    rerender(
      <MessageList messages={[userMessage("hi"), assistantMessage("more"), assistantMessage("even more")]} streaming={true} />,
    );
    expect(spy).toHaveBeenCalled();
  });

  it("stays pinned through downward scroll events that have not reached the bottom yet", () => {
    // Regression: the smooth jump-to-latest animation fires intermediate scroll
    // events far from the bottom. Moving *down* must never unpin, or content
    // landing mid-animation strands the view.
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    const { rerender } = render(
      <MessageList messages={[userMessage("hi")]} streaming={true} />,
    );
    const list = screen.getByTestId("message-list");
    Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    setScrollTop(list, 200); // downward from 0, gap 400px >= threshold
    spy.mockClear();

    rerender(
      <MessageList messages={[userMessage("hi"), assistantMessage("landed mid-flight")]} streaming={true} />,
    );

    expect(spy).toHaveBeenCalled();
    expect(screen.queryByTestId("jump-to-latest")).toBeNull();
  });

  it("re-glues when content grows without a messages change, only while pinned", () => {
    const roCallbacks: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          roCallbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const spy = vi.spyOn(Element.prototype, "scrollIntoView");
    render(<MessageList messages={[userMessage("hi")]} streaming={true} />);
    expect(roCallbacks.length).toBeGreaterThan(0);
    spy.mockClear();

    // Pinned (default): growth (e.g. a view-sheet image decoding) re-glues.
    roCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    expect(spy).toHaveBeenCalled();

    // Unpinned: growth must not yank the user back down.
    scrollUp(screen.getByTestId("message-list"));
    spy.mockClear();
    roCallbacks.forEach((callback) => callback([], {} as ResizeObserver));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("MessageList CAD code visibility", () => {
  const fenced = assistantMessage("Here is the part:\n\n```python\nresult = Box(2, 2, 2)\n```\n");

  it("collapses python fences to a label-and-actions row by default", () => {
    render(<MessageList messages={[fenced]} streaming={false} />);

    expect(screen.queryByText(/result = Box\(2, 2, 2\)/)).toBeNull();
    expect(screen.getByText("CAD code")).toBeTruthy();
    expect(screen.getByLabelText("Copy code")).toBeTruthy();
  });

  it("shows python fence bodies when showCadCode is set", () => {
    render(<MessageList messages={[fenced]} streaming={false} showCadCode />);

    expect(screen.getByText(/result = Box\(2, 2, 2\)/)).toBeTruthy();
    expect(screen.getByText("CAD code")).toBeTruthy();
  });

  it("renders a generic tool-call card for tool calls", () => {
    const withTool = {
      role: "assistant",
      content: [
        { type: "text", text: "Building." },
        { type: "toolCall", id: "tc-1", name: "execute", arguments: { code: "result = Box(3, 3, 3)" } },
      ],
    };
    render(<MessageList messages={[withTool]} streaming={false} />);
    expect(screen.getByTestId("tool-call-card")).toBeTruthy();
    expect(screen.getByText("Execute")).toBeTruthy();
  });

  it("marks a result-less tool call failed when its assistant generation failed", () => {
    render(
      <MessageList
        messages={[
          {
            role: "assistant",
            content: [
              { type: "text", text: "I'll classify the reference." },
              { type: "toolCall", id: "classify-1", name: "classify_reference", arguments: {} },
            ],
            stopReason: "error",
            errorMessage: "network error",
          },
        ]}
        streaming={false}
        generationFailed
      />,
    );

    expect(screen.getByText("interrupted")).toBeTruthy();
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByText("done")).toBeNull();
  });

  it("leaves non-python fences untouched when hidden", () => {
    render(
      <MessageList
        messages={[assistantMessage('Config:\n\n```json\n{"bodies": 1}\n```\n')]}
        streaming={false}
      />,
    );

    expect(screen.getByText(/"bodies": 1/)).toBeTruthy();
  });
});

describe("MessageList attachment replay", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders a durable user attachment in its original content position", async () => {
    vi.mocked(rest.downloadAttachment).mockResolvedValue({
      type: "image",
      data: "pixels",
      mimeType: "image/png",
    });
    render(
      <MessageList
        messages={[
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "attachment-reference", attachmentId: "image-1", kind: "user-image", mimeType: "image/png" },
              { type: "text", text: "after" },
            ],
          },
        ]}
        streaming={false}
      />,
    );

    const image = await screen.findByTestId("message-user-image");
    expect(image.getAttribute("src")).toBe("data:image/png;base64,pixels");
    expect(screen.getByText("before").compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(image.compareDocumentPosition(screen.getByText("after")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ["missing", "Attachment missing"],
    ["corrupt", "Attachment corrupt"],
    ["unsupported-media", "Unsupported attachment"],
  ])("renders an explicit %s attachment state", async (reason, label) => {
    vi.mocked(rest.downloadAttachment).mockRejectedValue(new Error(reason));
    render(
      <MessageList
        messages={[
          {
            role: "user",
            content: [
              { type: "attachment-reference", attachmentId: `broken-${reason}`, kind: "user-image", mimeType: "image/png" },
            ],
          },
        ]}
        streaming={false}
      />,
    );

    expect(screen.getByTestId("attachment-loading")).toBeTruthy();
    expect(await screen.findByText(label)).toBeTruthy();
  });
});

describe("MessageList checklist rendering", () => {
  it("renders satisfied/missing checklist lines as icon rows, both prefix and suffix forms", () => {
    render(
      <MessageList
        messages={[
          assistantMessage(
            "Satisfied: four holes are present.\n\nNozzle bore: Not satisfied\n\nWidth: 10 mm: Satisfied",
          ),
        ]}
        streaming={false}
      />,
    );

    const passes = screen.getAllByTestId("checklist-pass");
    expect(passes).toHaveLength(2);
    expect(passes[0]!.textContent).toContain("four holes are present");
    expect(passes[0]!.textContent).not.toMatch(/satisfied/i);
    expect(passes[1]!.textContent).toContain("Width: 10 mm");

    const fail = screen.getByTestId("checklist-fail");
    expect(fail.textContent).toContain("Nozzle bore");
    expect(fail.textContent).not.toMatch(/satisfied/i);
  });

  it("recognizes verdicts wrapped in inline styling like backticks and bold", () => {
    render(
      <MessageList
        messages={[
          assistantMessage(
            "- `Satisfied` High-mounted swept main wing\n- **Not satisfied:** nose landing light\n- Twin propellers: `Satisfied`",
          ),
        ]}
        streaming={false}
      />,
    );

    const passes = screen.getAllByTestId("checklist-pass");
    expect(passes).toHaveLength(2);
    expect(passes[0]!.textContent).toContain("High-mounted swept main wing");
    expect(passes[1]!.textContent).toContain("Twin propellers");
    expect(passes[1]!.textContent).not.toMatch(/satisfied/i);
    expect(screen.getByTestId("checklist-fail").textContent).toContain("nose landing light");
  });

  it("leaves ordinary prose mentioning satisfaction untouched", () => {
    render(
      <MessageList
        messages={[assistantMessage("All of the requirements are satisfied.")]}
        streaming={false}
      />,
    );

    expect(screen.queryByTestId("checklist-pass")).toBeNull();
    expect(screen.queryByTestId("checklist-fail")).toBeNull();
    expect(screen.getByText(/All of the requirements are satisfied\./)).toBeTruthy();
  });
});

// Issue #53 defect 1: a turn-level failure is stored on the assistant row
// (stopReason "error" + errorMessage, usually with empty content). It must
// render as a visible error in the transcript - never an empty bubble plus a
// green "Done".
describe("MessageList math rendering", () => {
  it("renders single-dollar inline LaTeX as KaTeX instead of raw source", () => {
    const { container } = render(
      <MessageList
        messages={[assistantMessage("Volume: $3897.67 \\text{ mm}^3$ measured.")]}
        streaming={false}
      />,
    );

    // The KaTeX markup keeps the raw TeX inside a hidden MathML annotation, so
    // assert on the delimiters: parsed math leaves no literal "$" behind.
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).not.toContain("$");
  });

  it("renders double-dollar display math blocks", () => {
    const { container } = render(
      <MessageList
        messages={[assistantMessage("$$\n\\pi \\cdot (10^2 - 4^2) \\cdot 15\n$$")]}
        streaming={false}
      />,
    );

    expect(container.querySelector(".katex-display")).not.toBeNull();
  });
});

describe("MessageList turn error rendering", () => {
  const erroredRow = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: 'HTTP 403: "This deployment has no shared demo key. Add your own API key in Settings."',
  };

  it("renders the stored error visibly instead of an empty bubble", () => {
    render(<MessageList messages={[userMessage("make a box"), erroredRow]} streaming={false} />);

    const note = screen.getByTestId("assistant-error");
    expect(note.textContent).toContain("no shared demo key");
    expect(note.textContent).toContain("Add your own API key in Settings");
  });

  it("does not report Done when the turn ended in an error", () => {
    render(<MessageList messages={[userMessage("make a box"), erroredRow]} streaming={false} />);

    expect(screen.queryByTestId("generation-status")).toBeNull();
  });

  it("falls back to a generic message when the row carries no errorMessage", () => {
    render(
      <MessageList
        messages={[{ role: "assistant", content: [], stopReason: "error" }]}
        streaming={false}
      />,
    );

    expect(screen.getByTestId("assistant-error").textContent).toContain("The model request failed");
  });

  it("keeps partial output visible alongside the error", () => {
    render(
      <MessageList
        messages={[
          {
            role: "assistant",
            content: [{ type: "text", text: "Starting the build" }],
            stopReason: "error",
            errorMessage: "connection reset",
          },
        ]}
        streaming={false}
      />,
    );

    expect(screen.getByText(/Starting the build/)).toBeTruthy();
    expect(screen.getByTestId("assistant-error").textContent).toContain("connection reset");
  });

  it("leaves ordinary assistant rows untouched", () => {
    render(<MessageList messages={[assistantMessage("all good")]} streaming={false} />);
    expect(screen.queryByTestId("assistant-error")).toBeNull();
    expect(screen.getByTestId("generation-status").textContent).toContain("Done");
  });
});
