// @test-kind: contract
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/manifest-sources.js';

function load(path: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8')) as unknown;
}

describe('evaluation scorer audit', () => {
  it('publishes objective coverage and zero-pass negative controls for all 24 cases', () => {
    const audit = load('evals/audits/v2-scorer-audit.json') as {
      reviewPopulation: {
        declaredCases: number;
        declaredAcceptanceVerifiers: number;
        declaredForbiddenVerifiers: number;
        objectiveVerifiers: number;
        deterministicSubjectiveClassificationVerifiers: number;
        semanticVerifiers: number;
      };
      negativeControl: { cases: number; expectedTaskPasses: number; observedTaskPasses: number; falsePositiveRate: number };
      interReviewerAgreement: { status: string };
    };
    const documents = [
      load('evals/cases.json'),
      load('evals/server-cases.json'),
    ] as { cases: {
      acceptanceVerifiers: { criterionType: string }[];
      forbiddenVerifiers: { criterionType: string }[];
    }[] }[];
    const cases = documents.flatMap(document => document.cases);
    const acceptance = cases.flatMap(entry => entry.acceptanceVerifiers);
    const forbidden = cases.flatMap(entry => entry.forbiddenVerifiers);
    expect(audit.reviewPopulation).toMatchObject({
      declaredCases: cases.length,
      declaredAcceptanceVerifiers: acceptance.length,
      declaredForbiddenVerifiers: forbidden.length,
      objectiveVerifiers: 132,
      deterministicSubjectiveClassificationVerifiers: 1,
      semanticVerifiers: 0,
    });
    expect([...acceptance, ...forbidden].filter(entry => entry.criterionType === 'objective')).toHaveLength(132);
    expect([...acceptance, ...forbidden].filter(entry => entry.criterionType === 'subjective')).toHaveLength(1);
    expect(audit.negativeControl).toMatchObject({
      cases: 24,
      expectedTaskPasses: 0,
      observedTaskPasses: 0,
      falsePositiveRate: 0,
    });
    expect(audit.interReviewerAgreement.status).toBe('not_applicable');
  });
});
