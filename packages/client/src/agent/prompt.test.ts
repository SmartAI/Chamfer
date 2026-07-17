import { describe, expect, it } from "vitest";
import { systemPrompt } from "./prompt";

describe("systemPrompt", () => {
  it("defines Chamfer as a multimodal CAD designer with outcome-first success criteria", () => {
    expect(systemPrompt).toContain("creates precise, manufacturable models from text, images, or both");
    expect(systemPrompt).toContain("## Goal and Success Criteria");
    expect(systemPrompt).toContain("image-based requests account for all readable visual evidence");
    expect(systemPrompt).toContain("Choose the fewest useful tool loops");
  });

  it("documents the allowed build123d API surface", () => {
    expect(systemPrompt).toContain("## Allowed API Surface");
    expect(systemPrompt).toContain("Builders: BuildPart, BuildSketch, BuildLine");
    expect(systemPrompt).toContain("Operations: extrude, revolve, loft, sweep, fillet, chamfer");
    expect(systemPrompt).toContain("Shape composition: Part algebra with +, -, and &");
  });

  it("contains a concrete DO NOT list for runtime-unsafe behavior", () => {
    expect(systemPrompt).toContain("## Runtime Boundaries");
    expect(systemPrompt).toContain("Do not use file I/O, network I/O, subprocesses");
    expect(systemPrompt).toContain("Do not call show, show_object");
    expect(systemPrompt).toContain("Do not rely on state, variables, files, or geometry from a previous run_build123d call");
  });

  it("requires multi-view and numeric verification before success", () => {
    expect(systemPrompt).toContain("## Verification Discipline");
    expect(systemPrompt).toContain("Inspect every view one at a time: isometric, front, back, left, right, top, and bottom");
    expect(systemPrompt).toContain("Numerically check each requested width, height, depth, diameter");
    expect(systemPrompt).toContain("read the full traceback and fix the first real cause");
  });

  it("keeps the canonical params example with the decimal hole diameter", () => {
    expect(systemPrompt).toContain("hole_diameter = 6.5  # [2, 12] Mounting hole diameter in mm");
  });

  it("specifies the agent-authored checks block and its full vocabulary", () => {
    expect(systemPrompt).toContain("# --- checks ---");
    expect(systemPrompt).toContain("CHECKS = [");
    for (const kind of ["hole_through", "hole_blind", "hole_internal", "clearance", "bbox", "volume", "wall_thickness", "count_faces", "count_edges", "symmetric"]) {
      expect(systemPrompt).toContain(kind);
    }
    expect(systemPrompt).toContain("at_mm [x, y, z]");
    expect(systemPrompt).toContain("symmetric");
    expect(systemPrompt).toContain("optional target (child label)");
    expect(systemPrompt).toContain("never weaken or delete a check to make the gate pass");
  });

  it("teaches the human build123d workflow: 2D first, fillets last, selectors, symmetry", () => {
    expect(systemPrompt).toContain("Resolve geometry in two dimensions before three");
    expect(systemPrompt).toContain("Apply fillets and chamfers last");
    expect(systemPrompt).toContain("never raw indices");
    expect(systemPrompt).toContain("Exploit symmetry");
  });

  it("requires full-request completion, not first-pass success", () => {
    expect(systemPrompt).toContain("A passing gate on a partial model is not completion");
    expect(systemPrompt).toContain("never stop after the first successful intermediate result");
  });

  it("defines how image evidence and text are reconciled", () => {
    expect(systemPrompt).toContain("treat the image as design evidence, not decoration");
    expect(systemPrompt).toContain("explicit text overrides an ambiguous visual inference");
    expect(systemPrompt).toContain("Do not invent hidden geometry");
  });

  it("requires source specifications before the first text design plan", () => {
    expect(systemPrompt).toContain("Before create_plan, call record_source_specifications");
    expect(systemPrompt).toContain("exact unique quote");
    expect(systemPrompt).toContain("for each text requirement");
  });

  it("requires durable reference specifications before image classification", () => {
    expect(systemPrompt).toContain("Before classify_reference, call record_reference_specifications");
    expect(systemPrompt).toContain("Pass active specificationIds to classify_reference");
    expect(systemPrompt).toContain("noSpecificationReason");
    expect(systemPrompt).toContain("supersedesSpecificationId");
    expect(systemPrompt).toContain("refresh affected classifications");
  });

  it("prioritizes fidelity and requires a dominant-form review", () => {
    const size = systemPrompt.indexOf("absolute size");
    const census = systemPrompt.indexOf("feature census");
    const form = systemPrompt.indexOf("overall form");
    const cosmetic = systemPrompt.indexOf("cosmetic detail");
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(census);
    expect(census).toBeLessThan(form);
    expect(form).toBeLessThan(cosmetic);
    expect(systemPrompt).toContain("A blocky envelope meeting the numbers is not close enough");
    expect(systemPrompt).toContain("faceted-versus-curved is not cosmetic");
    expect(systemPrompt).toContain("thin-walled shell, cored housing, axisymmetric, organic casting, or prismatic");
    expect(systemPrompt).toContain("Validity is not fidelity");
  });

  it("documents recovery discipline, interpretation defaults, and the mechanical plan contract", () => {
    expect(systemPrompt).toContain("attempt a second construction strategy before simplifying");
    expect(systemPrompt).toContain("Reverting to simpler geometry is a last resort");
    expect(systemPrompt).toContain("An explicit depth callout means a blind feature by default");
    expect(systemPrompt).toContain("legacy plan contract is mechanical: weakening requires revision_reason");
    expect(systemPrompt).toContain("Chamfer owns revision text, tombstones, and refit flags");
    expect(systemPrompt).toContain("Run CHECKS conformance");
    expect(systemPrompt).toContain("blocked_reason");
    expect(systemPrompt).toContain("form_review");
    expect(systemPrompt).toContain("revise_plan atomic operations only");
    expect(systemPrompt).toContain("Chamfer owns stable identities, revisions, retirement, and history");
    expect(systemPrompt).toContain("Never call update_plan");
    expect(systemPrompt).toContain("binds form_review evidence_id to the latest eligible gate-passed run");
    expect(systemPrompt).toContain("fresh standalone revision_reason");
    expect(systemPrompt).toContain("preserves the exact accepted history");
    expect(systemPrompt).toContain("hi <= 1.5 * lo");
  });

  it("points verification at the new diagnostics", () => {
    expect(systemPrompt).toContain("holes (every detected bore");
    expect(systemPrompt).toContain("clearances (pairwise child states)");
  });

  it("stays below the prompt size budget", () => {
    // Budget covers the runtime contract + core skill + the skill catalog
    // (progressive disclosure keeps full skill bodies out of this prompt).
    expect(systemPrompt.length).toBeLessThan(20_000);
  });

  it("carries the skill catalog but never a full skill body", () => {
    expect(systemPrompt).toContain("<available_skills>");
    expect(systemPrompt).toContain("load_skill");
    expect(systemPrompt).not.toContain("## Canonical recipes");
  });
});
