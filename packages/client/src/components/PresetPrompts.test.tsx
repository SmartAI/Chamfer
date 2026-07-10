import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PRESET_PROMPTS } from "@/presets";
import { PresetPrompts } from "./PresetPrompts";

describe("PresetPrompts", () => {
  it("renders one card per preset (easy, intermediate, hard) with label and prompt preview", () => {
    render(<PresetPrompts disabled={false} onSelect={vi.fn()} />);

    expect(PRESET_PROMPTS.map((p) => p.id)).toEqual(["easy", "intermediate", "hard"]);
    for (const preset of PRESET_PROMPTS) {
      const card = screen.getByTestId(`preset-${preset.id}`);
      expect(card.textContent).toContain(preset.label);
      expect(card.textContent).toContain(preset.prompt);
    }
  });

  it("forwards the full prompt text to onSelect on click", () => {
    const onSelect = vi.fn();
    render(<PresetPrompts disabled={false} onSelect={onSelect} />);

    for (const preset of PRESET_PROMPTS) {
      fireEvent.click(screen.getByTestId(`preset-${preset.id}`));
      expect(onSelect).toHaveBeenLastCalledWith(preset.prompt);
    }
    expect(onSelect).toHaveBeenCalledTimes(PRESET_PROMPTS.length);
  });

  it("disables all cards, swallows clicks, and shows the hint when disabled", () => {
    const onSelect = vi.fn();
    render(<PresetPrompts disabled disabledHint="Configure a model first" onSelect={onSelect} />);

    for (const preset of PRESET_PROMPTS) {
      expect((screen.getByTestId(`preset-${preset.id}`) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId("preset-easy"));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByTestId("preset-disabled-hint").textContent).toContain("Configure a model first");
  });
});
