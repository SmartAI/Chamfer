import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReferenceRegistrationDto } from "@chamfer/shared";
import { ReferenceRegistrationsCard } from "./ReferenceRegistrationsCard";

const registration: ReferenceRegistrationDto = {
  registrationId: "registration-1",
  conversationId: "conversation-1",
  revision: 1,
  status: "current",
  referenceId: "reference-1",
  sourceRegion: { x: 0, y: 0, width: 1, height: 1 },
  projection: "orthographic",
  direction: "front",
  scaleAnchor: {
    specificationId: "width",
    start: { x: 0.1, y: 0.9 },
    end: { x: 0.9, y: 0.9 },
    physicalLengthMm: 10,
  },
  visibleLandmarks: [{ id: "hole", label: "Center hole", position: { x: 0.5, y: 0.5 } }],
  uncertainty: { level: "low", notes: "Clear outline.", occluded: false },
  geometry: {
    sourceSizePx: { width: 100, height: 100 },
    regionPx: { x: 0, y: 0, width: 100, height: 100 },
    extraction: { status: "succeeded", extractor: { id: "opencv-js-contour", version: 1 } },
    mask: { width: 100, height: 100, rle: [0, 10_000] },
    contour: { points: [[1, 1], [98, 1], [98, 98], [1, 98]], areaPx2: 9_409 },
    scaleTransform: { specificationId: "width", physicalLengthMm: 10, pixelLength: 80, mmPerPixel: 0.125 },
  },
  eligibility: { status: "eligible", reasons: [] },
  timestamp: 10,
};

describe("ReferenceRegistrationsCard", () => {
  it("summarizes eligibility and reveals contour, scale, landmarks, and uncertainty", () => {
    render(<ReferenceRegistrationsCard registrations={[registration]} />);
    expect(screen.getByTestId("reference-registration-card").getAttribute("data-eligibility")).toBe("eligible");
    expect(screen.getByText(/Front orthographic/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("reference-registration-toggle"));
    expect(screen.getByTestId("reference-contour-preview")).toBeTruthy();
    expect(screen.getByText(/0.1250 mm\/px/)).toBeTruthy();
    expect(screen.getByText(/1 landmarks/)).toBeTruthy();
    expect(screen.getByText(/Uncertainty: low/)).toBeTruthy();
  });

  it("shows advisory reasons without a positive eligibility signal", () => {
    const advisory = {
      ...registration,
      projection: "perspective" as const,
      direction: undefined,
      scaleAnchor: undefined,
      geometry: { ...registration.geometry, scaleTransform: undefined },
      eligibility: {
        status: "advisory" as const,
        reasons: ["Perspective projection cannot support physical shape proof.", "Physical scale is not established."],
      },
    };
    render(<ReferenceRegistrationsCard registrations={[advisory]} />);
    expect(screen.getByTestId("reference-registration-card").getAttribute("data-eligibility")).toBe("advisory");
    fireEvent.click(screen.getByTestId("reference-registration-toggle"));
    expect(screen.getByTestId("reference-registration-reasons").textContent).toContain("Physical scale is not established");
  });
});
