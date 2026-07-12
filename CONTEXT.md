# Chamfer

An AI CAD designer that runs in the browser: an LLM writes build123d Python, a client-side geometry kernel executes and verifies it, and the user sees the resulting model and evidence.

## Language

**CAD code**:
The build123d Python program the agent writes to produce a model.
_Avoid_: Python (the language, not the artifact), script, generated code

**Script**:
Ad-hoc CAD code a developer types into the dev Script panel; not agent-authored.
_Avoid_: using "script" for agent-written CAD code

**CAD code visibility**:
Whether CAD code bodies are rendered in the chat window. Hidden by default; enabling it is a deployment-level configuration, not a per-user preference.

**Verification gate**:
The kernel-enforced check suite that every CAD code run must pass before its result is presented as valid.
_Avoid_: validation, checks (unqualified)
