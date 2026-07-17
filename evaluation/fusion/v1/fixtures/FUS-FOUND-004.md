# FUS-FOUND-004: V-belt pulley

Synthetic public benchmark case. Expected outcome: completed.

## Task

Create one editable V-belt pulley by revolving a fully constrained sketch named `Pulley Revolve Profile`. Use 90 mm outside diameter, 24 mm width, 20 mm shaft bore, a centered 12 mm deep V groove driven by `v_groove_depth` and a named `v_groove_angle` parameter set to 40 degrees included angle, and a 6 x 3 mm keyway pocket. Add 1 mm rim fillets and 0.8 mm bore chamfers. Keep named parameters and one connected solid.

## Acceptance contract

- Diameters and width are checked within 0.05 mm, and groove angle within 0.2 degree.
- Native constrained sketch, revolve, groove, pocket, fillet, chamfer, and parameter intent must remain editable.
- Typed geometry/history checks, exterior and section evidence, and one Undo entry per completed action are required.
- An axis error, missing keyway, rounded substitute for a V groove, direct geometry, extra bodies, unsupported verification, or camera displacement is forbidden.
- Budget: 1 user turn, 26 agent turns, 8 actions, 210 seconds.
- Review: stable geometric relationships define difficulty and leave implementation sequence open.
