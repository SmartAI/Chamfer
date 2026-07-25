import type { ImageBlobStore } from "./imageBlobStore";
import type { AgentSessionHost } from "./routes/agent";
import type { ArtifactStore } from "./agent/artifactStore";
import type { OnlineAgentHosting } from "../../online/src/onlineApp";

// Shared fixtures for the server-package tests that exercise createOnlineApp
// (onlineRouteParity, onlineConversationStatus). Route mounting and the
// conversation-list overlay only need the seams' shapes, not a live container
// or R2, so both suites lean on these stubs; keeping them here means a seam
// signature change touches one place, not each test.

/** A no-op image blob store for online-app tests that never touch attachments. */
export const stubBlobStore: ImageBlobStore = {
  write: async () => { throw new Error("unused"); },
  read: async () => { throw new Error("unused"); },
  remove: () => {},
  maintain: () => ({ fileSystemBefore: [], fileSystemAfter: [], removed: [], failed: [] }),
};

/** A hosting seam for online-app tests: an idle session host plus an artifact
 * store that reports the given conversation ids as having a produced model (an
 * R2 HEAD hit in production). Defaults to no artifacts. */
export function stubOnlineHosting(artifactsFor: Set<string> = new Set()): OnlineAgentHosting {
  return {
    sessions: {
      prompt: async () => {},
      abort: async () => {},
      subscribe: () => () => {},
      status: () => ({ running: false }),
    } satisfies AgentSessionHost,
    artifacts: {
      record: async () => ({ revision: 1, updated: true }),
      current: async () => undefined,
      exists: async (conversationId: string) => artifactsFor.has(conversationId),
    } satisfies ArtifactStore,
  };
}
