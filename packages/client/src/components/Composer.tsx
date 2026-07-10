import { useRef, useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface ComposerProps {
  disabled: boolean;
  disabledHint?: string;
  onSend: (text: string, images: File[]) => void;
}

interface PendingImage {
  id: number;
  file: File;
  /** data: URL used only for the thumbnail preview. */
  previewUrl: string;
}

function readPreviewUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("failed to read image"));
    reader.readAsDataURL(file);
  });
}

let nextImageId = 0;

export function Composer({ disabled, disabledHint, onSend }: ComposerProps) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function addFiles(candidates: Iterable<File>) {
    const files = Array.from(candidates).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    const entries = await Promise.all(
      files.map(async (file) => {
        nextImageId += 1;
        return { id: nextImageId, file, previewUrl: await readPreviewUrl(file) };
      }),
    );
    setImages((prev) => [...prev, ...entries]);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.files) void addFiles(e.target.files);
    // Reset so picking the same file again re-triggers change.
    e.target.value = "";
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  }

  function handleSend() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(
      trimmed,
      images.map((image) => image.file),
    );
    setValue("");
    setImages([]);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const hint =
    disabled && disabledHint
      ? disabledHint
      : !disabled && images.length > 0 && value.trim().length === 0
        ? "Add a message to send images"
        : undefined;

  return (
    <div data-testid="composer" className="flex shrink-0 flex-col gap-1.5 border-t p-3">
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((image) => (
            <div key={image.id} data-testid="composer-attachment" className="relative">
              <img
                src={image.previewUrl}
                alt={image.file.name}
                className="h-16 w-16 rounded-md border object-cover"
              />
              <button
                type="button"
                data-testid="composer-attachment-remove"
                aria-label={`Remove ${image.file.name}`}
                className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5 shadow-sm hover:bg-accent"
                onClick={() => setImages((prev) => prev.filter((p) => p.id !== image.id))}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          data-testid="composer-file-input"
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="composer-attach"
          aria-label="Attach image"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <textarea
          data-testid="composer-input"
          className="min-h-[2.5rem] flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          placeholder="Message Chamfer..."
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          rows={1}
        />
        <Button
          type="button"
          data-testid="composer-send"
          disabled={disabled || value.trim().length === 0}
          onClick={handleSend}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
