import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertPortsAvailable, evaluationStackEnvironment } from "./stack";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("fresh evaluation stack", () => {
  it("removes inherited model and observability credentials from scripted stacks", () => {
    const environment = evaluationStackEnvironment({
      CHAMFER_MODEL: "real-model",
      CHAMFER_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "private",
      LANGFUSE_SECRET_KEY: "private",
    }, true);

    expect(environment).toMatchObject({
      CHAMFER_MODEL: "",
      CHAMFER_PROVIDER: "",
      ANTHROPIC_API_KEY: "",
      LANGFUSE_SECRET_KEY: "",
    });
  });

  it("rejects a stale listener before launching the product", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");

    await expect(assertPortsAvailable([address.port])).rejects.toThrow(/stale listener/i);
  });
});
