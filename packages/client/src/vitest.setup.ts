import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom does not implement these; Radix UI components (Select, Dialog) call
// them during interaction, so stub them out for tests.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}

// jsdom does not implement Worker. AppStateProvider eagerly constructs a
// CadClient (which constructs a Worker) on mount, so components that render
// the app shell need a no-op stub present even when the worker itself is
// never exercised by the test.
if (typeof globalThis.Worker === "undefined") {
  class NoopWorker {
    onmessage: ((e: MessageEvent<unknown>) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    postMessage(): void {}
    terminate(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  // @ts-expect-error - minimal stub, not a full Worker implementation
  globalThis.Worker = NoopWorker;
}

// jsdom does not implement ResizeObserver; @react-three/fiber's Canvas uses
// it to size the WebGL viewport.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}
