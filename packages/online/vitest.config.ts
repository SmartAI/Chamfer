import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// vitest runs on plain Node, which cannot resolve workerd's built-in
// cloudflare:workers module. @cloudflare/containers imports it statically and
// worker.ts exports the container class, so worker imports need this alias to
// a minimal stub; tests never instantiate the stubbed classes.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./src/cloudflareWorkersStub.ts", import.meta.url)),
    },
  },
});
