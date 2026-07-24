import { useEffect } from "react";
import { LoaderCircle } from "lucide-react";
import { Viewer } from "@/viewer/Viewer";
import { useAppState } from "@/state/appState";
import { useChatState } from "@/state/chatState";

/** Filename stem for exports: the conversation title reduced to a safe slug. */
function exportSlug(title: string | undefined): string {
  const slug = (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "model";
}

export function RightPanel() {
  const { geometry, artifactData, isLoadingArtifact } = useAppState();
  const { activeConversationId, conversations } = useChatState();
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);

  // BufferGeometry allocates GPU-side buffers that are not garbage collected;
  // dispose the outgoing geometry whenever a new artifact replaces it and on unmount.
  useEffect(() => {
    if (!geometry) return;
    return () => geometry.dispose();
  }, [geometry]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <Viewer geometry={geometry} artifactData={artifactData} exportName={exportSlug(activeConversation?.title)} />
        {isLoadingArtifact && (
          <div
            data-testid="viewer-rendering"
            className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 text-xs font-medium shadow-sm backdrop-blur-sm"
          >
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Loading model
          </div>
        )}
      </div>
    </div>
  );
}
