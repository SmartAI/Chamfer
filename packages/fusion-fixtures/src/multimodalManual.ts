import type { FusionEvidenceView, FusionExpectedEffect } from "@chamfer/shared";

const STANDARD_VIEWS: FusionEvidenceView[] = ["front", "back", "left", "right", "top", "bottom", "isometric"];

/** Trusted deterministic expectations for the ticket-18 cases whose expected
 * outcome is completion. Escalation cases deliberately have no geometry
 * fixture: their authoritative result is no mutation plus focused evidence. */
export const FUS_MM_COMPLETION_FIXTURES = [
  {
    id: "FUS-MM-101",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [110, 70, 12], toleranceMm: 0.05 },
      { kind: "holes", expected: 4, diameterMm: 8.5, edgeOffsetMm: 15, through: true, toleranceMm: 0.05 },
      { kind: "feature", featureType: "ExtrudeFeature", name: "Centered Pocket", minCount: 1, maxCount: 1 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
  {
    id: "FUS-MM-102",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [150, 24, 100], toleranceMm: 0.05 },
      { kind: "parameter", name: "bearing_bore", expectedMm: 55, toleranceMm: 0.05 },
      { kind: "parameter", name: "rear_boss_depth", expectedMm: 12, toleranceMm: 0.05 },
      { kind: "holes", expected: 2, diameterMm: 12, through: true, toleranceMm: 0.05 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
  {
    id: "FUS-MM-103",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [140, 70, 10], toleranceMm: 0.05 },
      { kind: "parameter", name: "hole_spacing", expectedMm: 76, toleranceMm: 0.05 },
      { kind: "holes", expected: 2, diameterMm: 12, through: true, toleranceMm: 0.05 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
  {
    id: "FUS-MM-105",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [160, 72, 12], toleranceMm: 0.05 },
      { kind: "holes", expected: 2, diameterMm: 10, through: true, toleranceMm: 0.05 },
      { kind: "feature", featureType: "ExtrudeFeature", name: "Rounded Slot", minCount: 1, maxCount: 1 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
  {
    id: "FUS-MM-106",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "parameter", name: "base_width", expectedMm: 112, toleranceMm: 0.05 },
      { kind: "holes", expected: 2, diameterMm: 12, through: true, toleranceMm: 0.05 },
      { kind: "feature", featureType: "FilletFeature", name: "Outer Fillets", minCount: 1, maxCount: 1, expectedSizeMm: 3, toleranceMm: 0.05 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
  {
    id: "FUS-MM-108",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [150, 90, 14], toleranceMm: 0.05 },
      { kind: "parameter", name: "bearing_bore", expectedMm: 40, toleranceMm: 0.05 },
      { kind: "feature", featureType: "ExtrudeFeature", name: "Manual Rib", minCount: 1, maxCount: 1 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
  {
    id: "FUS-MM-109",
    expectedEffects: [
      { kind: "body-count", expected: 1 },
      { kind: "dimensions", expectedMm: [120, 80, 68], toleranceMm: 0.05 },
      { kind: "feature", featureType: "ExtrudeFeature", name: "Pocket", minCount: 1, maxCount: 1 },
      { kind: "feature", featureType: "ChamferFeature", name: "Pocket Entrance Chamfer", minCount: 1, maxCount: 1, expectedSizeMm: 1.5, toleranceMm: 0.05 },
      { kind: "visual-evidence", requiredViews: STANDARD_VIEWS },
    ] satisfies FusionExpectedEffect[],
  },
] as const;
