# Chamfer

An AI CAD designer that runs in the browser: an LLM writes build123d Python, a client-side geometry kernel executes and verifies it, and the user sees the resulting model and evidence.

## Language

**CAD code**:
The build123d Python program the agent writes to produce a model.
_Avoid_: Python (the language, not the artifact), script, generated code

**CAD code version**:
A complete, self-contained snapshot of CAD code submitted for execution.
Each successful deliverable version is stored as a full artifact rather than reconstructed from patches.

**Script**:
Ad-hoc CAD code a developer types into the dev Script panel; not agent-authored.
_Avoid_: using "script" for agent-written CAD code

**CAD code visibility**:
Whether CAD code bodies are rendered in the chat window. Hidden by default; enabling it is a deployment-level configuration, not a per-user preference.

**Verification gate**:
The kernel-enforced check suite that every CAD code run must pass before its result is presented as valid.
_Avoid_: validation, checks (unqualified)

**Active reference image**:
A user-provided image whose visual evidence still defines or supplements the requested design.
The agent classifies its reference status by interpreting the conversation and may revise that classification later.

**Active reference set**:
All active reference images for the current design.
The set may contain multiple complementary views or drawings.

**Superseded reference image**:
A user-provided image that the agent has classified as replaced by newer evidence.
Its pixels no longer need to remain in the LLM context, but its extracted specifications and supersession record remain part of the design history.

**Reference record**:
The durable, text-sized representation of a reference image after its initial analysis.
It identifies the stored image, records whether the image is active or superseded, and links to the specifications extracted from it.
The agent can use the record to retrieve the original pixels when visual reasoning is required.

**Reference classification**:
An append-only agent decision that records a reference image's status, relationship to other references, and rationale.
The latest valid classification determines the current status, while earlier classifications remain available for audit and reversal.

**Unclassified reference image**:
A newly uploaded user image whose role in the design has not yet been recorded by the agent.
Its pixels remain in the LLM context, and image-driven CAD execution remains blocked, until the agent submits a valid reference classification with extracted specification links.

**Image inspection lease**:
Temporary permission for selected stored image pixels to appear in the LLM context for a visual task.
The lease closes and the pixels are evicted when the agent records structured observations, while interruption or recording failure leaves the lease open for recovery.

**Visual verification checkpoint**:
A deliberate comparison of active reference images with current inspection evidence.
Active reference images are retrieved automatically for the final checkpoint and may be retrieved by the agent earlier when needed.

**Visual verification record**:
The agent's structured verdict and observations after inspecting active reference images with the current inspection sheet.
The record identifies the CAD artifact and evidence inspected so Chamfer can prove the judgment concerns the latest design state.

**Visual finalization gate**:
The requirement that an image-driven design cannot be finalized until a visual verification record covers the latest CAD artifact, its current inspection sheet, and every active reference image.
Chamfer enforces evidence presence and ordering, while the agent makes the semantic comparison.

**Visual verification coverage**:
The set of active reference images inspected against one specific CAD artifact and its current inspection sheet.
Coverage may accumulate across multiple model requests, but any CAD artifact change makes the accumulated coverage stale.

**Conversation data directory**:
The local durable storage boundary configured by `CHAMFER_DATA_DIR`.
It contains the conversation database and the image blob store but is not part of the source-code workspace.

**Image blob**:
Image bytes stored as a content-addressed file beneath the conversation data directory.
SQLite stores the blob's content hash, relative path, media type, size, and ownership metadata rather than the image bytes.
