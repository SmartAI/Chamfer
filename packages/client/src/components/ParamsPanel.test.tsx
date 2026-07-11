import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParamSpec } from "@chamfer/shared";
import { ParamsPanel } from "./ParamsPanel";

const WIDTH_SPEC: ParamSpec = {
  name: "overall_width",
  value: 100,
  min: 10,
  max: 120,
  description: "Overall width in mm",
};

/** The panel mounts collapsed by default; most tests exercise the expanded controls. */
function renderExpanded(ui: Parameters<typeof render>[0]): ReturnType<typeof render> {
  const result = render(ui);
  fireEvent.click(screen.getByTestId("params-panel-toggle"));
  return result;
}

async function flushDebounce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}

/** A promise settled from the outside, for holding a commit in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: unknown) => void } {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("ParamsPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders a drag grip so the floating panel can be moved", () => {
    render(<ParamsPanel params={[WIDTH_SPEC]} onChange={vi.fn(async () => {})} />);

    const grip = screen.getByTestId("params-drag-handle");
    expect(grip.hasAttribute("data-drag-handle")).toBe(true);
  });

  it("commits a slider change (debounced) with the full value map", async () => {
    const onChange = vi.fn(async () => {});
    renderExpanded(<ParamsPanel params={[WIDTH_SPEC]} onChange={onChange} />);

    const row = screen.getByTestId("param-overall_width");
    expect(row.textContent).toContain("overall_width");

    // Keyboard slide to max: Radix commits keyboard-driven value changes, so
    // this exercises the same onValueCommit path as a pointer-drag release.
    const thumb = screen.getByRole("slider");
    fireEvent.keyDown(thumb, { key: "End" });

    // Commit is debounced: nothing fires immediately.
    expect(onChange).not.toHaveBeenCalled();

    await flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ overall_width: 120 });
  });

  it("commits a numeric input edit on Enter and shows both controls' current value", async () => {
    const onChange = vi.fn(async () => {});
    renderExpanded(<ParamsPanel params={[WIDTH_SPEC]} onChange={onChange} />);

    const input = screen.getByTestId("param-input-overall_width") as HTMLInputElement;
    expect(input.value).toBe("100");
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("100");

    fireEvent.change(input, { target: { value: "42" } });
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("42");
    fireEvent.keyDown(input, { key: "Enter" });
    await flushDebounce();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ overall_width: 42 });
  });

  it("skips no-op commits (blur without an edit)", async () => {
    const onChange = vi.fn(async () => {});
    renderExpanded(<ParamsPanel params={[WIDTH_SPEC]} onChange={onChange} />);

    fireEvent.blur(screen.getByTestId("param-input-overall_width"));
    await flushDebounce();

    expect(onChange).not.toHaveBeenCalled();
  });

  it("starts collapsed and expands the parameter controls on demand", () => {
    render(<ParamsPanel params={[WIDTH_SPEC]} onChange={vi.fn(async () => {})} />);

    const toggle = screen.getByTestId("params-panel-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("param-overall_width")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("param-overall_width")).toBeTruthy();

    fireEvent.click(toggle);
    expect(screen.queryByTestId("param-overall_width")).toBeNull();
  });

  it("shows a Python error inline and keeps the controls usable", async () => {
    const onChange = vi
      .fn<(values: Record<string, number>) => Promise<void>>()
      .mockRejectedValueOnce(new Error("NameError: name 'Bax' is not defined"))
      .mockResolvedValue(undefined);
    renderExpanded(<ParamsPanel params={[WIDTH_SPEC]} onChange={onChange} />);

    const input = screen.getByTestId("param-input-overall_width");
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    await flushDebounce();

    const error = screen.getByTestId("param-error");
    expect(error.textContent).toContain("NameError");

    // The controls stay usable: a follow-up commit goes through and clears
    // the inline error.
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.blur(input);
    await flushDebounce();

    expect(onChange).toHaveBeenLastCalledWith({ overall_width: 60 });
    expect(screen.queryByTestId("param-error")).toBeNull();
  });

  it("clears the stale error of an older in-flight commit once a newer commit succeeds", async () => {
    const commitA = deferred();
    const commitB = deferred();
    const onChange = vi
      .fn<(values: Record<string, number>) => Promise<void>>()
      .mockReturnValueOnce(commitA.promise)
      .mockReturnValueOnce(commitB.promise);
    renderExpanded(<ParamsPanel params={[WIDTH_SPEC]} onChange={onChange} />);

    const input = screen.getByTestId("param-input-overall_width");

    // Commit A dispatches and stays in flight.
    fireEvent.change(input, { target: { value: "50" } });
    fireEvent.blur(input);
    await flushDebounce();
    expect(onChange).toHaveBeenCalledTimes(1);

    // Commit B dispatches while A is still pending.
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.blur(input);
    await flushDebounce();
    expect(onChange).toHaveBeenCalledTimes(2);

    // Commits settle FIFO: A rejects first and its error shows...
    await act(async () => {
      commitA.reject(new Error("NameError: name 'Bax' is not defined"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("param-error").textContent).toContain("NameError");

    // ...then B succeeds, which must clear A's now-stale error.
    await act(async () => {
      commitB.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByTestId("param-error")).toBeNull();
  });

  it("keeps an edit made during a commit's flight when the post-commit re-parse lands mid-debounce", async () => {
    const onChange = vi
      .fn<(values: Record<string, number>) => Promise<void>>()
      .mockResolvedValue(undefined);
    const { rerender } = renderExpanded(<ParamsPanel params={[WIDTH_SPEC]} onChange={onChange} />);

    const input = screen.getByTestId("param-input-overall_width") as HTMLInputElement;

    // First commit: 100 -> 60.
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.blur(input);
    await flushDebounce();
    expect(onChange).toHaveBeenCalledWith({ overall_width: 60 });

    // User edits to 70; while its debounce window is open, the first commit's
    // re-parse lands as a new params prop (value 60).
    fireEvent.change(input, { target: { value: "70" } });
    fireEvent.blur(input);
    rerender(<ParamsPanel params={[{ ...WIDTH_SPEC, value: 60 }]} onChange={onChange} />);

    // The pending edit is still visible, not reset to the re-parsed 60...
    expect(input.value).toBe("70");

    // ...and its debounced commit still dispatches instead of being skipped
    // as a no-op against the resynced values.
    await flushDebounce();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ overall_width: 70 });
  });
});
