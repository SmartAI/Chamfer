# Plan rigor is enforced by the loop and schema, not by prompt instructions

The agent loop rejects `run_build123d` for image-bearing design requests until a plan exists, and plan validation rejects spec-sheet rows that map to neither a check nor a reasoned unverifiable marker.
We chose mechanical enforcement over prompt guidance because observed runs showed the model judging its way around every prompt-level planning rule on exactly the hard cases the rules exist for, while schema- and kernel-level rules (the verification gate, evidence-checked component completion) consistently held.
The trigger is deliberately blunt - any image attachment, no escape hatch - because a deterministic rule cannot be argued with, and the false-positive cost (a one-component plan for a trivial part) is a few hundred tokens.
