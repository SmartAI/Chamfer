import { describe, expect, it } from "vitest";
import { orthographicFrame, tileRect } from "./viewSheet";

describe("view sheet layout", () => {
  it("places eight 350px tiles in a 4 by 2 sheet", () => {
    expect(tileRect(0)).toEqual({ x: 0, y: 0, width: 350, height: 350 });
    expect(tileRect(3)).toEqual({ x: 1050, y: 0, width: 350, height: 350 });
    expect(tileRect(4)).toEqual({ x: 0, y: 350, width: 350, height: 350 });
    expect(tileRect(7)).toEqual({ x: 1050, y: 350, width: 350, height: 350 });
  });

  it("frames the complete bounding sphere with padding", () => {
    const frame = orthographicFrame(10);

    expect(frame.left).toBeLessThanOrEqual(-10);
    expect(frame.right).toBeGreaterThanOrEqual(10);
    expect(frame.bottom).toBeLessThanOrEqual(-10);
    expect(frame.top).toBeGreaterThanOrEqual(10);
    expect(frame.near).toBeGreaterThan(0);
    expect(frame.far - frame.distance).toBeGreaterThanOrEqual(10);
    expect(frame.distance - frame.near).toBeGreaterThanOrEqual(10);
  });
});
