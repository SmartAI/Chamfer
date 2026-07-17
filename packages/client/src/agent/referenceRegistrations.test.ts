import { describe, expect, it } from "vitest";
import type { ReferenceRecordDto, ReferenceRegistrationDto } from "@chamfer/shared";
import { referenceRegistrationGateError, unregisteredReferenceIds } from "./referenceRegistrations";

const reference = (referenceId: string, status: ReferenceRecordDto["status"]): ReferenceRecordDto => ({
  referenceId,
  conversationId: "conversation-1",
  attachmentAvailable: true,
  status,
  relationships: [],
  specificationLinks: [],
  history: [],
});

describe("reference registration preflight", () => {
  it("requires current registrations for active and complementary references only", () => {
    const registrations = [
      { referenceId: "active", status: "current" },
      { referenceId: "old", status: "stale" },
    ] as ReferenceRegistrationDto[];
    expect(unregisteredReferenceIds([
      reference("active", "active"),
      reference("complement", "complementary"),
      reference("old", "active"),
      reference("retired", "superseded"),
    ], registrations)).toEqual(["complement", "old"]);
  });

  it("gives one actionable recovery instruction", () => {
    expect(referenceRegistrationGateError(["reference-1", "reference-2"]))
      .toContain("register_reference_view for each reference before the first non-probe CAD run");
  });
});
