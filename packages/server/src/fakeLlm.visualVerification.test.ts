import { describe, expect, it } from "vitest";
import { fakeLlm } from "./fakeLlm";

describe("fake visual-finalization scenario", () => {
  it("finishes the image plan after the accepted plan revision without re-running CAD", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "image-plan-gate" }] },
      ...[
        ["image-plan-reference-specifications", "record_reference_specifications"],
        ["image-plan-classify", "classify_reference"],
        ["image-plan-register", "register_reference_view"],
        ["image-plan-invalid", "update_plan"],
        ["image-plan-valid", "create_plan"],
      ].flatMap(([id, name]) => [
        { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
        { role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false },
      ]),
      ...["image-plan-run-rejected", "image-plan-run-valid"].flatMap((id) => [
        { role: "assistant", content: [{ type: "toolCall", id, name: "run_build123d", arguments: {} }] },
        { role: "toolResult", toolCallId: id, toolName: "run_build123d", content: [], isError: id.endsWith("rejected") },
      ]),
      { role: "assistant", content: [{ type: "toolCall", id: "image-plan-done", name: "revise_plan", arguments: {} }] },
      { role: "toolResult", toolCallId: "image-plan-done", toolName: "revise_plan", content: [], isError: false },
    ];

    const events = [];
    for await (const event of fakeLlm().stream({} as never, { messages } as never, {} as never)) events.push(event);
    expect(events.find((event) => event.type === "done")?.message.content[0]).toMatchObject({
      type: "text",
      text: "Spacer complete: the image plan is built and verified.",
    });
  });

  it("pauses after premature CAD rejection without creating active-reference finalization work", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "retrievable-evidence-workflow" }] },
      { role: "toolResult", toolCallId: "workflow-premature-run", toolName: "run_build123d", isError: true, content: [] },
    ];
    const events = [];
    for await (const event of fakeLlm().stream({}, { messages }, {})) events.push(event);
    expect(events.find((event) => event.type === "done")?.message.content[0]).toMatchObject({
      type: "text", text: "Premature CAD rejected until every uploaded reference is classified.",
    });
  });

  it("advances a retrievable workflow from the immediate top-level CAD evidence shape", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "retrievable-evidence-workflow workflow-classify-ready workflow-retrieve workflow-build-first" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "workflow-premature-run", name: "run_build123d", arguments: {} }] },
      { role: "toolResult", toolCallId: "workflow-premature-run", toolName: "run_build123d", content: [], isError: true },
      ...["primary", "detail", "profile", "old"].flatMap((name) => [
        { role: "assistant", content: [{ type: "toolCall", id: `workflow-classify-${name}`, name: "classify_reference", arguments: {} }] },
        { role: "toolResult", toolCallId: `workflow-classify-${name}`, toolName: "classify_reference", content: [] },
      ]),
      ...["primary", "detail", "profile"].flatMap((name) => [
        { role: "assistant", content: [{ type: "toolCall", id: `workflow-register-${name}`, name: "register_reference_view", arguments: {} }] },
        { role: "toolResult", toolCallId: `workflow-register-${name}`, toolName: "register_reference_view", content: [] },
      ]),
      { role: "assistant", content: [{ type: "toolCall", id: "workflow-inspect-old", name: "inspect_evidence", arguments: {} }] },
      { role: "toolResult", toolCallId: "workflow-inspect-old", toolName: "inspect_evidence", content: [] },
      { role: "assistant", content: [{ type: "toolCall", id: "workflow-observe-old", name: "record_inspection_observation", arguments: {} }] },
      { role: "toolResult", toolCallId: "workflow-observe-old", toolName: "record_inspection_observation", content: [] },
      {
        role: "toolResult", toolCallId: "workflow-run-1", toolName: "run_build123d", isError: false,
        content: [{ type: "attachment-reference", attachmentId: "sheet-1", kind: "view-sheet", mimeType: "image/png" }],
        details: { code: { artifactId: "artifact-1", artifactVersion: 1 } },
      },
    ];
    const events = [];
    for await (const event of fakeLlm().stream({}, { messages }, {})) events.push(event);
    const done = events.find((event) => event.type === "done");
    expect(done?.message.content[0]).toMatchObject({ type: "text", text: "CAD revision rendered; attempting to finish before visual verification." });
  });

  it("records a sole durable reference only through the projected 1/1 pixel batch", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "visual-finalization-setup" }] },
      { role: "user", content: [{ type: "text", text: "[Reference visual-reference-e2e: status=active; purpose=primary]" }] },
      { role: "toolResult", toolCallId: "visual-register", toolName: "register_reference_view", content: [], isError: false },
      { role: "user", content: [{ type: "text", text: "visual-finalization-build" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "visual-run-1", name: "run_build123d", arguments: {} }] },
      { role: "user", content: [
        { type: "text", text: "[Visual verification batch 1/1; artifact=32f1ae60-c6e3-46d0-a035-dff2f961bdc7@1; sheet=9ec49444-eccd-46f8-95ec-23855c131396; imageLimit=4; activeSet=visual-reference-e2e; batchReferences=visual-reference-e2e; priorObservations=none.]" },
        { type: "image", data: "sheet", mimeType: "image/png" },
        { type: "image", data: "reference", mimeType: "image/png" },
      ] },
    ];

    const events = [];
    for await (const event of fakeLlm().stream({} as never, { messages } as never, {} as never)) events.push(event);
    const done = events.find((event) => event.type === "done");
    expect(done?.message.content[0]).toMatchObject({
      type: "toolCall",
      name: "record_visual_verification_batch",
      arguments: {
        artifactId: "32f1ae60-c6e3-46d0-a035-dff2f961bdc7",
        inspectionSheetId: "9ec49444-eccd-46f8-95ec-23855c131396",
        batchIndex: 0,
        batchCount: 1,
        coveredReferenceIds: ["visual-reference-e2e"],
        finalVerdict: "needs-revision",
      },
    });
    expect(JSON.stringify(done?.message.content[0])).toContain("request carried 2 images");
  });

  it("records the exact projected batch and captured request image count", async () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "batched-visual-verification-setup" }] },
      { role: "user", content: [{ type: "text", text: "[Reference ref-a: status=active] [Reference ref-b: status=active] [Reference ref-c: status=active]" }] },
      { role: "assistant", content: [{ type: "toolCall", id: "batched-visual-run", name: "run_build123d", arguments: {} }] },
      { role: "user", content: [
        { type: "text", text: "[Visual verification batch 1/2; artifact=artifact-a@1; sheet=sheet-a; imageLimit=3; activeSet=records; batchReferences=ref-a,ref-b; priorObservations=none.]" },
        { type: "image", data: "sheet", mimeType: "image/png" },
        { type: "image", data: "a", mimeType: "image/png" },
        { type: "image", data: "b", mimeType: "image/png" },
      ] },
    ];
    const events = [];
    for await (const event of fakeLlm().stream({} as never, { messages } as never, {} as never)) events.push(event);
    const done = events.find((event) => event.type === "done");
    expect(done?.message.content[0]).toMatchObject({
      type: "toolCall",
      name: "record_visual_verification_batch",
      arguments: {
        artifactId: "artifact-a", imageLimit: 3, batchIndex: 0, batchCount: 2,
        activeReferenceIds: ["ref-a", "ref-b", "ref-c"], coveredReferenceIds: ["ref-a", "ref-b"],
      },
    });
    expect(JSON.stringify(done?.message.content[0])).toContain("request carried 3 images");
  });
});
