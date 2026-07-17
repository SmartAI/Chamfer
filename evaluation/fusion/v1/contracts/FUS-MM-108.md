# FUS-MM-108 — Topology change with stable feature identity

Version: 1
Review status: reviewed
Reference: `FUS-MM-108-topology-stable.svg`

## Source-linked specifications

- `drawing.envelope`: 150 x 90 x 14 mm.
- `drawing.bore.initial`: named `bearing_bore`, 35 mm diameter.
- `manual.rib`: a manual rib adds faces but preserves the named bore feature.
- `followup.bore`: change `bearing_bore` to 40 mm.

Chamfer must reconcile the manual rib, resolve the high-level named feature in the current revision, and edit its parameter. Cached cylindrical-face identity is revision-local and must not be used. The rib and unaffected history remain intact.

## Review notes

The synthetic case separates resolvable topology change from ambiguity. Checks cover the manual reconciliation, 40 mm bore, preserved rib, and feature-level targeting. Semantic review scores intent preservation, editability, and form.
