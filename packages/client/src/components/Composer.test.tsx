import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";

function makeImageFile(name = "sketch.png"): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: "image/png" });
}

describe("Composer", () => {
  it("choosing a file shows a removable thumbnail, and removing clears it", async () => {
    render(<Composer disabled={false} onSend={vi.fn()} />);

    const input = screen.getByTestId("composer-file-input");
    fireEvent.change(input, { target: { files: [makeImageFile()] } });

    const thumbnail = await screen.findByTestId("composer-attachment");
    expect(thumbnail).toBeTruthy();
    expect(thumbnail.querySelector("img")).toBeTruthy();

    fireEvent.click(screen.getByTestId("composer-attachment-remove"));
    expect(screen.queryByTestId("composer-attachment")).toBeNull();
  });

  it("send passes the attached files to onSend and clears the attachments", async () => {
    const onSend = vi.fn();
    render(<Composer disabled={false} onSend={onSend} />);

    const file = makeImageFile();
    fireEvent.change(screen.getByTestId("composer-file-input"), { target: { files: [file] } });
    await screen.findByTestId("composer-attachment");

    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "like this" } });
    fireEvent.click(screen.getByTestId("composer-send"));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("like this", [file]);
    expect(screen.queryByTestId("composer-attachment")).toBeNull();
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("pasting an image into the textarea adds a thumbnail", async () => {
    render(<Composer disabled={false} onSend={vi.fn()} />);

    fireEvent.paste(screen.getByTestId("composer-input"), {
      clipboardData: { files: [makeImageFile("pasted.png")] },
    });

    expect(await screen.findByTestId("composer-attachment")).toBeTruthy();
  });

  it("the attach button opens a hidden image file input", () => {
    render(<Composer disabled={false} onSend={vi.fn()} />);

    const input = screen.getByTestId("composer-file-input") as HTMLInputElement;
    expect(input.type).toBe("file");
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);

    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByTestId("composer-attach"));
    expect(click).toHaveBeenCalledTimes(1);
  });
});
