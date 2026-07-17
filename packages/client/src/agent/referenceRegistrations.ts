import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ReferenceRecordDto, ReferenceRegistrationDto } from "@chamfer/shared";

export const REFERENCE_REGISTRATIONS_CONTEXT_MARKER = "[Current reference registrations]";

export function currentReferenceRegistrations(
  registrations: readonly ReferenceRegistrationDto[],
): ReferenceRegistrationDto[] {
  return registrations.filter((registration) => registration.status === "current");
}

export function unregisteredReferenceIds(
  references: readonly ReferenceRecordDto[],
  registrations: readonly ReferenceRegistrationDto[],
): string[] {
  const registered = new Set(currentReferenceRegistrations(registrations).map((registration) => registration.referenceId));
  return references
    .filter((reference) => reference.status === "active" || reference.status === "complementary")
    .map((reference) => reference.referenceId)
    .filter((referenceId) => !registered.has(referenceId));
}

export function referenceRegistrationGateError(referenceIds: readonly string[]): string {
  return `run_build123d is blocked because active reference images have no deterministic proof registration: ${referenceIds.join(", ")}. Call register_reference_view for each reference before the first non-probe CAD run. Perspective, unscaled, occluded, or extraction-failed references may be registered as advisory evidence with a visible reason.`;
}

function projectionText(registrations: readonly ReferenceRegistrationDto[]): string {
  const rows = currentReferenceRegistrations(registrations).map((registration) => {
    const scale = registration.geometry.scaleTransform
      ? `${registration.geometry.scaleTransform.physicalLengthMm} mm at ${registration.geometry.scaleTransform.mmPerPixel.toFixed(6)} mm/px`
      : "unscaled";
    return `- ${registration.registrationId}@${registration.revision}: reference=${registration.referenceId}; projection=${registration.projection}; direction=${registration.direction ?? "unresolved"}; scale=${scale}; extraction=${registration.geometry.extraction.status}; landmarks=${JSON.stringify(registration.visibleLandmarks)}; uncertainty=${registration.uncertainty.level}; eligibility=${registration.eligibility.status}; reasons=${JSON.stringify(registration.eligibility.reasons)}`;
  });
  return `${REFERENCE_REGISTRATIONS_CONTEXT_MARKER}\nRegistrations are system-derived proof inputs. Do not infer mask, contour, scale, or eligibility from later CAD geometry.\n${rows.join("\n")}`;
}

export function projectReferenceRegistrations(
  messages: AgentMessage[],
  registrations: readonly ReferenceRegistrationDto[],
): AgentMessage[] {
  const current = currentReferenceRegistrations(registrations);
  if (current.length === 0) return messages;
  const withoutPrior = messages.filter((message) => {
    const content = (message as { content?: unknown }).content;
    return !Array.isArray(content) || !content.some((block) =>
      typeof block === "object" && block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string" &&
      (block as { text: string }).text.startsWith(REFERENCE_REGISTRATIONS_CONTEXT_MARKER),
    );
  });
  return [{
    role: "user",
    content: [{ type: "text", text: projectionText(current) }],
    timestamp: current[0]!.timestamp,
  } as AgentMessage, ...withoutPrior];
}
