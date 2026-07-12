---
name: holes-and-threads
description: Drill through, blind, counterbore, and countersink holes that the census classifies correctly, and decide when threads deserve real helix geometry versus a nominal bore. Load before any fastener feature, or when a hole reports the wrong kind (through/blind/internal) or the wrong count.
---

## When to reach for this

Use this for every fastener-related feature: screw holes, bolt circles, counterbores for cap heads, countersinks for flat heads, tapped or clearance bores.

## Invariants

- `Hole` drills in both directions from its workplane. Placed mid-body it eats material above and below; a blind hole must start on the surface it enters, on a workplane taken from that face.
- The verify gate classifies every bore as through, blind, or internal. A hole the user wants "through" must report kind "through": give the cut real overshoot past the exit face, or use `Hole` with no depth (through-all) and confirm in the census.
- Sizes are engineering decisions, not the fastener's nominal: a clearance hole is larger than the screw (M4 screw, about 4.5 mm hole); a tapping or press-fit bore is smaller. State the assumption in the response.
- `CounterBoreHole` and `CounterSinkHole` are one operation each; do not stack two cylinders by hand. The counterbore must sit on the entry face, so drill from a workplane on that face.
- Cut shared holes after the parts are fused, so one bore lines up through everything it pierces.
- Model real thread geometry only when the user explicitly needs it (printed threads, visual fidelity): a `Helix` plus a swept profile is expensive and fragile. For everything else a nominal cylinder is the engineering norm.

## Canonical recipes

A counterbored through-hole drilled from the top face, verified by volume delta:

{{snippet:snippets/counterbore.py}}

The both-directions gotcha, made visible: the same `Hole` from a mid-body plane versus the top face:

{{snippet:snippets/hole_directions.py}}

## Failure signatures

- Census reports "blind" where "through" was requested: the cut stopped at or before the exit face. Use through-all depth or overshoot the exit.
- Census reports "internal": the bore never reaches any surface - it is a sealed void, almost always a placement mistake.
- Hole count is short: some instances merged with other voids or missed the solid entirely. Check pattern spacing and the target face.
- A counterbore appears on the wrong side: the workplane was on the exit face. Rebuild the frame from the entry face.
- Material vanished above a "blind" hole: the both-directions rule; the workplane sat inside the body.

## Go deeper

- Real thread geometry, when explicitly required: `load_skill("holes-and-threads", resource="snippets/helix_thread.py")`.
- `lookup_docs` topic `holes-counterbores` covers runtime hole practice; `search_docs` queries: "Hole depth through", "CounterBoreHole parameters", "CounterSinkHole angle", "Helix pitch".
