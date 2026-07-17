import { describe, expect, it } from "vitest";
import { isFusionExpectedEffect } from "@chamfer/shared";
import {
  FUS_IMAGE_001,
  FUS_IMAGE_001_ACTION_BODY,
  FUS_TEXT_001,
  FUS_TEXT_001_ACTION_BODY,
  FUS_TEXT_002,
  FUS_TEXT_002_ACTION_BODY,
  FUS_MM_COMPLETION_FIXTURES,
} from "./index";

describe("FUS-TEXT-001 acceptance fixture", () => {
  it("keeps every declared effect on the shared runtime contract", () => {
    expect(FUS_TEXT_001.expectedEffects.every(isFusionExpectedEffect)).toBe(true);
  });

  it("contains the native feature operations needed by the fixture", () => {
    for (const signature of ["holeFeatures.createSimpleInput", "Centered Pocket", "filletFeatures.createInput", "addEqualDistanceChamferEdgeSet"]) {
      expect(FUS_TEXT_001_ACTION_BODY).toContain(signature);
    }
  });
});

describe("FUS-TEXT-002 acceptance fixture", () => {
  it("keeps every industrial effect on the shared runtime contract", () => {
    expect(FUS_TEXT_002.expectedEffects.every(isFusionExpectedEffect)).toBe(true);
  });

  it("uses native Fusion operations for every required industrial feature", () => {
    for (const signature of [
      "Datum A - Base Bottom",
      "Datum B - Wall Front",
      "Datum C - Base Left",
      "Bearing Seat",
      "Retaining Recess - Datum B Only",
      "Counterbored Mounting Hole",
      "Gusset",
      "Grease Port M6x1",
      "threadFeatures",
      "Base Corner Fillets",
      "Structural Fillets",
      "Gusset Root Fillets",
      "sectionAnalyses.createInput",
      "Bearing Mouth Chamfers",
      "Grease Port Entry Chamfer",
      "Base Perimeter Chamfer",
    ]) {
      expect(FUS_TEXT_002_ACTION_BODY).toContain(signature);
    }
  });
});

describe("FUS-IMAGE-001 acceptance fixture", () => {
  it("pins the supplied drawing and keeps every effect on the runtime contract", () => {
    expect(FUS_IMAGE_001.reference.sha256).toBe("80bc33c78bcd890486f7b48ed1845491422384d6445428a9575e74f6ec4ab86c");
    expect(FUS_IMAGE_001.expectedEffects.every(isFusionExpectedEffect)).toBe(true);
  });

  it("uses native bracket, hole, fillet, chamfer, material, and appearance operations", () => {
    for (const signature of ["Base Extrude", "Upright Extrude", "holeFeatures.createSimpleInput", "Inside Junction Fillet", "Exposed Outside Chamfers", "ABS", "240, 100, 20", "sketchDimensions.addDistanceDimension", "base_hole_x_1", "upright_hole_height", "register_entity"]) {
      expect(FUS_IMAGE_001_ACTION_BODY).toContain(signature);
    }
  });
});

describe("multimodal and manual-revision acceptance fixtures", () => {
  it("provides trusted typed effects for every case that expects completion", () => {
    expect(FUS_MM_COMPLETION_FIXTURES.map((fixture) => fixture.id)).toEqual([
      "FUS-MM-101", "FUS-MM-102", "FUS-MM-103", "FUS-MM-105", "FUS-MM-106", "FUS-MM-108", "FUS-MM-109",
    ]);
    expect(FUS_MM_COMPLETION_FIXTURES.every((fixture) => fixture.expectedEffects.every(isFusionExpectedEffect))).toBe(true);
  });
});
