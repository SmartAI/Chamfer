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

**CAD environment**:
The conversation-bound system in which Chamfer creates, edits, inspects, and verifies a design.
A conversation uses exactly one CAD environment for its lifetime.
_Avoid_: connector or backend when referring to the user's selected design environment

**CAD environment selection**:
The explicit choice of Local build123d or Autodesk Fusion required before a new conversation accepts its first message.
A remembered preference may preselect an option and Fusion readiness appears beside the Fusion option, but neither behavior silently binds or later switches the conversation.

**Local build123d environment**:
The CAD environment in which build123d CAD code executes locally in the browser and Chamfer owns the resulting model artifact and viewer evidence.
_Avoid_: default environment, native environment

**Fusion environment**:
The CAD environment in which the live Autodesk Fusion design is the authoritative editable model and the Fusion canvas is the authoritative interactive view.
_Avoid_: Fusion mode, Fusion backend

**Fusion connector**:
The Chamfer integration that connects a Fusion-environment conversation to a running Autodesk Fusion instance.
It is not itself a CAD environment or a second model state.

**Fusion design revision**:
The content fingerprint of the authoritative Fusion design's engineering state, including its intent, units, parameters, sketches, constraints, features, bodies, materials, and action-addressable entity identities.
Fusion evidence, planned actions, and completion judgments apply to exactly one Fusion design revision, while camera, selection, panels, viewport style, and temporary visibility do not create a revision.

**Fusion design snapshot**:
The canonical structured representation from which a Fusion design revision is calculated and against which design changes are compared.
It represents engineering state rather than Fusion user-interface state and is not a replacement for the bound Fusion document.

**Manual Fusion edit**:
A design change the user makes directly in Fusion rather than through a Chamfer action.
It creates a new Fusion design revision and makes unreconciled actions and earlier completion evidence stale.
_Avoid_: external edit, out-of-band edit

**Fusion part design**:
A Fusion-environment design whose deliverable is one functional mechanical part with editable parametric construction history.
The initial Fusion product scope covers Fusion part designs rather than assemblies, electronics, manufacturing, simulation, forms, sheet metal, drawings, rendering, or project administration.
_Avoid_: Fusion design when the narrower part-design scope matters

**Eligible Fusion part document**:
A design-history-enabled Fusion document whose design intent and contents are compatible with the initial single-part modeling scope.
Chamfer may inspect an ineligible document read-only, but it reports unsupported readiness and never converts the document's design mode automatically.

**Fusion action**:
One coherent Chamfer-authored modeling change applied against an expected Fusion design revision.
A Fusion action either completes atomically as one user-undoable operation and creates a new revision, or leaves the design unchanged.
_Avoid_: script, tool call, operation

**Fusion action body**:
The agent-authored Fusion Python that performs the feature-level design change for one Fusion action using Autodesk's `adsk.core` and `adsk.fusion` APIs.
It excludes orchestration, transaction, revision, logging, and inspection boilerplate supplied by the Fusion execution harness.
_Avoid_: Fusion script, CAD code when the environment-specific artifact matters

**Fusion Python capability policy**:
The fixed, versioned allowlist applied to every Fusion action body before execution.
The initial policy permits only `adsk`, `adsk.core`, `adsk.fusion`, `math`, ordinary control flow and data expressions, and the enumerated pure built-ins needed for modeling; it denies ambient machine access, dynamic execution, reflection, lifecycle control, and unapproved Fusion namespaces.
The policy is published as a concrete list and changes only through reviewed product releases, never through task-specific tailoring or conversational bypass.

**Fusion execution harness**:
The thin Chamfer-owned safety boundary that runs a Fusion action body with document and revision preconditions, atomic transaction handling, exception propagation, entity tracking, and post-action inspection.
It is not a modeling DSL and does not duplicate Fusion feature APIs.

**Fusion entity reference**:
A revision-bound identity combining a Chamfer UUID attribute when available, a Fusion entity token resolved through Fusion rather than string comparison, and a semantic descriptor from the design snapshot.
High-level entities may remain durable across revisions, while faces, edges, and profiles are revision-local and become ambiguous when topology changes split or replace them.

**Adopted Fusion entity**:
A user-created high-level Fusion entity that an authorized Fusion action deliberately brings under durable Chamfer identity by adding a namespaced UUID attribute.
The read-only Fusion inspector never adopts or tags entities.
_Avoid_: discovered entity, tagged entity

**Fusion action lease**:
The instance-wide exclusive right of one Fusion conversation to inspect preconditions, execute or roll back one Fusion action, and establish the resulting document state.
It remains held through cancellation or timeout until Chamfer verifies a safe revision or declares a hard recovery state.
_Avoid_: lock when referring to the user-visible orchestration state

**Owning Fusion conversation**:
The only conversation permitted to mutate the one Fusion document currently managed through a configured Fusion MCP endpoint.
Other conversations that previously referenced that document remain historical and read-only until ownership is explicitly transferred.

**Fusion ownership transfer**:
An explicit handoff of mutation authority for the currently managed Fusion document from its owning Fusion conversation to another conversation.
The receiving conversation must begin from a fresh independent inspection, while the previous owner becomes read-only and neither conversation changes the document binding automatically.

**Fusion action record**:
The revision-bound account of a completed Fusion action, including its intent, affected design entities, resulting revision, and verification evidence.
It is not a replayable substitute for the authoritative Fusion design.

**Fusion action attempt**:
One immutable request to apply a Fusion action, whether it is rejected as stale, fails and rolls back, or completes successfully.
It retains the submitted CAD code, preconditions, expected effects, normalized result, and pinned agent configuration.

**Fusion reconciliation record**:
The immutable account of engineering-state changes detected after a manual Fusion edit, expressed as the difference between two Fusion design snapshots.
It records user-authored change without attributing generated CAD code to it.

**Automatic Fusion reconciliation**:
The default response to a detected manual Fusion edit: cancel stale work, inspect the new revision, append a Fusion reconciliation record, refresh affected entity references and checks, and continue from the user's authoritative state.
Chamfer escalates only when the edit conflicts with active requirements, removes necessary design intent, or leaves materially different continuations unresolved.

**Fusion action ledger**:
The append-only local history of Fusion action attempts, completed action records, and reconciliation records for one Fusion conversation.
It provides audit and evidence history but is not a replayable backup of the bound Fusion document.

**Fusion inspector**:
The trusted, read-only Chamfer capability that independently derives a Fusion design snapshot, geometry signatures, engineering measurements, and standardized visual evidence from the bound Fusion document.
Generated Fusion action code cannot supply or alter the inspector's verdict.

**Fusion inspection view set**:
The standardized Fusion screenshots captured for visual evidence after temporarily saving and controlling the native Fusion camera.
Inspection restores the user's exact prior camera, does not create a design revision, and leaves Fusion readiness degraded if restoration cannot be verified.

**Fusion action verification**:
The immediate deterministic judgment that a Fusion action preserved structural integrity and produced its declared local effects.
Failure automatically reverses the action and leaves the preceding Fusion design revision authoritative.

**Fusion design verification**:
The broader engineering and semantic judgment that a structurally valid Fusion design revision satisfies the active design requirements and visual intent.
Failure retains the revision as diagnostic intermediate work that may be repaired by later Fusion actions.

**CAD verification check**:
A typed, environment-neutral assertion in the design plan, such as body count, dimension, volume range, feature presence, material, minimum thickness, hole diameter, or visual-reference coverage.
Each CAD environment maps supported checks to its trusted inspector, while an unsupported check is reported explicitly and can never be approximated silently or counted as passed.
_Avoid_: assertion when it could imply agent-authored executable code

**Nonconforming Fusion revision**:
A structurally valid Fusion design revision that fails one or more design-level engineering or semantic requirements.
It remains editable diagnostic work but cannot establish completion.

**Authorized Fusion modeling work**:
The revision-checked, atomic, independently verified, and single-undo Fusion actions needed to pursue the user's active design request.
The request authorizes this reversible modeling work without per-action confirmation.

**Intent-preserving Fusion edit**:
A targeted change to an existing Fusion design that retains unaffected features, constraints, names, references, and manual design intent.
It is the default modification strategy and is verified against both the requested change and preservation checks for unaffected requirements.

**Destructive Fusion rebuild**:
Replacement of substantial existing feature history rather than a targeted edit.
It is allowed only when the user explicitly requests it or approves it after Chamfer establishes that intent-preserving repair is not feasible.
_Avoid_: refactor, cleanup when the action discards editable design history

**Fusion lifecycle action**:
An action that changes document persistence or user application state rather than the part design itself, including save, Save As, version creation, activation, reopening, close, discard, or later undo.
It requires explicit user intent and is never inferred from general modeling authority.

**Verified unsaved Fusion result**:
A Fusion design revision that passes completion verification but still contains changes not explicitly persisted by the user.
Chamfer presents the unsaved state and an explicit Save action without weakening the verification result or silently creating a local save or cloud version.

**CAD method skill**:
Environment-independent design knowledge such as datum strategy, requirement decomposition, tolerance intent, feature ordering, and diagnostic reasoning.
It contains no build123d or Fusion API syntax and may be used in either CAD environment.

**CAD environment skill**:
Modeling knowledge whose API, execution semantics, units, entity model, or recovery procedure belongs to exactly one CAD environment.
Build123d and Fusion environment skills are separate catalogs and are never exposed across environments.

**Fusion foundation skill**:
The compact operating knowledge for using Chamfer's Fusion tool contract and writing Fusion Python safely within Fusion orchestration.
It is available from the start of every Fusion conversation and explains the inspect, documentation, action, verification, and recovery loop without exposing Autodesk's raw MCP tools as the agent interface.
_Avoid_: Fusion MCP skill

**Fusion skill release**:
A reviewed and versioned foundation or specialized Fusion environment skill that has passed the relevant regression evaluation before becoming available to production conversations.
Successful sessions may produce skill candidates and evaluation cases, but they never rewrite the active skill catalog automatically.
_Avoid_: learned skill when it implies unreviewed runtime self-modification

**Fusion API documentation**:
The installed Fusion version's API reference exposed through the local Fusion MCP server and wrapped by Chamfer for agent retrieval.
It is the runtime authority for exact Fusion Python classes, members, signatures, and version-specific behavior.
_Avoid_: static Fusion docs, web docs when referring to runtime API authority

**Fusion document strip**:
The Chamfer conversation surface for a Fusion environment: a chat-only workspace whose thin strip above the messages shows readiness, bound document identity, ownership role, revision, and the contextual Save, ownership-transfer, recovery, and reconciliation affordances.
Captured Fusion views and the action history are no longer displayed; the action ledger stays inspectable over the API, and the native Fusion canvas remains the authoritative interactive view, so no right panel or mirrored viewer renders at all.
_Avoid_: Fusion evidence workspace (the retired right-panel surface), Fusion viewer, Fusion canvas when referring to the Chamfer surface

**Fusion evidence disclosure**:
The user-visible boundary stating that Chamfer may send the bound document's minimum necessary structured snapshot, relevant API documentation excerpts, selected inspection views, and action results to the configured model provider.
It excludes the Fusion file itself, unrelated documents or project listings, credentials, and raw MCP traffic.

**Fusion readiness**:
The current ability of Chamfer to inspect and safely act on the bound Fusion document.
It is one of unavailable, incompatible, no-document, wrong-document, read-only, busy, unsupported, degraded, or ready, based on application reachability, MCP compatibility, document state, command activity, and inspector health.
Only ready permits a Fusion action, while other states preserve conversation and diagnosis where possible.
_Avoid_: connected, online, health when the specific readiness state matters

**Fusion capability profile**:
The recorded result of live probes for the MCP handshake, required tool schemas, installed API documentation, read-only inspection, document identity, camera restoration, and atomic single-Undo behavior.
It determines compatibility and mutation readiness, while Fusion, MCP protocol, and server version numbers remain diagnostic metadata rather than sufficient proof of capability.

**Fusion integrity gate**:
The pre-release requirement that live capability probes and the evaluation corpus demonstrate single-Undo atomicity, rollback safety, document identity, independent inspection, camera restoration, and zero integrity failures.
Until it passes, the Fusion connector remains experimental and unavailable to normal users even if individual modeling tasks succeed.

**Fusion orchestration**:
Chamfer's ownership of planning, tool policy, revision reconciliation, Fusion action execution, evidence capture, recovery, verification, and completion judgment in a Fusion environment.
Autodesk Fusion supplies design capabilities but does not orchestrate the design workflow.

**Fusion tool contract**:
The stable, Chamfer-owned set of inspection, documentation, action, and recovery capabilities available to the agent in a Fusion environment.
The contract is narrower than the underlying Fusion MCP tool surface and preserves Chamfer's orchestration guarantees.
_Avoid_: raw MCP tools, MCP passthrough

**Local Fusion MCP endpoint**:
The validated `http://127.0.0.1:<port>/mcp` address through which the local Chamfer server reaches the installed Fusion instance.
Its port is configurable, but it never accepts another host, embedded credentials, a query string, a fragment, or a redirect outside the exact loopback boundary.
_Avoid_: MCP URL when referring to the security-constrained connector destination

**Bound Fusion document**:
The single Fusion document whose design is owned by a Fusion-environment conversation.
Every inspection and action must confirm this document identity rather than following whichever Fusion document is currently active.
_Avoid_: active document when identity, rather than current UI focus, is intended

**Provisional Fusion document**:
An unsaved bound Fusion document identified by its creation identity for the lifetime of that open document.
Its conversation becomes non-resumable if the document disappears, unless the same document was first saved and acquired a durable data-file identity.
_Avoid_: untitled document

**Evaluation case**:
A versioned agent task contract containing its inputs, expected outcome class, required evidence, forbidden outcomes, and scoring rules.
It defines desired behavior rather than prescribing an exact response, CAD code body, or tool-call sequence.

**Evaluation corpus**:
The versioned collection of evaluation cases used to compare agent configurations and product releases.
_Avoid_: golden outputs, benchmark (when referring to the case collection)

**Evaluation run**:
One or more executions of a pinned agent configuration against a pinned evaluation corpus version, producing task outcomes and resource measurements.
The v0.2.1 evaluation run is the initial product baseline, not the source of expected behavior.

**Offline evaluation**:
A controlled execution of evaluation cases against a pinned agent configuration before or after a product change.
It supports reproducible comparison between commits, pull requests, and releases.

**Online evaluation**:
Evaluation of sampled real product sessions using production evidence, feedback, review, and calibrated scoring.
It detects behavior and failure classes that a controlled evaluation corpus does not yet represent.

**Agent configuration**:
The complete pinned identity of behavior-affecting agent inputs, including the product build, prompt, policies, tools, skills, model, provider, and inference settings.

**Evaluation cohort**:
The repeated evaluation runs that share one evaluation corpus version and one agent configuration.
Comparisons are made between cohorts rather than between isolated stochastic executions.

**Evaluation identity**:
The complete structured identity of an evaluation case, corpus, cohort, agent configuration, evaluator, rubric, runner, and repetition.
A release evaluation with a missing or unpinned identity is incomplete.

**Integrity metric**:
A fail-closed evaluation measure for forbidden outcomes such as false success, weakened requirements, or incomplete evaluation evidence.
Integrity metrics take precedence over proficiency and efficiency metrics.

**Proficiency metric**:
An evaluation measure of whether the agent reaches the evaluation case's expected outcome, including successful completion, necessary escalation, or honest blocking.
_Avoid_: accuracy (unless the particular measure is classification accuracy)

**Reliability metric**:
An evaluation measure of variation across repeated executions of the same pinned evaluation case and agent configuration.

**Efficiency metric**:
A resource measure such as cost, token use, latency, model calls, CAD runs, retries, or compactions, compared only across equivalent outcomes.

**Diagnostic metric**:
A non-gating measure that helps explain an evaluation outcome, such as tool-choice patterns or failure categories.

**Evaluation verdict**:
The ordered release or change decision produced by integrity, proficiency, reliability, and efficiency metrics.
It is not a weighted composite score, and an efficiency improvement cannot offset a correctness regression.

**Fusion Assistant comparison**:
A paired offline evaluation of a pinned Chamfer agent configuration and a dated Autodesk Assistant version against the same versioned Fusion part-design evaluation corpus and execution conditions.
Any superiority claim is limited to that evaluated corpus, Fusion version, Assistant version, and date.
_Avoid_: beat Fusion Assistant when the evaluated scope is not stated

**Deterministic evaluator**:
Code that derives an evaluation score from structured task, agent, CAD, and proof evidence without a semantic model judgment.
It is authoritative wherever the evaluation case defines mechanically decidable requirements.

**Semantic rubric**:
A versioned set of criteria for judgments that structured evidence cannot decide, including design-intent satisfaction, visual-form quality, and escalation appropriateness.
Human-reviewed rubric judgments are the ground truth used to calibrate automated semantic judges.

**Semantic judge**:
An LLM evaluator that applies a semantic rubric and records both a score and evidence-based rationale.
Its judgments are non-authoritative until calibrated against held-out human-reviewed cases, and it cannot be the sole authority for an integrity gate.

**Local geometry execution**:
Execution of CAD code and geometry-kernel operations in the user's browser rather than on Chamfer's server.
It does not imply offline or air-gapped operation because design evidence may still be sent to the configured LLM provider.
_Avoid_: offline, air-gapped, local-first (unqualified)

**Verification gate**:
The environment-specific, Chamfer-owned check suite that evaluates independently produced design evidence before a result is presented as valid.
The local build123d environment uses kernel evidence from each CAD code run, while the Fusion environment uses evidence from the Fusion inspector after a Fusion action.
_Avoid_: validation, checks (unqualified)

**Shape proof**:
Evaluator-independent evidence that a CAD result's visible geometry matches registered reference views within declared tolerances.
It is distinct from visual verification, where the agent records a semantic judgment after inspecting evidence.

**Proof report**:
The version-bound record of requirements, engineering verification, shape proof, material properties, manufacturing-profile results, assumptions, and unresolved evidence for a finalized deliverable.
A new CAD code version makes every earlier proof report stale.

**Autonomous proof contract**:
The agent-frozen requirements, references, material assignment, manufacturing profile, and checks against which a deliverable is proved.
It does not require routine user approval, but its assumptions and revisions remain visible in the proof report.

**Exception-based escalation**:
A user question raised only when unresolved evidence would otherwise force an arbitrary, materially different design choice or weaken an explicit user requirement.
_Avoid_: routine approval, confirmation gate

**Functional mechanical part**:
A dimensioned, editable component whose geometry, material, fit, or manufacturability must satisfy explicit engineering requirements rather than merely resemble a reference.
_Avoid_: asset, visual replica, approximate model

**Deliverable part**:
A finalized functional mechanical part represented by one connected, valid solid with one material assignment, one manufacturing profile, and one current proof report.
Separate solids are separate deliverables rather than one multi-body result.

**Manufacturing profile**:
The declared production process and its engineering constraints against which a functional mechanical part is checked.
The initial profiles are FDM printing and 3-axis CNC machining; there is no process-neutral manufacturability claim.

**Material assignment**:
The versioned engineering material selected for a component, including provenance-backed physical properties used by the verification gate and a canonical viewer appearance.
A material assignment is required whenever Chamfer claims mass or manufacturability.

**Finish**:
A component's colour or surface treatment, separate from its material assignment and not itself evidence of physical properties.
_Avoid_: material, texture

**Intent-preserving revision**:
A requested design change that retains every unaffected accepted requirement and reports new proof for the resulting CAD code version.
Any requirement that changes or becomes invalid remains explicit in the design history.

**Plan-check conformance**:
Whether a CAD run includes every active check in the accepted design plan at equal or greater strength.
It is passed, failed, or not applicable, and is distinct from CAD execution and whether the geometry passes the verification gate.

**Nonconforming CAD result**:
A CAD result that produced geometry and inspection evidence but failed plan-check conformance.
It remains diagnostic evidence but cannot establish component completion or final visual verification.

**Active reference image**:
A user-provided image whose visual evidence still defines or supplements the requested design.
The agent classifies its reference status by interpreting the conversation and may revise that classification later.

**Active reference set**:
All active reference images for the current design.
The set may contain multiple complementary views or drawings.

**Registered reference view**:
An active reference image with a declared projection or camera pose, scale anchor, object silhouette, visible feature landmarks, and explicit uncertainty suitable for shape proof.

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
