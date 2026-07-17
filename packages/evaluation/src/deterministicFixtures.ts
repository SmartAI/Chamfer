import { Check, Errors } from "typebox/value";
import { Type, type Static } from "typebox";
import { scoreObservation, type EvaluationObservation } from "./scoring";
import { ExpectedOutcomeSchema, RequiredProofEvidenceSchema } from "./schema";

const DeterministicFixtureSchema = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{2,63}$" }),
  expectation: Type.Object({
    expectedOutcome: ExpectedOutcomeSchema,
    requiredProofEvidence: Type.Array(RequiredProofEvidenceSchema, { uniqueItems: true }),
    knownNegative: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  observation: Type.Object({
    provider: Type.String({ minLength: 1 }),
    model: Type.String({ minLength: 1 }),
    promptVersion: Type.String({ minLength: 1 }),
    latencyMs: Type.Number({ minimum: 0 }),
    tokenUse: Type.Object({
      input: Type.Number({ minimum: 0 }),
      output: Type.Number({ minimum: 0 }),
      total: Type.Number({ minimum: 0 }),
    }, { additionalProperties: false }),
    cadRunCount: Type.Integer({ minimum: 0 }),
    finalStatus: Type.Union([
      ExpectedOutcomeSchema,
      Type.Literal("unproven"),
      Type.Literal("error"),
    ]),
    evidence: Type.Array(RequiredProofEvidenceSchema, { uniqueItems: true }),
    proofIdentities: Type.Object({
      proofPolicyId: Type.String({ minLength: 1 }),
      proofPolicyVersion: Type.Integer({ minimum: 1 }),
    }, { additionalProperties: true }),
    infrastructureError: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  expected: Type.Object({
    passed: Type.Boolean(),
    falseProven: Type.Boolean(),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const DeterministicFixtureCorpusSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  fixtureVersion: Type.Integer({ minimum: 1 }),
  fixtures: Type.Array(DeterministicFixtureSchema, { minItems: 1 }),
}, { additionalProperties: false });

type DeterministicFixtureCorpus = Static<typeof DeterministicFixtureCorpusSchema>;

export interface DeterministicFixtureResult {
  id: string;
  passed: boolean;
  falseProven: boolean;
  expectedPassed: boolean;
  expectedFalseProven: boolean;
  matched: boolean;
}

export interface DeterministicFixtureReport {
  fixtureVersion: number;
  fixtureCount: number;
  matchedCount: number;
  allMatched: boolean;
  results: DeterministicFixtureResult[];
}

function validationMessage(value: unknown): string {
  return [...Errors(DeterministicFixtureCorpusSchema, value)]
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
}

export function runDeterministicFixtures(value: unknown): DeterministicFixtureReport {
  if (!Check(DeterministicFixtureCorpusSchema, value)) {
    throw new Error(`Invalid deterministic evaluator fixtures: ${validationMessage(value)}`);
  }
  const corpus = value as DeterministicFixtureCorpus;
  const ids = new Set<string>();
  const results = corpus.fixtures.map((fixture): DeterministicFixtureResult => {
    if (ids.has(fixture.id)) throw new Error(`Invalid deterministic evaluator fixtures: duplicate id ${fixture.id}`);
    ids.add(fixture.id);
    const score = scoreObservation(fixture.expectation, fixture.observation as EvaluationObservation);
    const matched = score.passed === fixture.expected.passed &&
      score.falseProven === fixture.expected.falseProven;
    return {
      id: fixture.id,
      passed: score.passed,
      falseProven: score.falseProven,
      expectedPassed: fixture.expected.passed,
      expectedFalseProven: fixture.expected.falseProven,
      matched,
    };
  });
  const matchedCount = results.filter((result) => result.matched).length;
  return {
    fixtureVersion: corpus.fixtureVersion,
    fixtureCount: results.length,
    matchedCount,
    allMatched: matchedCount === results.length,
    results,
  };
}
