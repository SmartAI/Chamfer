import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initTelemetry } from "./telemetry";
import "./index.css";

// Start error reporting as early as possible; it no-ops without VITE_SENTRY_DSN.
void initTelemetry();

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

// The hosted deployment (packages/online) builds with VITE_CHAMFER_ONLINE=1,
// which wraps the app in an auth gate. Local builds take the plain path and
// never ship the gate's chunk.
const online = import.meta.env.VITE_CHAMFER_ONLINE === "1";
const OnlineGate = online
  ? lazy(() => import("./online/OnlineGate").then((module) => ({ default: module.OnlineGate })))
  : null;

createRoot(rootElement).render(
  <StrictMode>
    {OnlineGate ? (
      <Suspense fallback={null}>
        <OnlineGate>
          <App />
        </OnlineGate>
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
