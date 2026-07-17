# FUS-FOUND-006: Nylon control knob

Synthetic public benchmark case. Expected outcome: completed.

## Task

Create one nylon control knob using a constrained revolve: 36 mm maximum diameter, 24 mm height, and 6 mm through bore. Add twelve evenly spaced 1.5 mm deep axial grip grooves with a native circular feature named `Grip Groove Pattern`, a 3 mm top fillet, and 0.8 mm bottom-edge chamfer. Assign Nylon 6 engineering material and a separate red RGB 175/35/40 appearance.

## Acceptance contract

- Envelope and groove depth are checked within 0.05 mm; bore diameter within 0.02 mm; pattern count is exact.
- Native constrained sketch, revolve, bore, groove cut, circular pattern, fillet, chamfer, and parameters must remain editable.
- Exactly one solid, material and separate appearance evidence, typed checks, exterior views, and one Undo entry per completed action are required.
- Modeled texture instead of patterned grooves, wrong pattern count, direct geometry, extra bodies, appearance-only material, unsupported verification, or displaced camera are forbidden.
- Budget: 1 user turn, 26 agent turns, 8 actions, 210 seconds.
- Review: stable feature count and dimensions define difficulty; no exact construction sequence is required.
