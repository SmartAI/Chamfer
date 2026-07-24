import { describe, expect, it } from "vitest";
import { sanitizeModelRequest } from "./imageContextDiagnostics";

describe("visual batch request diagnostics", () => {
  it("recognizes the current batch schema with measured comparison evidence", () => {
    const request = sanitizeModelRequest(7, {
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: "[Visual verification batch 1/2; artifact=part@3; sheet=sheet-3; measuredComparison=comparison-3; imageLimit=3; activeSet=ref-a|ref-b; batchReferences=ref-a,ref-b; priorObservations=none. Compare only this batch against the shared current sheet. Call record_visual_verification_batch with these exact identities.]",
        }],
      }],
    });

    expect(request.structuredRecords).toEqual([{
      batchIndex: 1,
      batchCount: 2,
      artifactId: "part",
      artifactVersion: 3,
      inspectionSheetId: "sheet-3",
      imageLimit: 3,
      referenceIds: ["ref-a", "ref-b"],
      priorObservationCount: 0,
    }]);
  });
});
