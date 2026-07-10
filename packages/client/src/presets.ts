/**
 * Verified preset CAD prompts shown on the empty chat states. Every prompt's exact
 * wording has been proven to build successfully against the real agent before shipping;
 * edit with care and re-verify if the wording changes.
 */
export interface PresetPrompt {
  id: "easy" | "intermediate" | "hard";
  label: string;
  description: string;
  prompt: string;
}

export const PRESET_PROMPTS: PresetPrompt[] = [
  {
    id: "easy",
    label: "Cylindrical spacer",
    description: "A simple turned part with chamfered edges.",
    prompt:
      "Model a cylindrical spacer: 20 mm outer diameter, 8 mm inner bore, 15 mm tall, with 1 mm chamfers on both outer end edges.",
  },
  {
    id: "intermediate",
    label: "Mounting plate",
    description: "A flat plate with a corner bolt pattern.",
    prompt:
      "Design a simple rectangular mounting plate, 80 x 50 x 6 mm, with four 5.5 mm through-holes, each 8 mm from the two nearest edges at every corner.",
  },
  {
    id: "hard",
    label: "Drawer handle",
    description: "A swept multi-feature handle with standoffs and screw holes.",
    prompt:
      "Design a curved drawer handle: sweep a D-shaped profile along a gentle 110 mm arc to form the grip bar, join each end to a 16 mm diameter, 12 mm tall cylindrical standoff, and put a 4 mm screw hole through each standoff.",
  },
];
