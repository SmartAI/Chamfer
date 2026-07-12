---
name: sweep-and-loft
description: Model shapes that follow a curved spine (handles, tubes, pipes, rails) with sweep, or transition between cross-sections (funnels, hulls, bottle necks) with loft. Load before the first sweep or loft call in a design, or after any sweep/loft traceback, self-intersection, or wrong-shape result.
---

## When to reach for this

Use sweep when a constant profile travels along a path: grips, tubes, bent pipes, cable channels, rails.
Use loft when the cross-section itself changes along the travel axis: funnels, transitions, hulls, bottle necks.
Prefer extrude or revolve for prismatic and axisymmetric forms; sweep and loft are for everything those cannot express.

## Invariants

- A sweep has two inputs that must agree: the profile must sit at the start of the path, on a plane normal to the starting tangent. The canonical framing is `Plane(origin=path @ 0, z_dir=path % 0) * profile`, where `path @ 0` is the start point and `path % 0` is the unit tangent there. Never place the profile by eye.
- `path @ t` and `path % t` accept any parameter in [0, 1]; use them to probe intermediate points and tangents instead of guessing coordinates.
- The profile must clear the tightest bend: if the profile's half-width exceeds the path's minimum bend radius, the sweep self-intersects and produces an invalid or absurd solid. Shrink the profile or ease the bend.
- Build the path as one connected curve. A list of disconnected edges sweeps into disconnected or overlapping solids; join segments into a single wire first.
- Verify the swept or lofted body alone before any boolean: exactly one solid, plausible bounding box, plausible volume. Only then add posts, holes, or fillets.
- Order loft sections monotonically along the travel axis and keep them closed, planar, and consistently oriented. A reversed or out-of-order section twists the loft into an hourglass.
- Pass `ruled=True` to loft for straight-line (conical) transitions between sections; the default smooth interpolation can bulge between distant sections.

## Canonical recipes

Sweep a circular grip along an arc; the profile is framed on the path start, never translated by hand:

{{snippet:snippets/sweep_profile.py}}

Loft a square base into a circular neck through an intermediate section; every section is placed by offsetting one workplane:

{{snippet:snippets/loft_stack.py}}

## Failure signatures

- Traceback mentioning a non-planar or open profile: the 2D profile was never resolved or closed. Rebuild the sketch, then re-frame it.
- Sweep succeeds but the bounding box or volume is absurd, or the gate reports an invalid solid: the profile was not at the path start or not normal to the tangent. Re-frame with the canonical plane; do not patch with translate.
- `BRep_API: command not done` or self-intersection on a curved path: profile too large for the tightest bend. Shrink the profile or increase the bend radius.
- Loft produces a twisted or pinched body: sections are out of order or inconsistently oriented. Rebuild with the smallest failing pair of sections, confirm, then add the rest.
- Two or more solids after a sweep: the path was disconnected. Join the segments into one wire and sweep once.

## Go deeper

- After two failed sweep attempts, stop editing the model and run a minimal probe; load it with `load_skill("sweep-and-loft", resource="snippets/sweep_diagnose.py")`.
- `search_docs` queries for full signatures and variants: "sweep multisection", "loft ruled", "Spline ThreePointArc path", "Plane origin z_dir".
