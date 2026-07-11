import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

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
