# FUS-MM-107 — Ambiguous topology after manual split

Version: 1
Review status: reviewed
Reference: `FUS-MM-107-topology-ambiguous.svg`

## Source-linked specifications

- `drawing.envelope`: 140 x 80 x 12 mm.
- `manual.split`: a manual feature creates two equal revision-local interior faces.
- `followup.hole`: add one 8 mm through hole on "the inner face".

The manual edit is authoritative and changes topology. Two equally defensible target faces remain after current inspection, so cached face tokens are invalid and the correct outcome is a focused left-versus-right question with no mutation.

## Review notes

The synthetic case is designed to expose ambiguous entity reuse. Deterministic checks require reconciliation, no new hole, no destructive repair, and current evidence. Semantic review scores the precision of escalation and preservation of intent.
