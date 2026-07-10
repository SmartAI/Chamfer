import { Hono } from "hono";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelInfoDto, Provider } from "@chamfer/shared";
import { FAKE_MODEL } from "../fakeLlm";

const BYOK_PROVIDERS: Provider[] = ["anthropic", "openai", "google"];

export function modelsRoutes(fakeMode = process.env.CHAMFER_FAKE_LLM === "1"): Hono {
  const app = new Hono();

  app.get("/api/models", (c) => {
    if (fakeMode) {
      return c.json<ModelInfoDto[]>([
        {
          provider: FAKE_MODEL.provider,
          id: FAKE_MODEL.id,
          name: FAKE_MODEL.name,
          modelJson: JSON.stringify(FAKE_MODEL),
        },
      ]);
    }
    const models = builtinModels();
    const list: ModelInfoDto[] = [];
    for (const provider of BYOK_PROVIDERS) {
      for (const model of models.getModels(provider)) {
        list.push({
          provider,
          id: model.id,
          name: model.name || model.id,
          modelJson: JSON.stringify(model),
        });
      }
    }
    return c.json(list);
  });

  return app;
}
