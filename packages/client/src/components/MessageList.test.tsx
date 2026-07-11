import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageList } from "./MessageList";

function userMessage(text: string) {
  return { role: "user", content: text };
}

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

/** Simulates the user having scrolled up: far from the bottom of the list. */
function scrollUp(list: HTMLElement) {
  Object.defineProperty(list, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
  Object.defineProperty(list, "scrollTop", { value: 100, writable: true, configurable: true });
  fireEvent.scroll(list);
}

describe("MessageList scroll anchoring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
});
