import {
  ALARM_FILLED_PARAMETERS,
  ENRICHMENT_EXEMPTIONS,
  EnrichmentExemption,
  RUNBOOK_CATALOGUE,
  RUNBOOK_DOC_BASE_URL,
  RUNBOOK_DOC_PATH,
  RunbookDefinition,
  assertValidRunbookCatalogue,
  exemptionForTopic,
  firstStepDocumentName,
  matchesPattern,
  requiredDocumentKeys,
  runbookUrl,
  runbooksForAlarm,
  validateRunbookCatalogue,
} from '../lib/runbooks';

/**
 * Rules over the catalogue itself.
 *
 * Every rule is asserted twice: once that the shipped catalogue satisfies it,
 * and once that a catalogue breaking it is reported. A validator whose rule
 * stopped firing is indistinguishable from a catalogue with nothing wrong in it,
 * and that is the failure worth guarding — the whole gate is one function
 * returning an empty array.
 */

const VALID: RunbookDefinition = {
  id: 'test-runbook',
  title: 'A thing is broken',
  owner: 'platform-team',
  anchor: '#2-a-thing-is-broken',
  alarmNamePatterns: ['*-thing-broken'],
  summary: 'The thing is broken and somebody has to look at it.',
  firstStep: {
    documentKey: 'thing-state',
    summary: 'reads the thing',
    alarmFilledParameters: [],
  },
};

const VALID_EXEMPTION: EnrichmentExemption = {
  topicNamePattern: '*-elsewhere',
  reason:
    'This topic lives in another region and SNS cannot deliver to a Lambda outside its own, ' +
    'so enriching it needs a second stack the consumer may not want.',
};

const rulesFor = (
  catalogue: readonly RunbookDefinition[],
  exemptions: readonly EnrichmentExemption[] = [VALID_EXEMPTION],
): string[] => validateRunbookCatalogue(catalogue, exemptions).map((finding) => finding.rule);

describe('the shipped catalogue', () => {
  it('passes every rule', () => {
    expect(validateRunbookCatalogue()).toEqual([]);
  });

  it('is what assertValidRunbookCatalogue accepts', () => {
    expect(() => assertValidRunbookCatalogue()).not.toThrow();
  });

  it('covers the alarm families this repository actually creates', () => {
    // Named alarms taken from the synthesised templates. If a stack renames one,
    // the audit gate reports it against the real templates — this is the cheap
    // half, and it fails in a unit test rather than after a synth.
    const alarms = [
      'production-alb-5xx-elb',
      'production-ecs-cpu-high',
      'production-rds-connections-high',
      'production-api-availability-burn-fast',
      'production-api-availability-budget-exhausted',
      'production-api-availability-no-data',
      'production-slo-burn-rate-fast',
      'production-log-pipeline-records-dropped',
      'production-log-scrubber-failing',
      'production-canary-health-quorum',
      'production-home-eu-west-1-failed',
      'production-waf-blocked-requests',
      'production-runbook-enricher-errors',
      'DoraMetricsStack-lead-time-unmeasurable',
      'FeatureFlagLifecycleStack-expired-feature-flags',
    ];
    for (const alarm of alarms) {
      expect(runbooksForAlarm(alarm).map((runbook) => runbook.id)).toHaveLength(1);
    }
  });

  it('routes each of those alarms to a runbook whose first step exists in the catalogue', () => {
    for (const runbook of RUNBOOK_CATALOGUE) {
      expect(requiredDocumentKeys()).toContain(runbook.firstStep.documentKey);
    }
  });

  it('names only parameters the enricher can fill', () => {
    for (const runbook of RUNBOOK_CATALOGUE) {
      for (const parameter of runbook.firstStep.alarmFilledParameters) {
        expect(ALARM_FILLED_PARAMETERS).toContain(parameter);
      }
    }
  });
});

describe('pattern matching', () => {
  it('treats * as any run and ? as one character', () => {
    expect(matchesPattern('*-burn-fast', 'production-api-availability-burn-fast')).toBe(true);
    expect(matchesPattern('*-burn-fast', 'production-slo-burn-rate-fast')).toBe(false);
    expect(matchesPattern('*-canary-*-*-?', 'production-canary-us-east-1')).toBe(true);
    expect(matchesPattern('*-canary-*-*-?', 'production-canary-ticket')).toBe(false);
  });

  it('anchors at both ends, so a pattern is not a substring search', () => {
    expect(matchesPattern('ecs-cpu-high', 'production-ecs-cpu-high')).toBe(false);
  });

  it('escapes regex metacharacters in the literal parts', () => {
    // A pattern containing a dot must not match any character in its place —
    // alarm names are full of dots nowhere and hyphens everywhere, and a
    // matcher that treated `.` as a wildcard would quietly widen every pattern.
    expect(matchesPattern('a.c', 'abc')).toBe(false);
    expect(matchesPattern('a.c', 'a.c')).toBe(true);
  });

  it('returns every match, so ambiguity is visible to the caller', () => {
    const catalogue = [VALID, { ...VALID, id: 'other-runbook', anchor: '#3-other' }];
    expect(runbooksForAlarm('some-thing-broken', catalogue)).toHaveLength(2);
  });
});

describe('links and names', () => {
  it('builds a runbook URL from the base, the doc path and the anchor', () => {
    expect(runbookUrl(VALID)).toBe(
      `${RUNBOOK_DOC_BASE_URL}/${RUNBOOK_DOC_PATH}#2-a-thing-is-broken`,
    );
  });

  it('does not double the slash when the base carries one', () => {
    expect(runbookUrl(VALID, 'https://docs.invalid/')).toBe(
      `https://docs.invalid/${RUNBOOK_DOC_PATH}#2-a-thing-is-broken`,
    );
  });

  it('names a first-step document per environment', () => {
    expect(firstStepDocumentName('production', 'ecs-service-state')).toBe(
      'production-rb-ecs-service-state',
    );
  });

  it('de-duplicates the document keys two runbooks share', () => {
    const shared = { ...VALID, id: 'second', anchor: '#3-second' };
    expect(requiredDocumentKeys([VALID, shared])).toEqual(['thing-state']);
  });
});

describe('exemptions', () => {
  it('matches a topic by pattern', () => {
    expect(exemptionForTopic('production-canary-us-east-1')?.topicNamePattern).toBe(
      '*-canary-*-*-?',
    );
  });

  it('does not exempt the topics the enricher is expected to cover', () => {
    for (const topic of [
      'production-cloudwatch-alarms',
      'production-slo-page',
      'production-log-pipeline-alerts',
      'production-waf-alerts',
    ]) {
      expect(exemptionForTopic(topic)).toBeUndefined();
    }
  });

  it('gives every shipped exemption a reason long enough to be one', () => {
    for (const exemption of ENRICHMENT_EXEMPTIONS) {
      expect(exemption.reason.length).toBeGreaterThan(40);
    }
  });

  it('reports an exemption with no reason behind it', () => {
    expect(rulesFor([VALID], [{ topicNamePattern: '*-x', reason: 'regional' }])).toContain(
      'exemption-without-reason',
    );
  });

  it('reports an exemption that turns the rule off entirely', () => {
    expect(rulesFor([VALID], [{ ...VALID_EXEMPTION, topicNamePattern: '*' }])).toContain(
      'exemption-pattern-catch-all',
    );
  });
});

describe('catalogue rules', () => {
  it('accepts the fixture the other cases are built from', () => {
    expect(rulesFor([VALID])).toEqual([]);
  });

  it('reports an empty catalogue', () => {
    expect(rulesFor([])).toContain('catalogue-empty');
  });

  it('reports an id that is not kebab-case', () => {
    expect(rulesFor([{ ...VALID, id: 'Test_Runbook' }])).toContain('id-not-kebab-case');
  });

  it('reports a missing title or summary', () => {
    expect(rulesFor([{ ...VALID, title: '  ' }])).toContain('title-missing');
    expect(rulesFor([{ ...VALID, summary: '' }])).toContain('summary-missing');
  });

  it('reports an owner who is a person', () => {
    expect(rulesFor([{ ...VALID, owner: 'alex@example.com' }])).toContain(
      'owner-is-an-individual',
    );
    expect(rulesFor([{ ...VALID, owner: '' }])).toContain('owner-missing');
  });

  it('reports an anchor that is not a GitHub slug', () => {
    expect(rulesFor([{ ...VALID, anchor: '2-a-thing' }])).toContain('anchor-malformed');
    expect(rulesFor([{ ...VALID, anchor: '#A Thing' }])).toContain('anchor-malformed');
  });

  it('reports a runbook no alarm can reach', () => {
    expect(rulesFor([{ ...VALID, alarmNamePatterns: [] }])).toContain('no-alarm-patterns');
  });

  it('reports a catch-all pattern, which makes every coverage rule pass', () => {
    expect(rulesFor([{ ...VALID, alarmNamePatterns: ['*'] }])).toContain(
      'alarm-pattern-catch-all',
    );
  });

  it('reports a pattern that is empty or padded', () => {
    expect(rulesFor([{ ...VALID, alarmNamePatterns: [' *-thing'] }])).toContain(
      'alarm-pattern-malformed',
    );
  });

  it('reports two entries with the same id', () => {
    expect(rulesFor([VALID, { ...VALID, anchor: '#3-other' }])).toContain('duplicate-id');
  });

  it('reports two entries pointing at one section', () => {
    expect(rulesFor([VALID, { ...VALID, id: 'other' }])).toContain('duplicate-anchor');
  });

  it('reports one pattern claimed by two entries', () => {
    expect(rulesFor([VALID, { ...VALID, id: 'other', anchor: '#3-other' }])).toContain(
      'duplicate-alarm-pattern',
    );
  });

  it('reports a document key that is not kebab-case', () => {
    expect(
      rulesFor([{ ...VALID, firstStep: { ...VALID.firstStep, documentKey: 'Thing State' } }]),
    ).toContain('document-key-not-kebab-case');
  });

  it('reports a first step with no summary', () => {
    expect(
      rulesFor([{ ...VALID, firstStep: { ...VALID.firstStep, summary: '' } }]),
    ).toContain('first-step-summary-missing');
  });

  it('reports a parameter the enricher cannot read from a notification', () => {
    expect(
      rulesFor([
        {
          ...VALID,
          firstStep: {
            ...VALID.firstStep,
            // Present on a metric alarm's notification and absent from a
            // composite alarm's, which is why it is not an accepted value.
            alarmFilledParameters: ['MetricName' as never],
          },
        },
      ]),
    ).toContain('alarm-filled-parameter-unknown');
  });

  it('reports the same parameter listed twice', () => {
    expect(
      rulesFor([
        {
          ...VALID,
          firstStep: { ...VALID.firstStep, alarmFilledParameters: ['AlarmName', 'AlarmName'] },
        },
      ]),
    ).toContain('alarm-filled-parameter-duplicated');
  });

  it('throws with every finding at once rather than the first', () => {
    expect(() =>
      assertValidRunbookCatalogue([{ ...VALID, id: 'Bad Id', owner: 'a@b.com' }]),
    ).toThrow(/id-not-kebab-case[\s\S]*owner-is-an-individual/);
  });
});
