/**
 * Scrubbed run CHECKS from sequence 54 of the gate-gaming forensic session.
 * The run kept envelope, nozzle, symmetry, and volume while silently dropping
 * the planned wall, button, and boss checks.
 */
export const SEQ54_RUN_CHECKS: Record<string, unknown>[] = [
  { kind: "bbox", size_mm: [180, 95, 260], tol: 1.5, target: "shell" },
  { kind: "hole_through", diameter: 18, count: 1, tol: 0.8, target: "shell" },
  { kind: "symmetric", plane: "YZ", tol_pct: 3, target: "shell" },
  { kind: "volume", range_mm3: [130000, 190000], target: "shell" },
];
