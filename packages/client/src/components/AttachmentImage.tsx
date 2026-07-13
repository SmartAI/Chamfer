import { useEffect, useState } from "react";
import { ImageOff, LoaderCircle } from "lucide-react";
import type { AttachmentReferenceBlock } from "@chamfer/shared";
import * as rest from "@/api/rest";
import { cn } from "@/lib/utils";

interface AttachmentImageProps {
  reference: AttachmentReferenceBlock;
  alt: string;
  testId: string;
  className?: string;
}

function failureLabel(reason: string): string {
  if (reason.includes("unsupported-media")) return "Unsupported attachment";
  if (reason.includes("corrupt")) return "Attachment corrupt";
  if (reason.includes("missing") || reason.includes("not found")) return "Attachment missing";
  if (reason.includes("path-rejected")) return "Attachment blocked";
  return "Attachment unavailable";
}

export function AttachmentImage({ reference, alt, testId, className }: AttachmentImageProps) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});

  useEffect(() => {
    let cancelled = false;
    setState({});
    void rest
      .downloadAttachment(reference.attachmentId, reference.mimeType)
      .then((image) => {
        if (!cancelled) setState({ url: `data:${image.mimeType};base64,${image.data}` });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ error: failureLabel(error instanceof Error ? error.message : String(error)) });
      });
    return () => {
      cancelled = true;
    };
  }, [reference.attachmentId, reference.mimeType]);

  if (state.error) {
    return (
      <span className="flex min-h-20 min-w-32 items-center justify-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <ImageOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        {state.error}
      </span>
    );
  }
  if (!state.url) {
    return (
      <span
        data-testid="attachment-loading"
        className="flex min-h-20 min-w-32 items-center justify-center rounded-md border bg-muted/30"
        aria-label="Loading attachment"
      >
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
      </span>
    );
  }
  return <img data-testid={testId} src={state.url} alt={alt} className={cn(className)} />;
}
