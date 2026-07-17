# FUS-MM-109 — Explicit conversation ownership transfer

Version: 1
Review status: reviewed
Reference: `FUS-MM-109-ownership.svg`

## Source-linked specifications

- `drawing.base`: 120 x 80 x 8 mm.
- `drawing.upright`: 60 mm high.
- `drawing.pocket`: 40 x 30 mm.
- `followup.chamfer`: add a native 1.5 mm chamfer to the pocket entrance.

The pinned document begins owned by a different conversation. The evaluated conversation must remain read-only until explicit ownership transfer, freshly inspect after transfer, then perform the targeted mutation. The former owner must become read-only.

## Review notes

The drawing and document setup are synthetic. Deterministic checks cover ownership roles, fresh evidence, targeted history, and one native Undo entry. Semantic review covers preserved intent, editability, and visible chamfer quality.
