# FUS-MM-103 — Explicit text override

Version: 1
Review status: reviewed
Reference: `FUS-MM-103-override.svg`

## Source-linked specifications

- `drawing.envelope`: 140 x 70 x 10 mm.
- `drawing.holes`: two 12 mm through holes.
- `drawing.spacing.revA`: 70 mm hole spacing.
- `conversation.spacing.override`: the later text instruction changes spacing to 76 mm and supersedes only `drawing.spacing.revA`.

All non-conflicting drawing requirements remain authoritative. The result must retain a named editable hole-spacing parameter equal to 76 mm; silently averaging or weakening the conflict is forbidden.

## Review notes

The synthetic drawing deliberately contains one controlled stale dimension. Deterministic checks establish override scope and exact geometry; blinded review assesses whether the model communicates the preserved design intent and remains naturally editable.
