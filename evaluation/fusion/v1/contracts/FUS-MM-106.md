# FUS-MM-106 — Authoritative manual parameter edit

Version: 1
Review status: reviewed
Reference: `FUS-MM-106-manual-parameter.svg`

## Source-linked specifications

- `drawing.baseWidth.initial`: 100 mm.
- `drawing.holes`: two 12 mm through holes with symmetric spacing.
- `manual.baseWidth.authoritative`: manual Fusion edit sets `base_width` to 112 mm.
- `followup.fillet`: add native 3 mm outer fillets after reconciliation.

The manual parameter edit is authoritative. Chamfer must cancel stale work, inspect the new revision, refresh affected checks, preserve names/material/appearance/hole-spacing intent, and add only the requested fillet feature.

## Review notes

The asset and manual fixture are synthetic. Deterministic checks cover reconciliation, the 112 mm width, preservation, and targeted history. Semantic review separately scores preserved design intent, editability, and final form.
