import {
  ACTION_ITEM_CLASSES,
  BLAMELESS_REVIEW_CHECKLIST,
  BLAME_LANGUAGE,
  BUDGET_TRIGGER_OBJECTIVE_IDS,
  BlamePattern,
  BlamelessChecklistItem,
  CHECKLIST_FIELD_ID,
  DETECTION_SOURCES,
  DetectionSource,
  POSTMORTEM_DOC_PATH,
  POSTMORTEM_ISSUE_FORM_PATH,
  POSTMORTEM_LABEL,
  POSTMORTEM_METADATA_FIELDS,
  POSTMORTEM_SECTIONS,
  POSTMORTEM_SEVERITIES,
  POSTMORTEM_TITLE_PREFIX,
  PostmortemMetadataField,
  PostmortemSection,
  PostmortemSeverity,
  REQUIRED_ACTION_ITEM_CLASS,
  assertValidPostmortemProcess,
  blameLanguageIn,
  referencedRunbookIds,
  sectionAnchor,
  severitiesRequiringPostmortem,
  severityById,
  validatePostmortemProcess,
} from '../lib/postmortems';

/**
 * Rules over the process declaration itself.
 *
 * Every rule is asserted twice: once that the shipped process satisfies it, and
 * once that a process breaking it is reported. A validator whose rule stopped
 * firing is indistinguishable from a process with nothing wrong in it, and that
 * is the failure worth guarding — the whole thing is one function returning an
 * empty array.
 */

const VALID_SEVERITY: PostmortemSeverity = {
  id: 'sev1',
  label: 'Sev1',
  triggers: ['A paging alarm fired and a human changed something to clear it.'],
  runbookIds: ['api-5xx'],
  requiresPostmortem: true,
  requiresRecord: true,
  dueWithinBusinessDays: 5,
};

const VALID_SECTION: PostmortemSection = {
  id: 'summary',
  heading: 'Summary',
  formFieldId: 'summary',
  required: true,
  prompt: 'What broke, for whom, for how long, and what has changed since. Three sentences.',
};

const VALID_CHECKLIST_ITEM: BlamelessChecklistItem = {
  id: 'luck-recorded',
  question: 'Is there something concrete in "Where we got lucky"?',
  why:
    'A blank answer means nobody looked. Luck is a safeguard that happened to hold, and the ' +
    'next incident is where it does not.',
};

const VALID_SOURCES: readonly DetectionSource[] = [
  { id: 'alarm', label: 'A CloudWatch alarm', isHuman: false },
  { id: 'customer', label: 'A customer told us', isHuman: true },
];

const VALID_METADATA: PostmortemMetadataField = {
  id: 'incident-id',
  kind: 'input',
  label: 'Incident id',
  required: true,
};

const rulesFor = (overrides: {
  severities?: readonly PostmortemSeverity[];
  sections?: readonly PostmortemSection[];
  checklist?: readonly BlamelessChecklistItem[];
  sources?: readonly DetectionSource[];
  metadata?: readonly PostmortemMetadataField[];
  blame?: readonly BlamePattern[];
}): string[] =>
  validatePostmortemProcess(
    overrides.severities ?? [VALID_SEVERITY],
    overrides.sections ?? [VALID_SECTION],
    overrides.checklist ?? [VALID_CHECKLIST_ITEM],
    overrides.sources ?? VALID_SOURCES,
    overrides.metadata ?? [VALID_METADATA],
    overrides.blame ?? BLAME_LANGUAGE,
  ).map((finding) => finding.rule);

describe('the shipped process', () => {
  it('passes every rule', () => {
    expect(validatePostmortemProcess()).toEqual([]);
  });

  it('is what assertValidPostmortemProcess accepts', () => {
    expect(() => assertValidPostmortemProcess()).not.toThrow();
  });

  it('throws with every finding, not just the first', () => {
    const broken: PostmortemSeverity = {
      ...VALID_SEVERITY,
      triggers: [],
      runbookIds: [],
    };
    expect(() => assertValidPostmortemProcess([broken], [VALID_SECTION], [VALID_CHECKLIST_ITEM], VALID_SOURCES, [VALID_METADATA])).toThrow(
      /severity-without-triggers[\s\S]*severity-without-runbooks/,
    );
  });

  it('names the doc in the failure, because that is where the reasons are', () => {
    expect(() =>
      assertValidPostmortemProcess([{ ...VALID_SEVERITY, triggers: [] }]),
    ).toThrow(POSTMORTEM_DOC_PATH);
  });

  it('declares one section per form field and no collisions', () => {
    const fieldIds = POSTMORTEM_SECTIONS.map((section) => section.formFieldId);
    expect(new Set(fieldIds).size).toBe(fieldIds.length);
    expect(fieldIds).not.toContain(CHECKLIST_FIELD_ID);
  });

  it('has exactly one optional section, so the required/optional rule has both directions', () => {
    expect(POSTMORTEM_SECTIONS.filter((section) => !section.required)).toHaveLength(1);
  });

  it('keys every budget trigger to an objective that is measured', () => {
    // The gate proves this against SLO_CATALOGUE; here it is only that the list
    // is non-empty, since a trigger table with no budget trigger is a different
    // process from the one docs/postmortem.md describes.
    expect(BUDGET_TRIGGER_OBJECTIVE_IDS.length).toBeGreaterThan(0);
  });

  it('asks the review for a detection action item', () => {
    expect(ACTION_ITEM_CLASSES).toContain(REQUIRED_ACTION_ITEM_CLASS);
    expect(REQUIRED_ACTION_ITEM_CLASS).toBe('detect');
  });

  it('labels and titles the issue, so the postmortems are one query', () => {
    expect(POSTMORTEM_LABEL).toBe('postmortem');
    expect(POSTMORTEM_TITLE_PREFIX.endsWith(' ')).toBe(true);
    expect(POSTMORTEM_ISSUE_FORM_PATH).toMatch(/^\.github\/ISSUE_TEMPLATE\//);
  });
});

describe('severities', () => {
  it('reports a process with no severities at all', () => {
    expect(rulesFor({ severities: [] })).toContain('no-severities');
  });

  it('reports the worst class of incident owing no write-up', () => {
    expect(
      rulesFor({
        severities: [
          { ...VALID_SEVERITY, requiresPostmortem: false, dueWithinBusinessDays: undefined },
        ],
      }),
    ).toContain('top-severity-without-postmortem');
  });

  it('reports a severity whose choice is a judgement call', () => {
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, triggers: [] }] })).toContain(
      'severity-without-triggers',
    );
  });

  it('reports a trigger too short to be a fact about an incident', () => {
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, triggers: ['it was bad'] }] })).toContain(
      'severity-trigger-not-checkable',
    );
  });

  it('reports a severity keyed to no runbook', () => {
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, runbookIds: [] }] })).toContain(
      'severity-without-runbooks',
    );
  });

  it('reports the same runbook listed twice', () => {
    expect(
      rulesFor({ severities: [{ ...VALID_SEVERITY, runbookIds: ['api-5xx', 'api-5xx'] }] }),
    ).toContain('severity-runbook-duplicated');
  });

  it('reports a severity that records nothing, because the pattern is the point', () => {
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, requiresRecord: false }] })).toContain(
      'severity-records-nothing',
    );
  });

  it('reports a write-up with no deadline', () => {
    expect(
      rulesFor({ severities: [{ ...VALID_SEVERITY, dueWithinBusinessDays: undefined }] }),
    ).toContain('due-date-missing');
  });

  it('reports a deadline that is not in the future', () => {
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, dueWithinBusinessDays: 0 }] })).toContain(
      'due-date-not-positive',
    );
  });

  it('reports a deadline on a severity that owes no write-up', () => {
    expect(
      rulesFor({
        severities: [
          VALID_SEVERITY,
          {
            ...VALID_SEVERITY,
            id: 'sev3',
            label: 'Sev3',
            requiresPostmortem: false,
            dueWithinBusinessDays: 20,
          },
        ],
      }),
    ).toContain('due-date-without-postmortem');
  });

  it('reports a more severe incident allowed more time than a less severe one', () => {
    expect(
      rulesFor({
        severities: [
          { ...VALID_SEVERITY, dueWithinBusinessDays: 10 },
          { ...VALID_SEVERITY, id: 'sev2', label: 'Sev2', dueWithinBusinessDays: 5 },
        ],
      }),
    ).toContain('due-dates-not-ordered');
  });

  it('accepts the shipped ordering', () => {
    const due = severitiesRequiringPostmortem().map(
      (severity) => severity.dueWithinBusinessDays ?? 0,
    );
    expect(due).toEqual([...due].sort((a, b) => a - b));
  });

  it('reports a duplicate id and a non-kebab-case one', () => {
    expect(rulesFor({ severities: [VALID_SEVERITY, VALID_SEVERITY] })).toContain(
      'duplicate-severity-id',
    );
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, id: 'Sev_1' }] })).toContain(
      'severity-id-not-kebab-case',
    );
  });

  it('reports a severity with no label for the dropdown to show', () => {
    expect(rulesFor({ severities: [{ ...VALID_SEVERITY, label: '  ' }] })).toContain(
      'severity-label-missing',
    );
  });

  it('is looked up by id, and reports nothing for one that does not exist', () => {
    expect(severityById('sev1')?.label).toBe('Sev1');
    expect(severityById('sev9')).toBeUndefined();
  });

  it('collects the runbook ids the gate has to resolve', () => {
    const ids = referencedRunbookIds();
    expect(ids).toContain('api-5xx');
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('sections', () => {
  it('reports a template with no sections', () => {
    expect(rulesFor({ sections: [] })).toContain('no-sections');
  });

  it('reports a template where nothing is required', () => {
    expect(rulesFor({ sections: [{ ...VALID_SECTION, required: false }] })).toContain(
      'no-required-sections',
    );
  });

  it('reports two sections claiming one form field', () => {
    expect(
      rulesFor({ sections: [VALID_SECTION, { ...VALID_SECTION, id: 'impact' }] }),
    ).toContain('duplicate-form-field-id');
  });

  it('reports a section claiming the checklist field', () => {
    expect(
      rulesFor({
        sections: [{ ...VALID_SECTION, id: 'other', formFieldId: CHECKLIST_FIELD_ID }],
      }),
    ).toContain('section-collides-with-checklist');
  });

  it('reports a heading that starts with its own number', () => {
    expect(rulesFor({ sections: [{ ...VALID_SECTION, heading: '4. Summary' }] })).toContain(
      'section-heading-numbered',
    );
  });

  it('reports an empty heading and a prompt that is not a question', () => {
    expect(rulesFor({ sections: [{ ...VALID_SECTION, heading: ' ' }] })).toContain(
      'section-heading-empty',
    );
    expect(rulesFor({ sections: [{ ...VALID_SECTION, prompt: 'Write it up.' }] })).toContain(
      'section-prompt-too-short',
    );
  });

  it('reports a blame-shaped prompt, which is the edit most likely to arrive', () => {
    expect(
      rulesFor({
        sections: [
          {
            ...VALID_SECTION,
            prompt: 'What was the root cause of this incident, and how was it introduced?',
          },
        ],
      }),
    ).toContain('section-prompt-blame-shaped');
  });

  it('reports a duplicate id and a non-kebab-case field id', () => {
    expect(rulesFor({ sections: [VALID_SECTION, { ...VALID_SECTION, formFieldId: 'other' }] })).toContain(
      'duplicate-section-id',
    );
    expect(
      rulesFor({ sections: [{ ...VALID_SECTION, formFieldId: 'What_Happened' }] }),
    ).toContain('form-field-id-not-kebab-case');
  });

  it('computes the anchor GitHub generates for the heading', () => {
    expect(sectionAnchor(VALID_SECTION)).toBe('#summary');
    expect(sectionAnchor({ ...VALID_SECTION, heading: 'Where we got lucky' })).toBe(
      '#where-we-got-lucky',
    );
  });
});

describe('the structured fields', () => {
  it('reports a field that collides with a section or the checklist', () => {
    expect(rulesFor({ metadata: [{ ...VALID_METADATA, id: 'summary' }] })).toContain(
      'metadata-field-collides',
    );
    expect(rulesFor({ metadata: [{ ...VALID_METADATA, id: CHECKLIST_FIELD_ID }] })).toContain(
      'metadata-field-collides',
    );
  });

  it('reports a dropdown with no list behind it', () => {
    expect(
      rulesFor({ metadata: [{ ...VALID_METADATA, kind: 'dropdown', optionsFrom: undefined }] }),
    ).toContain('dropdown-without-option-source');
  });

  it('reports a free-text field pretending to have options', () => {
    expect(
      rulesFor({ metadata: [{ ...VALID_METADATA, kind: 'input', optionsFrom: 'severities' }] }),
    ).toContain('option-source-on-free-text');
  });

  it('reports two dropdowns over one list', () => {
    expect(
      rulesFor({
        metadata: [
          { id: 'severity', kind: 'dropdown', label: 'Severity', required: true, optionsFrom: 'severities' },
          { id: 'severity-again', kind: 'dropdown', label: 'Severity', required: true, optionsFrom: 'severities' },
        ],
      }),
    ).toContain('duplicate-option-source');
  });

  it('reports a duplicate id, a bad id and a missing label', () => {
    expect(rulesFor({ metadata: [VALID_METADATA, VALID_METADATA] })).toContain(
      'duplicate-metadata-id',
    );
    expect(rulesFor({ metadata: [{ ...VALID_METADATA, id: 'Incident_Id' }] })).toContain(
      'metadata-id-not-kebab-case',
    );
    expect(rulesFor({ metadata: [{ ...VALID_METADATA, label: '' }] })).toContain(
      'metadata-label-missing',
    );
  });

  it('separates when impact started from how long detection took', () => {
    const ids = POSTMORTEM_METADATA_FIELDS.map((field) => field.id);
    expect(ids).toContain('started-at');
    expect(ids).toContain('time-to-detect');
  });
});

describe('the review checklist', () => {
  it('reports a review with no checklist', () => {
    expect(rulesFor({ checklist: [] })).toContain('no-checklist');
  });

  it('reports a statement where a question belongs', () => {
    expect(
      rulesFor({ checklist: [{ ...VALID_CHECKLIST_ITEM, question: 'The document is blameless.' }] }),
    ).toContain('checklist-item-not-a-question');
  });

  it('reports an item with no reason beside it', () => {
    expect(rulesFor({ checklist: [{ ...VALID_CHECKLIST_ITEM, why: 'It matters.' }] })).toContain(
      'checklist-item-without-reason',
    );
  });

  it('reports two items asking the same question', () => {
    expect(
      rulesFor({
        checklist: [VALID_CHECKLIST_ITEM, { ...VALID_CHECKLIST_ITEM, id: 'luck-again' }],
      }),
    ).toContain('duplicate-checklist-question');
  });

  it('reports a duplicate id and a non-kebab-case one', () => {
    expect(
      rulesFor({
        checklist: [VALID_CHECKLIST_ITEM, { ...VALID_CHECKLIST_ITEM, question: 'Anything else?' }],
      }),
    ).toContain('duplicate-checklist-id');
    expect(rulesFor({ checklist: [{ ...VALID_CHECKLIST_ITEM, id: 'Luck' }] })).toContain(
      'checklist-id-not-kebab-case',
    );
  });

  it('asks every question so that a tick is the good answer', () => {
    // Not a validator rule — it cannot be decided from the text — but it is the
    // property that makes a checkbox list answerable at all, and the form's
    // description promises it.
    for (const item of BLAMELESS_REVIEW_CHECKLIST) {
      expect(item.question).toMatch(/^(Is|Are|Does|Did|If)\b/);
    }
  });

  it('is allowed to quote the language the process rejects', () => {
    // Two items name a counterfactual and "should have noticed" on purpose: a
    // checklist that cannot quote what it is looking for cannot be applied. The
    // gate exempts this one field, and `audit-postmortems.test.ts` proves the
    // exemption is scoped to it.
    const quoting = BLAMELESS_REVIEW_CHECKLIST.filter(
      (item) => blameLanguageIn(item.question) !== undefined,
    );
    expect(quoting.map((item) => item.id)).toEqual(['no-counterfactuals']);
  });
});

describe('detection sources', () => {
  it('reports a list on which "a customer told us" is unselectable', () => {
    expect(rulesFor({ sources: [{ id: 'alarm', label: 'An alarm', isHuman: false }] })).toContain(
      'detection-without-human-source',
    );
  });

  it('reports a list with no signal on it, which leaves time-to-detect meaningless', () => {
    expect(
      rulesFor({ sources: [{ id: 'customer', label: 'A customer told us', isHuman: true }] }),
    ).toContain('detection-without-automated-source');
  });

  it('reports a duplicate id, a bad id and a missing label', () => {
    expect(rulesFor({ sources: [...VALID_SOURCES, VALID_SOURCES[0]] })).toContain(
      'duplicate-detection-id',
    );
    expect(
      rulesFor({ sources: [...VALID_SOURCES, { id: 'Word_Of_Mouth', label: 'x', isHuman: true }] }),
    ).toContain('detection-id-not-kebab-case');
    expect(
      rulesFor({ sources: [...VALID_SOURCES, { id: 'other', label: '', isHuman: true }] }),
    ).toContain('detection-label-missing');
  });

  it('ships both kinds of answer', () => {
    expect(DETECTION_SOURCES.some((source) => source.isHuman)).toBe(true);
    expect(DETECTION_SOURCES.some((source) => !source.isHuman)).toBe(true);
  });
});

describe('the blame patterns', () => {
  it('matches the phrases the process exists to keep out', () => {
    expect(blameLanguageIn('What was the root cause?')?.reason).toMatch(/contributing factors/);
    expect(blameLanguageIn('This was human error.')).toBeDefined();
    expect(blameLanguageIn('Who caused the outage?')).toBeDefined();
    expect(blameLanguageIn('They should have noticed the alarm.')).toBeDefined();
    expect(blameLanguageIn('The operator failed to follow the runbook.')).toBeDefined();
    expect(blameLanguageIn('This was negligent.')).toBeDefined();
  });

  it('leaves the prompts the process does ask alone', () => {
    expect(blameLanguageIn('What made the wrong thing look correct at the time?')).toBeUndefined();
    expect(blameLanguageIn('Which signal fired first, and how long after the impact?')).toBeUndefined();
  });

  it('reports a pattern carrying the g flag, which is stateful between calls', () => {
    expect(
      rulesFor({
        blame: [
          { pattern: /\bblame\b/gi, reason: VALID_CHECKLIST_ITEM.why },
        ],
      }),
    ).toContain('blame-pattern-is-global');
  });

  it('proves the g flag would actually misfire', () => {
    // Not hypothetical: `test` advances `lastIndex` on a global RegExp, so the
    // second identical call returns false. This is why the rule above exists.
    const global = /\bblame\b/g;
    expect(global.test('blame')).toBe(true);
    expect(global.test('blame')).toBe(false);
  });

  it('reports a pattern that matches everything', () => {
    expect(
      rulesFor({ blame: [{ pattern: /x?/i, reason: VALID_CHECKLIST_ITEM.why }] }),
    ).toContain('blame-pattern-matches-everything');
  });

  it('reports a pattern with no usable reason against it', () => {
    expect(rulesFor({ blame: [{ pattern: /\bblame\b/i, reason: 'bad' }] })).toContain(
      'blame-pattern-without-reason',
    );
  });

  it('carries a reason on every shipped pattern, since that is what gets read', () => {
    for (const entry of BLAME_LANGUAGE) {
      expect(entry.reason.length).toBeGreaterThanOrEqual(40);
      expect(entry.pattern.flags).not.toContain('g');
    }
  });
});
