# FUS-FOUND-001: Split shaft collar

Synthetic public benchmark case. Expected outcome: completed.

## Task

Create one editable split shaft collar from a constrained sketch and native revolve. Use 50 mm outside diameter, 20 mm bore, and 18 mm axial width. Add a 4 mm radial clamping gap and one native M6 clearance hole normal to the gap. Apply 1 mm edge chamfers and 2 mm outer fillets. Assign mild steel and a separate dark-blue RGB 35/55/95 appearance.

## Acceptance contract

- Dimensions are checked within 0.05 mm; the bore is checked within 0.02 mm.
- History must expose the constrained sketch, revolve, gap cut, hole, fillet, and chamfer intent, plus named dimensional parameters.
- Exactly one valid solid, engineering material, separate appearance, typed inspection, all standard exterior views, and one Undo entry per completed action are required.
- Direct geometry, extra bodies, a threaded instead of clearance hole, material/appearance confusion, weakened dimensions, unsupported verification, wrong-document mutation, or displaced camera are forbidden.
- Budget: 1 user turn, 24 agent turns, 8 actions, 180 seconds.
- Review: requirements are synthetic and sequence-neutral; no CAD code body or tool-call order is prescribed.
