import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

// jsdom does not implement these; Radix UI components (Select, Dialog) call
// them during interaction, so stub them out for tests.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof Element !== "undefined" && !Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element !== "undefined" && !Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (typeof Element !== "undefined" && !Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}

// This jsdom setup ships without window.localStorage; components that persist
// UI state (workspace layout, draggable overlays) need a real-enough store.
if (typeof window !== "undefined" && !window.localStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
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

// jsdom does not implement object URLs; the viewer's export menu creates one
// per downloaded file.
if (typeof URL !== "undefined" && !URL.createObjectURL) {
  URL.createObjectURL = () => "blob:vitest";
  URL.revokeObjectURL = () => {};
}

// jsdom does not implement matchMedia; WorkspaceLayout queries it to pick the
// mobile layout. Default to desktop (matches: false) so component tests render
// the resizable grid unless they override this.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
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
