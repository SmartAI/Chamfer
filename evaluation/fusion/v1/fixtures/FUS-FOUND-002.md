# FUS-FOUND-002: Revised motor mounting flange

Synthetic public benchmark case. Expected outcome: completed after a targeted revision.

## Task

Create one 100 x 80 x 10 mm mounting flange from a fully constrained sketch. Add a centered 40 mm through opening and four native 9 mm counterbored holes in a rectangular pattern at X plus or minus 38 mm and Y plus or minus 28 mm; counterbores are 16 mm diameter and 5 mm deep. Apply 3 mm corner fillets and 1 mm perimeter chamfers. Assign Aluminum 6061 and separate RGB 55/115/185 appearance. Then revise only the centered opening to 42 mm while preserving the hole pattern, edge treatments, material, appearance, and their existing history.

## Acceptance contract

- Linear dimensions and feature placement are checked within 0.05 mm; hole and opening diameters within 0.02 mm.
- Native constrained sketch, extrusion, opening, counterbores, pattern, fillets, chamfers, and named parameters must remain editable.
- Exactly one solid and evidence from the final revision are required; the revision must not rebuild unaffected features.
- Direct geometry, stale evidence, altered counterbores, lost material/appearance, extra bodies, unsupported verification, or destructive replacement are forbidden.
- Budget: 2 user turns, 30 agent turns, 9 actions, 240 seconds.
- Review: difficulty comes from targeted history preservation, not an observed model failure; implementation sequence is unconstrained.
