export type Build123dSkillMode = "none" | "core" | "full";

const coordinateFrames = `### Coordinate frames and placement

- Treat every sketch as two-dimensional local coordinates mapped onto a workplane. Read the resulting \`.sketch\` as placed geometry; do not infer global X/Y/Z from local sketch coordinates.
- Make primitive alignment explicit whenever a datum matters. Prefer \`align=(Align.CENTER, Align.CENTER, Align.MIN)\` for a body whose bottom must remain at Z=0.
- \`translate((x, y, z))\` is a global displacement. A \`Plane\` or \`Location\` supplies a coordinate frame; do not invent local-transform behavior to explain a misplaced result.
- Before changing a placement strategy, use a small probe that prints relevant points, tangents, normals, bounding boxes, or solid counts.`;

const profilesAndPaths = `### Profiles, paths, and generated forms

- Resolve and close two-dimensional profiles before creating a solid. Use extrusion for prismatic forms, revolve for axisymmetric half-sections, sweep for a section following a path, and loft for transitions between ordered sections.
- For a sweep, the profile must lie at the start of the path and its plane must be normal to the starting tangent. The canonical framing is \`Plane(origin=path @ 0, z_dir=path % 0)\`, where \`path @ 0\` is the start position and \`path % 0\` is its tangent.
- Verify a sweep independently before adding posts, holes, or other solids. Check its bounding box and require exactly one solid.
- Place loft sections deliberately along the intended axis and keep their wire orientation consistent. Diagnose the smallest pair of sections before adding more.`;

const constructionModes = `### Builder mode and algebra mode

- Do not mix the mental models. Builder mode collects pending sketches, edges, and solids inside \`BuildPart\`, \`BuildSketch\`, and \`BuildLine\`; algebra mode passes shapes explicitly to operations and combines them with operators.
- In builder mode, create a base solid before subtractive features. Scope \`Hole\`, \`CounterBoreHole\`, and \`CounterSinkHole\` to the intended workplane and solid.
- In algebra mode, keep intermediate shapes named and inspect them separately when an operation fails. Return the final \`Part\`, \`Shape\`, or intentional \`Compound\` as \`result\`.`;

const booleansAndFeatures = `### Booleans and features

- Additive bodies must overlap by real volume to fuse. Tangent or coincident contact is not a robust union. Bury a connector slightly into both bodies, then verify the resulting solid count.
- Extend subtractive tools slightly through their target to avoid coincident end faces. Keep cutters narrow enough that they do not damage unrelated geometry.
- Build the dominant material and void structure first, fuse additive features next, cut shared holes after fusion, and apply fillets and chamfers last.
- Never use a changed face count as the sole proof that a boolean worked. Use validity, solid count, bounding box, volume, hole census, task checks, and inspection views together.`;

const selectorsAndPatterns = `### Selectors, patterns, and symmetry

- Never rely on raw topology indices across rebuilds. Select by geometry with \`filter_by\`, \`sort_by\`, \`group_by\`, axes, positions, radii, or operation sets such as \`Select.NEW\` and \`Select.LAST\`.
- Build one repeated feature correctly before applying \`GridLocations\`, \`PolarLocations\`, or symmetry. Verify count, spacing, and orientation after patterning.
- Use \`Location\` and location arithmetic for static placement. Use joints when the design needs an explicit assembly or kinematic relationship, not for every transform.`;

const recovery = `### Failure recovery

- Read the first real traceback cause and the complete verify-gate diagnostics. Do not attribute a failure to undocumented runtime behavior without a minimal probe.
- Search the official documentation before first use of an unfamiliar operation, after an API traceback, or after a coordinate-frame, workplane, selector, sweep, loft, or boolean explanation remains uncertain.
- After two failures in the same category, stop rewriting the full model. Run minimal diagnostic CAD code for that operation, apply what it proves, and then rebuild the complete result.
- If a valid model has the wrong dominant form, change the construction strategy instead of adding cosmetic patches.`;

export const build123dSkillSections = {
  coordinateFrames,
  profilesAndPaths,
  constructionModes,
  booleansAndFeatures,
  selectorsAndPatterns,
  recovery,
} as const;

export const build123dSkillSources = [
  { section: "coordinateFrames", url: "https://github.com/gumyr/build123d/blob/v0.11.1/docs/build_sketch.rst", admission: "Always-on because frame mistakes corrupt common sketches and placements.", verification: "prompt assertions" },
  { section: "profilesAndPaths", url: "https://github.com/gumyr/build123d/blob/v0.11.1/docs/build_line.rst", admission: "Always-on because profile framing selects the correct sweep construction before retrieval.", verification: "py-tests/test_skill_snippets.py" },
  { section: "constructionModes", url: "https://github.com/gumyr/build123d/blob/v0.11.1/docs/key_concepts_builder.rst", admission: "Always-on because builder and algebra state models determine every operation call.", verification: "prompt assertions" },
  { section: "booleansAndFeatures", url: "https://github.com/gumyr/build123d/blob/v0.11.1/docs/tutorial_design.rst", admission: "Always-on because construction order and real overlap prevent common topology failures.", verification: "prompt assertions" },
  { section: "selectorsAndPatterns", url: "https://github.com/gumyr/build123d/blob/v0.11.1/docs/topology_selection.rst", admission: "Always-on because raw topology indices are unstable across parametric rebuilds.", verification: "prompt assertions" },
  { section: "recovery", url: "https://github.com/gumyr/build123d/blob/v0.11.1/docs/tips.rst", admission: "Always-on because the model must recognize when to stop guessing and retrieve details.", verification: "prompt assertions" },
] as const satisfies ReadonlyArray<{
  section: keyof typeof build123dSkillSections;
  url: string;
  admission: string;
  verification: string;
}>;

export const build123dSkill = `## build123d 0.11.1 Modeling Skill

Use these high-frequency invariants directly. Use \`search_docs\` for detailed signatures, uncommon operations, and examples.

${Object.values(build123dSkillSections).join("\n\n")}`;

// This intentionally lossy summary is a distinct ablation treatment. Tests pin
// the high-risk sweep and retrieval invariants shared with the full treatment.
export const build123dCoreSkill = `## build123d 0.11.1 Core Skill

Choose the dominant form before details; parameterize dimensions; resolve profiles in 2D; fuse overlapping additive material; cut shared holes after fusion; apply fillets and chamfers last.
Sketch coordinates are local to their workplane. Make datums and alignment explicit; global \`translate\` is not a local-plane operation.
For sweep, the profile must lie at the path start on \`Plane(origin=path @ 0, z_dir=path % 0)\`. Verify the sweep alone before adding features.
Use builder pending objects or explicit algebra consistently. Select topology geometrically, never by unstable raw indices.
After an API, workplane, sweep, loft, selector, or repeated boolean failure, call \`search_docs\`. After two failures in one category, run a minimal diagnostic probe before rewriting the full model.`;

export function assembleAgentPrompt(runtimePrompt: string, options: { skill: Build123dSkillMode }): string {
  if (options.skill === "none") return runtimePrompt;
  return `${runtimePrompt}\n\n${options.skill === "core" ? build123dCoreSkill : build123dSkill}`;
}
