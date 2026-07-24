import { describe, expect, it } from "vitest";
import {
  LOOP_OWNED_CHECK_POLICY,
  compareCheckSets,
  compareVerificationCheck,
  verificationCheckRevisionGate,
  type FrozenVerificationCheck,
} from "./verificationChecks";

function check(id: string, criterion: Record<string, unknown>): FrozenVerificationCheck {
  return { id, componentId: "part", kind: String(criterion.kind), criterion };
}

describe("loop-owned verification check comparator", () => {
  it("classifies added, unchanged, and removed identities mechanically", () => {
    const volume = check("volume", { kind: "volume", range_mm3: [10, 20], target: "part" });
    const added = check("wall", { kind: "wall_thickness", range_mm: [2, 4], target: "part" });

    expect(compareCheckSets([volume], [volume])).toMatchObject({ verdict: "equal" });
    expect(compareCheckSets([volume], [volume, added])).toMatchObject({ verdict: "tighten" });
    expect(compareCheckSets([volume, added], [volume])).toMatchObject({ verdict: "loosen" });
  });

  it.each([
    [
      "volume and wall ranges narrow from either side",
      { kind: "volume", range_mm3: [10, 20] },
      { kind: "volume", range_mm3: [11, 20] },
      "tighten",
    ],
    [
      "clearance raises the minimum and introduces a maximum",
      { kind: "clearance", a: "a", b: "b", min_mm: 1 },
      { kind: "clearance", a: "a", b: "b", min_mm: 2, max_mm: 5 },
      "tighten",
    ],
    [
      "count range narrows to an exact count",
      { kind: "count_faces", count: [4, 8] },
      { kind: "count_faces", count: 6 },
      "tighten",
    ],
    [
      "exact count cannot change",
      { kind: "count_edges", count: 12 },
      { kind: "count_edges", count: 13 },
      "loosen",
    ],
    [
      "hole diameter tolerance interval narrows",
      { kind: "hole_through", diameter: 6, tol: 0.5, count: 4 },
      { kind: "hole_through", diameter: 6.1, tol: 0.2, count: 4 },
      "tighten",
    ],
    [
      "bbox tolerance narrows with axis-order-insensitive dimensions",
      { kind: "bbox", size_mm: [10, 20, 30] },
      { kind: "bbox", size_mm: [30, 10, 20], tol: 0.25 },
      "tighten",
    ],
    [
      "symmetry tolerance narrows",
      { kind: "symmetric", plane: "XY", tol_pct: 1 },
      { kind: "symmetric", plane: "XY", tol_pct: 0.5 },
      "tighten",
    ],
    [
      "target changes are loosening",
      { kind: "wall_thickness", range_mm: [2, 4], target: "left" },
      { kind: "wall_thickness", range_mm: [2, 4], target: "right" },
      "loosen",
    ],
    [
      "Fusion expected effects are frozen unless byte-for-byte equal",
      { kind: "fusion_effect", effect: { kind: "body-count", expected: 1 } },
      { kind: "fusion_effect", effect: { kind: "body-count", expected: 2 } },
      "loosen",
    ],
  ])("%s", (_name, previous, next, verdict) => {
    expect(compareVerificationCheck(check("criterion", previous), check("criterion", next)).verdict).toBe(verdict);
  });

  it("treats equal boundaries and omitted defaults consistently", () => {
    expect(LOOP_OWNED_CHECK_POLICY.defaultToleranceMm).toBe(0.5);
    expect(compareVerificationCheck(
      check("bbox", { kind: "bbox", size_mm: [10, 20, 30] }),
      check("bbox", { kind: "bbox", size_mm: [10, 20, 30], tol: 0.5 }),
    ).verdict).toBe("equal");
    expect(compareVerificationCheck(
      check("count", { kind: "count_faces", count: [4, 8] }),
      check("count", { kind: "count_faces", count: [4, 8] }),
    ).verdict).toBe("equal");
  });

  it("rejects interval widening on only one side", () => {
    const previous = check("wall", { kind: "wall_thickness", range_mm: [2, 4] });
    expect(compareVerificationCheck(previous, check("wall", { kind: "wall_thickness", range_mm: [1.9, 4] })).verdict).toBe("loosen");
    expect(compareVerificationCheck(previous, check("wall", { kind: "wall_thickness", range_mm: [2, 4.1] })).verdict).toBe("loosen");
  });

  it("holds loosening until a resolved design escalation authorizes it", () => {
    const previous = [check("wall", { kind: "wall_thickness", range_mm: [2, 4] })];
    const widened = [check("wall", { kind: "wall_thickness", range_mm: [1, 5] })];

    expect(verificationCheckRevisionGate(previous, widened)).toMatchObject({ passed: false, verdict: "loosen" });
    expect(verificationCheckRevisionGate(previous, widened, "relax-wall-range")).toEqual({
      passed: true,
      verdict: "loosen",
      authorizedByEscalationId: "relax-wall-range",
    });
  });

  const perKindBoundaries: Array<[
    string,
    Record<string, unknown>,
    Record<string, unknown>,
    "tighten" | "equal" | "loosen",
  ]> = [
    ["volume lower boundary narrows", { kind: "volume", range_mm3: [10, 20] }, { kind: "volume", range_mm3: [10.001, 20] }, "tighten"],
    ["volume upper boundary widens", { kind: "volume", range_mm3: [10, 20] }, { kind: "volume", range_mm3: [10, 20.001] }, "loosen"],
    ["wall lower boundary widens", { kind: "wall_thickness", range_mm: [2, 4] }, { kind: "wall_thickness", range_mm: [1.999, 4] }, "loosen"],
    ["wall upper boundary narrows", { kind: "wall_thickness", range_mm: [2, 4] }, { kind: "wall_thickness", range_mm: [2, 3.999] }, "tighten"],
    ["face count lower bound narrows", { kind: "count_faces", count: [4, 8] }, { kind: "count_faces", count: [5, 8] }, "tighten"],
    ["face count lower bound widens", { kind: "count_faces", count: [4, 8] }, { kind: "count_faces", count: [3, 8] }, "loosen"],
    ["edge count upper bound narrows", { kind: "count_edges", count: [8, 12] }, { kind: "count_edges", count: [8, 11] }, "tighten"],
    ["edge count upper bound widens", { kind: "count_edges", count: [8, 12] }, { kind: "count_edges", count: [8, 13] }, "loosen"],
    ["clearance maximum is introduced", { kind: "clearance", a: "a", b: "b", min_mm: 1 }, { kind: "clearance", a: "a", b: "b", min_mm: 1, max_mm: 5 }, "tighten"],
    ["clearance maximum is removed", { kind: "clearance", a: "a", b: "b", min_mm: 1, max_mm: 5 }, { kind: "clearance", a: "a", b: "b", min_mm: 1 }, "loosen"],
    ["bbox explicit default equals omitted default", { kind: "bbox", size_mm: [10, 20, 30], tol: 0.5 }, { kind: "bbox", size_mm: [10, 20, 30] }, "equal"],
    ["bbox tolerance widens beyond default", { kind: "bbox", size_mm: [10, 20, 30] }, { kind: "bbox", size_mm: [10, 20, 30], tol: 0.501 }, "loosen"],
    ["through-hole tolerance narrows", { kind: "hole_through", diameter: 6, tol: 0.5, count: 2 }, { kind: "hole_through", diameter: 6, tol: 0.499, count: 2 }, "tighten"],
    ["through-hole count changes", { kind: "hole_through", diameter: 6, count: 2 }, { kind: "hole_through", diameter: 6, count: 3 }, "loosen"],
    ["blind-hole tolerance narrows", { kind: "hole_blind", diameter: 6, tol: 0.5, count: 2 }, { kind: "hole_blind", diameter: 6, tol: 0.499, count: 2 }, "tighten"],
    ["blind-hole location changes", { kind: "hole_blind", diameter: 6, count: 2, at_mm: [1, 2] }, { kind: "hole_blind", diameter: 6, count: 2, at_mm: [1, 3] }, "loosen"],
    ["internal-hole tolerance narrows", { kind: "hole_internal", diameter: 6, tol: 0.5, count: 2 }, { kind: "hole_internal", diameter: 6, tol: 0.499, count: 2 }, "tighten"],
    ["internal-hole target changes", { kind: "hole_internal", diameter: 6, count: 2, target: "a" }, { kind: "hole_internal", diameter: 6, count: 2, target: "b" }, "loosen"],
    ["symmetry zero boundary is equal", { kind: "symmetric", plane: "XY", tol_pct: 0 }, { kind: "symmetric", plane: "XY", tol_pct: 0 }, "equal"],
    ["symmetry tolerance widens from zero", { kind: "symmetric", plane: "XY", tol_pct: 0 }, { kind: "symmetric", plane: "XY", tol_pct: 0.001 }, "loosen"],
    ["Fusion effect key order is equal", { kind: "fusion_effect", effect: { kind: "body-count", expected: 1 } }, { kind: "fusion_effect", effect: { expected: 1, kind: "body-count" } }, "equal"],
    ["Fusion effect value changes", { kind: "fusion_effect", effect: { kind: "body-count", expected: 1 } }, { kind: "fusion_effect", effect: { kind: "body-count", expected: 2 } }, "loosen"],
  ];

  it.each(perKindBoundaries)("covers %s", (_name, previous, next, verdict) => {
    expect(compareVerificationCheck(check("boundary", previous), check("boundary", next)).verdict).toBe(verdict);
  });
});
