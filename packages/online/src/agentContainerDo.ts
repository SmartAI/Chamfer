import { Container } from "@cloudflare/containers";
import {
  AGENT_CONTAINER_PORT,
  AGENT_CONTAINER_SLEEP_AFTER,
  agentContainerBootEnv,
} from "./agentContainer";
import type { OnlineEnv } from "./env";

/** One agent container per user (issue #50, ADR 0003): the Durable Object
 * behind the AGENT_CONTAINER binding, running the #47 image (wrangler.jsonc
 * containers block, instance_type standard-1). Instances are named by
 * agentContainerName, so compute isolation follows the user-id boundary of
 * ChamferUserDurableObject. The container is stateless compute; nothing here
 * may become a store of record. */
export class ChamferAgentContainer extends Container<OnlineEnv> {
  defaultPort = AGENT_CONTAINER_PORT;
  sleepAfter = AGENT_CONTAINER_SLEEP_AFTER;

  constructor(ctx: ConstructorParameters<typeof Container>[0], env: OnlineEnv) {
    super(ctx, env);
    this.envVars = agentContainerBootEnv(env);
  }
}
