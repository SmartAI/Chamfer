import { describe, expect, it } from "vitest";
import type { CreateReferenceRegistrationInput } from "@chamfer/shared";
import { openDb } from "./db";
import { createAttachment, createConversation, createMessage } from "./conversationStore";
import { classifyReference } from "./referenceClassification";
import { recordSourceSpecifications } from "./sourceSpecifications";
import {
  listReferenceRegistrations,
  ReferenceRegistrationError,
  registerReference,
} from "./referenceRegistrations";

function fixture() {
  const db = openDb(":memory:");
  const conversation = createConversation(db, "reference registration");
  createMessage(db, conversation.id, { id: "message-1", seq: 0, role: "user", contentJson: "{}" });
  createAttachment(db, "message-1", "user-image", {
    mime: "image/png",
    contentHash: "a".repeat(64),
    byteSize: 10,
    blobPath: "images/aa/reference.png",
  }, "reference-1");
  recordSourceSpecifications(db, conversation.id, { specifications: [{
    id: "overall-width",
    requirement: "The orthographic width is 10 mm.",
    source: { attachmentId: "reference-1", observation: "The width callout reads 10 mm." },
  }] }, "source-specification");
  classifyReference(db, conversation.id, {
    referenceId: "reference-1",
    status: "active",
    purpose: "Dimensioned front view",
    relationships: [],
    rationale: "The source establishes front shape and width.",
    specificationIds: ["overall-width"],
  }, "classification");
  return { db, conversation };
}

function eligibleInput(): CreateReferenceRegistrationInput {
  return {
    referenceId: "reference-1",
    sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
    projection: "orthographic",
    direction: "front",
    scaleAnchor: {
      specificationId: "overall-width",
      start: { x: 0.1, y: 0.9 },
      end: { x: 0.6, y: 0.9 },
      physicalLengthMm: 10,
    },
    visibleLandmarks: [{ id: "center-hole", label: "Center hole", position: { x: 0.5, y: 0.5 } }],
    uncertainty: { level: "low", notes: "Outline is isolated.", occluded: false },
    geometry: {
      sourceSizePx: { width: 100, height: 100 },
      regionPx: { x: 0, y: 0, width: 100, height: 100 },
      extraction: { status: "succeeded", extractor: { id: "opencv-js-contour", version: 1 } },
      mask: { width: 100, height: 100, rle: [0, 10_000] },
      contour: { points: [[1, 1], [98, 1], [98, 98], [1, 98]], areaPx2: 9_409 },
      scaleTransform: {
        specificationId: "overall-width",
        physicalLengthMm: 10,
        pixelLength: 50,
        mmPerPixel: 0.2,
      },
    },
  };
}

describe("reference registrations", () => {
  it("persists eligible geometry, exact retries, natural deduplication, and append-only revisions", () => {
    const { db, conversation } = fixture();
    const input = eligibleInput();
    const first = registerReference(db, conversation.id, input, "register-1");
    expect(first).toMatchObject({
      revision: 1,
      status: "current",
      eligibility: { status: "eligible", reasons: [] },
      geometry: { contour: { areaPx2: 9_409 }, scaleTransform: { mmPerPixel: 0.2 } },
    });
    expect(registerReference(db, conversation.id, input, "register-1")).toEqual(first);
    expect(registerReference(db, conversation.id, input, "different-exact-call")).toEqual(first);

    const revisedInput = structuredClone(input);
    revisedInput.uncertainty.notes = "A second source inspection confirmed the same outline.";
    const second = registerReference(db, conversation.id, revisedInput, "register-2");
    expect(second.registrationId).toBe(first.registrationId);
    expect(second.revision).toBe(2);
    expect(listReferenceRegistrations(db, conversation.id).map((registration) => registration.status)).toEqual(["stale", "current"]);
    expect(() => registerReference(db, conversation.id, input, "register-2")).toThrow(/idempotency key conflicts/);
  });

  it("keeps perspective, unscaled, occluded, uncertain, and extraction-failed evidence advisory with reasons", () => {
    const { db, conversation } = fixture();
    const input = eligibleInput();
    input.projection = "perspective";
    delete input.direction;
    delete input.scaleAnchor;
    delete input.geometry.scaleTransform;
    input.uncertainty = { level: "high", notes: "The outline is partly hidden.", occluded: true };
    input.geometry = {
      ...input.geometry,
      extraction: {
        status: "failed",
        reason: "annotations merge with the object outline",
        extractor: { id: "opencv-js-contour", version: 1 },
      },
      mask: undefined,
      contour: undefined,
    };

    const advisory = registerReference(db, conversation.id, input, "advisory");
    expect(advisory.eligibility.status).toBe("advisory");
    expect(advisory.eligibility.reasons.join(" ")).toMatch(/Perspective.*scale.*extraction failed.*occluded.*uncertainty/is);
  });

  it("rejects invalid deterministic geometry, unsupported scale, and cross-conversation ownership", () => {
    const { db, conversation } = fixture();
    const invalidScale = eligibleInput();
    invalidScale.geometry.scaleTransform!.mmPerPixel = 1;
    expect(() => registerReference(db, conversation.id, invalidScale, "invalid-scale"))
      .toThrow(/scale transform/);

    const unsupportedLength = eligibleInput();
    unsupportedLength.scaleAnchor!.physicalLengthMm = 12;
    unsupportedLength.geometry.scaleTransform!.physicalLengthMm = 12;
    unsupportedLength.geometry.scaleTransform!.mmPerPixel = 0.24;
    expect(() => registerReference(db, conversation.id, unsupportedLength, "unsupported-length"))
      .toThrow(/not supported by specification/);

    const other = createConversation(db, "other owner");
    expect(() => registerReference(db, other.id, eligibleInput(), "foreign"))
      .toThrow(ReferenceRegistrationError);
  });
});
