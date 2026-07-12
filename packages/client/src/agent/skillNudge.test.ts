import { describe, expect, it } from "vitest";
import { skillNudgeBlock, skillNudgeLine, SKILL_HINT_PREFIX, SKILL_NUDGE_RULES } from "./skillNudge";
import { findSkill } from "./skillRegistry";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const runFailure = (text: string) => ({
  role: "toolResult",
  toolName: "run_build123d",
  content: [{ type: "text", text: `Verify gate: FAILED\n${text}` }],
});
const runError = (text: string) => ({
  role: "toolResult",
  toolName: "run_build123d",
  isError: true,
  content: [{ type: "text", text }],
});
const skillLoaded = (skill: string) => ({
  role: "toolResult",
  toolName: "load_skill",
  content: [{ type: "text", text: "..." }],
  details: { skill, loaded: true },
});

const SWEEP_ERROR = "TypeError: sweep() profile is not planar";

describe("skill nudge", () => {
  it("maps every rule to a skill that actually exists", () => {
    for (const rule of SKILL_NUDGE_RULES) {
      expect(findSkill(rule.skill), rule.skill).toBeDefined();
    }
  });

  it("points the repeated session-derived multiple-bodies failure at the disjoint-solids recipe", () => {
    const failure = "bodies: expected 1, found 3";
    const messages = [user("add two internal bosses"), runFailure(`- ${failure}`)];

    expect(skillNudgeLine(messages, `Verify gate: FAILED\n- ${failure}`)).toBe(
      `${SKILL_HINT_PREFIX} load_skill("recover-disjoint-solids") covers this failure pattern.`,
    );
  });

  it("stays silent on the first matching failure and fires on the second", () => {
    const first = skillNudgeLine([user("make a handle")], SWEEP_ERROR);
    expect(first).toBeUndefined();

    const second = skillNudgeLine([user("make a handle"), runError(SWEEP_ERROR)], SWEEP_ERROR);
    expect(second).toBe(`${SKILL_HINT_PREFIX} load_skill("sweep-and-loft") covers this failure pattern.`);
  });

  it("counts gate failures and tracebacks alike, but only within the current turn", () => {
    const previousTurn = [user("try one"), runError(SWEEP_ERROR), user("try again")];
    expect(skillNudgeLine(previousTurn, SWEEP_ERROR)).toBeUndefined();

    const gateThenError = [user("handle"), runFailure("- bodies: sweep produced 2 solids")];
    expect(skillNudgeLine(gateThenError, SWEEP_ERROR)).toContain("sweep-and-loft");
  });

  it("does not count a session-injected nudge as a turn boundary", () => {
    const messages = [user("handle"), runError(SWEEP_ERROR), user("[Chamfer self-check] verify the request")];
    expect(skillNudgeLine(messages, SWEEP_ERROR)).toContain("sweep-and-loft");
  });

  it("suppresses the hint once the skill is loaded and for unmapped failures", () => {
    const loaded = [user("handle"), skillLoaded("sweep-and-loft"), runError(SWEEP_ERROR)];
    expect(skillNudgeLine(loaded, SWEEP_ERROR)).toBeUndefined();

    const unmapped = [user("plate"), runFailure("- wall_thickness on base: minimum 0.4 below 1.2 mm")];
    expect(skillNudgeLine(unmapped, "Verify gate: FAILED\n- wall_thickness on base: minimum 0.4 below 1.2 mm")).toBeUndefined();
  });

  it("builds the afterToolCall block only for failing results", () => {
    const prior = [user("handle"), runError(SWEEP_ERROR)];
    const failing = skillNudgeBlock(prior, { content: [{ type: "text", text: `Verify gate: FAILED\n${SWEEP_ERROR}` }] }, false);
    expect(failing?.text).toContain("sweep-and-loft");

    const passing = skillNudgeBlock(prior, { content: [{ type: "text", text: "Verify gate: PASSED sweep ok" }] }, false);
    expect(passing).toBeUndefined();

    const errored = skillNudgeBlock(prior, { content: [{ type: "text", text: SWEEP_ERROR }] }, true);
    expect(errored?.text).toContain("sweep-and-loft");
  });
});
