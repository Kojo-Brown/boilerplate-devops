import * as fs from 'fs';
import * as path from 'path';
import {
  ANSWERING_ELEMENT_TYPES,
  AuditInput,
  CHECKLIST_ELEMENT_TYPE,
  MEASURED_SLO_STATUS,
  auditPostmortems,
  formatViolations,
  inPageAnchorsIn,
  linksTo,
  parseIssueForm,
  postmortemAnchorsReferencedIn,
} from '../tools/audit-postmortems';
import {
  BLAMELESS_REVIEW_CHECKLIST,
  BlamelessChecklistItem,
  CHECKLIST_FIELD_ID,
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
} from '../lib/postmortems';
import { RUNBOOK_CATALOGUE, RUNBOOK_DOC_PATH } from '../lib/runbooks';
import { SLO_CATALOGUE } from '../lib/slo-definitions';

/**
 * Rules over the three files that have to agree.
 *
 * Each rule is asserted twice: once that a consistent set of files produces no
 * violation, and once that breaking exactly one thing is reported. The fixture
 * is deliberately tiny — two sections, one structured field, one checklist item
 * — because the shipped files are checked wholesale by the last block, and a
 * fixture large enough to be realistic is one nobody edits.
 */

const REPO_ROOT = path.join(__dirname, '..', '..', '..');

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const SEVERITIES: readonly PostmortemSeverity[] = [
  {
    id: 'sev1',
    label: 'Sev1',
    triggers: ['A paging alarm fired and a human changed something to clear it.'],
    runbookIds: ['api-5xx'],
    requiresPostmortem: true,
    requiresRecord: true,
    dueWithinBusinessDays: 5,
  },
];

const SECTIONS: readonly PostmortemSection[] = [
  {
    id: 'summary',
    heading: 'Summary',
    formFieldId: 'summary',
    required: true,
    prompt: 'What broke, for whom, for how long, and what has changed since. Three sentences.',
  },
  {
    id: 'related-incidents',
    heading: 'Related incidents',
    formFieldId: 'related-incidents',
    required: false,
    prompt:
      'Earlier postmortems sharing a contributing factor with this one, by issue number. ' +
      'Optional: the first of its kind has none.',
  },
];

const CHECKLIST: readonly BlamelessChecklistItem[] = [
  {
    id: 'luck-recorded',
    question: 'Is there something concrete in "Where we got lucky"?',
    why:
      'A blank answer means nobody looked. Luck is a safeguard that happened to hold, and the ' +
      'next incident is where it does not.',
  },
];

const SOURCES: readonly DetectionSource[] = [
  { id: 'alarm', label: 'A CloudWatch alarm', isHuman: false },
  { id: 'customer', label: 'A customer told us', isHuman: true },
];

const METADATA: readonly PostmortemMetadataField[] = [
  {
    id: 'severity',
    kind: 'dropdown',
    label: 'Severity',
    required: true,
    optionsFrom: 'severities',
  },
];

interface FormOverrides {
  readonly title?: string | null;
  readonly labels?: readonly string[];
  /** Replaces the whole `body:` block. */
  readonly body?: string;
}

const DEFAULT_BODY = `  - type: markdown
    attributes:
      value: |
        This form never asks who.

  - type: dropdown
    id: severity
    attributes:
      label: Severity
      description: From the trigger table.
      options:
        - Sev1
    validations:
      required: true

  - type: textarea
    id: summary
    attributes:
      label: Summary
      description: What broke, for whom, for how long, and what has changed since.
    validations:
      required: true

  - type: textarea
    id: related-incidents
    attributes:
      label: Related incidents
      description: Earlier postmortems sharing a contributing factor, by issue number.
    validations:
      required: false

  - type: checkboxes
    id: ${CHECKLIST_FIELD_ID}
    attributes:
      label: Blameless review checklist
      options:
        - label: Is there something concrete in "Where we got lucky"?
`;

const buildForm = (overrides: FormOverrides = {}): string => {
  const title = overrides.title === undefined ? POSTMORTEM_TITLE_PREFIX : overrides.title;
  const labels = overrides.labels ?? [POSTMORTEM_LABEL];
  return [
    'name: Incident postmortem',
    'description: Record an incident and the review of it.',
    ...(title === null ? [] : [`title: "${title}"`]),
    'labels:',
    ...labels.map((label) => `  - ${label}`),
    'body:',
    overrides.body ?? DEFAULT_BODY,
  ].join('\n');
};

const DEFAULT_DOC = `# Postmortems

See [docs/runbooks.md](./runbooks.md) for the other half, and
[§1](#1-which-incidents-owe-one) for the trigger table.

## 1. Which incidents owe one

Sev1 owes a write-up within five business days.

## 2. The template, section by section

### Summary

What broke, for whom, for how long, and what has changed since.

### Related incidents

Earlier postmortems sharing a contributing factor with this one.

## 3. The blameless review checklist

1. **Is there something concrete in "Where we got lucky"?**
   A blank answer means nobody looked.
`;

const DEFAULT_RUNBOOK_DOC = `# Runbooks

## 10. When the incident ends

Which incidents owe a write-up is a fact about the incident —
[docs/postmortem.md#1-which-incidents-owe-one](./postmortem.md#1-which-incidents-owe-one).
`;

const auditWith = (overrides: Partial<AuditInput> = {}) =>
  auditPostmortems({
    doc: DEFAULT_DOC,
    issueForm: buildForm(),
    runbookDoc: DEFAULT_RUNBOOK_DOC,
    sections: SECTIONS,
    severities: SEVERITIES,
    checklist: CHECKLIST,
    detectionSources: SOURCES,
    metadataFields: METADATA,
    runbookIds: ['api-5xx'],
    sloStatuses: new Map([['production-api-availability', MEASURED_SLO_STATUS]]),
    budgetObjectiveIds: ['production-api-availability'],
    ...overrides,
  });

const rulesFor = (overrides: Partial<AuditInput> = {}): string[] =>
  auditWith(overrides).violations.map((violation) => violation.rule);

/* ── The fixture itself ───────────────────────────────────────────────────── */

describe('a consistent set of files', () => {
  it('produces no violations', () => {
    expect(auditWith().violations).toEqual([]);
  });

  it('reports how much it read, so a gate that read nothing is visible', () => {
    const result = auditWith();
    expect(result.fieldsRead).toBe(4);
    expect(result.anchorsChecked).toBeGreaterThan(0);
  });
});

/* ── Sections across the three files ──────────────────────────────────────── */

describe('sections', () => {
  it('reports a section with no heading in the doc', () => {
    expect(rulesFor({ doc: DEFAULT_DOC.replace('### Summary', '### Overview') })).toContain(
      'section-heading-missing',
    );
  });

  it('reports a section the form never asks for', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: DEFAULT_BODY.replace(
            `  - type: textarea
    id: summary
    attributes:
      label: Summary
      description: What broke, for whom, for how long, and what has changed since.
    validations:
      required: true
`,
            '',
          ),
        }),
      }),
    ).toContain('section-field-missing');
  });

  it('reports a required section whose field will submit empty', () => {
    const form = buildForm({
      body: DEFAULT_BODY.replace(
        `      description: What broke, for whom, for how long, and what has changed since.
    validations:
      required: true`,
        `      description: What broke, for whom, for how long, and what has changed since.
    validations:
      required: false`,
      ),
    });
    const violation = auditWith({ issueForm: form }).violations.find(
      (candidate) => candidate.rule === 'field-requirement-mismatch',
    );
    expect(violation?.message).toMatch(/23:00/);
  });

  it('reports an optional section the form refuses to submit without', () => {
    const form = buildForm({
      body: DEFAULT_BODY.replace(
        `      description: Earlier postmortems sharing a contributing factor, by issue number.
    validations:
      required: false`,
        `      description: Earlier postmortems sharing a contributing factor, by issue number.
    validations:
      required: true`,
      ),
    });
    const violation = auditWith({ issueForm: form }).violations.find(
      (candidate) => candidate.rule === 'field-requirement-mismatch',
    );
    expect(violation?.message).toMatch(/n\/a/);
  });

  it('reports a narrative section collected as a single-line input', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: DEFAULT_BODY.replace(
            `  - type: textarea
    id: summary`,
            `  - type: input
    id: summary`,
          ),
        }),
      }),
    ).toContain('field-kind-mismatch');
  });
});

/* ── Structured fields ────────────────────────────────────────────────────── */

describe('structured fields', () => {
  it('reports a declared field the form does not have', () => {
    expect(
      rulesFor({
        metadataFields: [
          ...METADATA,
          { id: 'time-to-detect', kind: 'input', label: 'Minutes', required: true },
        ],
      }),
    ).toContain('section-field-missing');
  });

  it('reports a dropdown rendered as free text', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: DEFAULT_BODY.replace(
            `  - type: dropdown
    id: severity`,
            `  - type: input
    id: severity`,
          ),
        }),
      }),
    ).toContain('field-kind-mismatch');
  });

  it('reports a dropdown that has drifted from the list behind it', () => {
    const violation = auditWith({
      issueForm: buildForm({ body: DEFAULT_BODY.replace('        - Sev1', '        - Sev0') }),
    }).violations.find((candidate) => candidate.rule === 'dropdown-options-mismatch');
    expect(violation?.message).toContain("'Sev0'");
    expect(violation?.message).toContain("'Sev1'");
  });

  it('reports options in the wrong order, since the dropdown is read top-down', () => {
    const twoSeverities: readonly PostmortemSeverity[] = [
      SEVERITIES[0],
      { ...SEVERITIES[0], id: 'sev2', label: 'Sev2', dueWithinBusinessDays: 10 },
    ];
    expect(
      rulesFor({
        severities: twoSeverities,
        issueForm: buildForm({
          body: DEFAULT_BODY.replace('        - Sev1', '        - Sev2\n        - Sev1'),
        }),
      }),
    ).toContain('dropdown-options-mismatch');
  });

  it('reports a form field nothing declares', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: `${DEFAULT_BODY}
  - type: input
    id: on-call-engineer
    attributes:
      label: On call
    validations:
      required: true
`,
        }),
      }),
    ).toContain('form-field-undeclared');
  });

  it('reports an answering field with no id, whose key is then its label', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: `${DEFAULT_BODY}
  - type: input
    attributes:
      label: Something else
`,
        }),
      }),
    ).toContain('form-field-undeclared');
  });

  it('ignores markdown elements, which carry no answer', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: `${DEFAULT_BODY}
  - type: markdown
    attributes:
      value: A closing note with no id.
`,
        }),
      }),
    ).toEqual([]);
  });
});

/* ── The checklist ────────────────────────────────────────────────────────── */

describe('the review checklist', () => {
  it('reports a form with no checklist at all', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: DEFAULT_BODY.slice(0, DEFAULT_BODY.indexOf('  - type: checkboxes')),
        }),
      }),
    ).toContain('checklist-options-mismatch');
  });

  it('reports a checklist that has been paraphrased in the form', () => {
    const violation = auditWith({
      issueForm: buildForm({
        body: DEFAULT_BODY.replace(
          'Is there something concrete in "Where we got lucky"?',
          'Did we get lucky?',
        ),
      }),
    }).violations.find((candidate) => candidate.rule === 'checklist-options-mismatch');
    expect(violation?.message).toContain('Did we get lucky?');
  });

  it('reports a checklist item the doc does not explain', () => {
    expect(
      rulesFor({
        doc: DEFAULT_DOC.replace('Is there something concrete in "Where we got lucky"?', 'Luck?'),
      }),
    ).toContain('checklist-question-not-in-doc');
  });

  it('accepts a question the doc wraps across lines, since markdown reflows', () => {
    const wrapped = DEFAULT_DOC.replace(
      '1. **Is there something concrete in "Where we got lucky"?**',
      '1. **Is there something concrete in\n   "Where we got lucky"?**',
    );
    expect(rulesFor({ doc: wrapped })).toEqual([]);
  });

  it('reports a checklist collected as anything but checkboxes', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: DEFAULT_BODY.replace(
            `  - type: checkboxes
    id: ${CHECKLIST_FIELD_ID}`,
            `  - type: textarea
    id: ${CHECKLIST_FIELD_ID}`,
          ),
        }),
      }),
    ).toContain('field-kind-mismatch');
  });
});

/* ── Blame language ───────────────────────────────────────────────────────── */

describe('blame language in the form', () => {
  it('reports "what was the root cause", which is the edit most likely to arrive', () => {
    const violation = auditWith({
      issueForm: buildForm({
        body: DEFAULT_BODY.replace(
          '      description: What broke, for whom, for how long, and what has changed since.',
          '      description: What was the root cause of this incident?',
        ),
      }),
    }).violations.find((candidate) => candidate.rule === 'blame-language-in-form');
    expect(violation?.location).toBe('summary');
    expect(violation?.message).toMatch(/contributing factors/);
  });

  it('reports it in a label, a placeholder and an option, not only in a description', () => {
    for (const line of [
      '      label: Who broke it',
      '      placeholder: Human error in the deploy step',
    ]) {
      expect(
        rulesFor({
          issueForm: buildForm({
            body: DEFAULT_BODY.replace('      label: Summary', line),
          }),
        }),
      ).toContain('blame-language-in-form');
    }
  });

  it('exempts the checklist, which has to be able to quote what it looks for', () => {
    const counterfactual = 'Is the document free of counterfactuals — "they should have noticed"?';
    const checklist: readonly BlamelessChecklistItem[] = [
      { ...CHECKLIST[0], id: 'no-counterfactuals', question: counterfactual },
    ];
    expect(
      rulesFor({
        checklist,
        doc: DEFAULT_DOC.replace(
          'Is there something concrete in "Where we got lucky"?',
          counterfactual,
        ),
        issueForm: buildForm({
          body: DEFAULT_BODY.replace(
            '        - label: Is there something concrete in "Where we got lucky"?',
            `        - label: ${counterfactual}`,
          ),
        }),
      }),
    ).toEqual([]);
  });

  it('scopes that exemption to the one field id, not to every checkboxes element', () => {
    expect(
      rulesFor({
        issueForm: buildForm({
          body: `${DEFAULT_BODY}
  - type: checkboxes
    id: sign-off
    attributes:
      label: Sign-off
      options:
        - label: We agreed the root cause
`,
        }),
      }),
    ).toContain('blame-language-in-form');
  });
});

/* ── The form's own wiring ────────────────────────────────────────────────── */

describe('the issue form wiring', () => {
  it('reports a form that does not apply the label the query depends on', () => {
    expect(rulesFor({ issueForm: buildForm({ labels: ['incident'] }) })).toContain(
      'issue-form-label-missing',
    );
  });

  it('accepts labels written as a comma-separated string, which GitHub also allows', () => {
    const form = buildForm().replace(
      `labels:\n  - ${POSTMORTEM_LABEL}`,
      `labels: "${POSTMORTEM_LABEL}, incident"`,
    );
    expect(rulesFor({ issueForm: form })).toEqual([]);
  });

  it('reports a form that does not prefix the issue title', () => {
    expect(rulesFor({ issueForm: buildForm({ title: null }) })).toContain(
      'issue-form-title-missing',
    );
    expect(rulesFor({ issueForm: buildForm({ title: 'Incident: ' }) })).toContain(
      'issue-form-title-missing',
    );
  });
});

/* ── Triggers keyed to things that have to still exist ────────────────────── */

describe('triggers', () => {
  it('reports a severity keyed to a runbook that has been renamed', () => {
    expect(rulesFor({ runbookIds: ['api-five-hundreds'] })).toContain(
      'runbook-reference-unknown',
    );
  });

  it('reports a runbook no severity names, which is every runbook added later', () => {
    const violation = auditWith({ runbookIds: ['api-5xx', 'new-thing'] }).violations.find(
      (candidate) => candidate.rule === 'runbook-without-severity',
    );
    expect(violation?.location).toBe('new-thing');
    expect(violation?.message).toMatch(/whether a write-up is owed/);
  });

  it('reports a budget trigger on an objective that is not in the catalogue', () => {
    expect(rulesFor({ sloStatuses: new Map() })).toContain('budget-objective-not-active');
  });

  it('reports a budget trigger on a proposed objective, which can never fire', () => {
    const violation = auditWith({
      sloStatuses: new Map([['production-api-availability', 'proposed']]),
    }).violations.find((candidate) => candidate.rule === 'budget-objective-not-active');
    expect(violation?.message).toMatch(/never fire/);
  });
});

/* ── Links ────────────────────────────────────────────────────────────────── */

describe('links between the documents', () => {
  it('reports an in-page anchor whose heading was renumbered', () => {
    const violation = auditWith({
      doc: DEFAULT_DOC.replace('## 1. Which incidents owe one', '## 2. Which incidents owe one'),
    }).violations.find((candidate) => candidate.rule === 'doc-anchor-missing');
    expect(violation?.location).toBe('#1-which-incidents-owe-one');
  });

  it('reports an anchor the runbook document links to and the doc no longer offers', () => {
    expect(
      rulesFor({
        runbookDoc: DEFAULT_RUNBOOK_DOC.replace(
          'docs/postmortem.md#1-which-incidents-owe-one',
          'docs/postmortem.md#2-triggers',
        ),
      }),
    ).toContain('doc-anchor-missing');
  });

  it('reports a responder document that cannot reach the process', () => {
    const violation = auditWith({ runbookDoc: '# Runbooks\n\nNothing about afterwards.\n' })
      .violations.find((candidate) => candidate.rule === 'cross-link-missing');
    expect(violation?.file).toBe(RUNBOOK_DOC_PATH);
  });

  it('reports a process that cannot reach back', () => {
    const violation = auditWith({
      doc: DEFAULT_DOC.replace('[docs/runbooks.md](./runbooks.md)', 'the runbooks'),
    }).violations.find((candidate) => candidate.rule === 'cross-link-missing');
    expect(violation?.file).toBe(POSTMORTEM_DOC_PATH);
  });

  it('reads anchors out of the three syntaxes they are written in', () => {
    expect(
      postmortemAnchorsReferencedIn('see docs/postmortem.md#7-the-checklist too', POSTMORTEM_DOC_PATH),
    ).toEqual(['#7-the-checklist']);
    expect(postmortemAnchorsReferencedIn('no links here', POSTMORTEM_DOC_PATH)).toEqual([]);
    expect(inPageAnchorsIn('[§2](#2-which-incidents-owe-one) and [§3](#3-blameless)')).toEqual([
      '#2-which-incidents-owe-one',
      '#3-blameless',
    ]);
  });

  it('recognises a link by path, by relative path and by bare filename', () => {
    expect(linksTo('see docs/runbooks.md', RUNBOOK_DOC_PATH)).toBe(true);
    expect(linksTo('[the runbooks](./runbooks.md)', RUNBOOK_DOC_PATH)).toBe(true);
    expect(linksTo('[the runbooks](runbooks.md#2-api)', RUNBOOK_DOC_PATH)).toBe(true);
    expect(linksTo('nothing', RUNBOOK_DOC_PATH)).toBe(false);
  });
});

/* ── Reading the form defensively ─────────────────────────────────────────── */

describe('parsing the issue form', () => {
  it('reads both option shapes, since a dropdown and a checkboxes element differ', () => {
    const form = parseIssueForm(buildForm());
    const severity = form.fields.find((field) => field.id === 'severity');
    const checklist = form.fields.find((field) => field.id === CHECKLIST_FIELD_ID);
    expect(severity?.options).toEqual(['Sev1']);
    expect(checklist?.options).toEqual(['Is there something concrete in "Where we got lucky"?']);
  });

  it('treats a missing validations block as not required, which is what GitHub does', () => {
    const form = parseIssueForm(`name: x
body:
  - type: input
    id: thing
    attributes:
      label: Thing
`);
    expect(form.fields[0].required).toBe(false);
  });

  it('survives a body that is not a list, rather than throwing inside the gate', () => {
    expect(parseIssueForm('name: x\nbody: nonsense\n').fields).toEqual([]);
    expect(parseIssueForm('').fields).toEqual([]);
  });

  it('collects every human-readable string for the blame scan', () => {
    const form = parseIssueForm(`name: x
body:
  - type: textarea
    id: thing
    attributes:
      label: L
      description: D
      placeholder: P
`);
    expect(form.fields[0].texts).toEqual(['L', 'D', 'P']);
  });
});

/* ── The contract constants ───────────────────────────────────────────────── */

describe('the restated constants', () => {
  /*
   * Restated in the gate rather than imported, so a change to them is a failing
   * assertion here rather than a silently weakened rule.
   */
  it('match the library and the shipped process', () => {
    expect(CHECKLIST_ELEMENT_TYPE).toBe('checkboxes');
    expect(ANSWERING_ELEMENT_TYPES).toEqual(['input', 'textarea', 'dropdown', 'checkboxes']);
    expect(MEASURED_SLO_STATUS).toBe('active');
    expect(SLO_CATALOGUE.some((slo) => slo.status === MEASURED_SLO_STATUS)).toBe(true);
  });

  it('formats a violation with its rule, file, location and reason', () => {
    const rendered = formatViolations([
      { rule: 'cross-link-missing', file: 'docs/x.md', location: 'y', message: 'because.' },
    ]);
    expect(rendered).toContain('[cross-link-missing]');
    expect(rendered).toContain('docs/x.md y');
    expect(rendered).toContain('because.');
  });
});

/* ── The files this repository actually ships ─────────────────────────────── */

describe('the shipped process, form and documents', () => {
  const read = (relative: string) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

  it('agree with each other', () => {
    const result = auditPostmortems({
      doc: read(POSTMORTEM_DOC_PATH),
      issueForm: read(POSTMORTEM_ISSUE_FORM_PATH),
      runbookDoc: read(RUNBOOK_DOC_PATH),
    });
    expect(formatViolations(result.violations)).toBe('');
  });

  it('collect every declared field, and nothing else', () => {
    const form = parseIssueForm(read(POSTMORTEM_ISSUE_FORM_PATH));
    const answering = form.fields
      .filter((field) => (ANSWERING_ELEMENT_TYPES as readonly string[]).includes(field.type))
      .map((field) => field.id);
    expect(answering.sort()).toEqual(
      [
        ...POSTMORTEM_SECTIONS.map((section) => section.formFieldId),
        ...POSTMORTEM_METADATA_FIELDS.map((field) => field.id),
        CHECKLIST_FIELD_ID,
      ].sort(),
    );
  });

  it('key every severity to a runbook that exists, and every runbook to a severity', () => {
    const catalogueIds = RUNBOOK_CATALOGUE.map((runbook) => runbook.id);
    const classified = new Set(
      POSTMORTEM_SEVERITIES.flatMap((severity) => [...severity.runbookIds]),
    );
    expect([...classified].sort()).toEqual([...catalogueIds].sort());
  });

  it('explain all ten checklist items in the document', () => {
    const doc = read(POSTMORTEM_DOC_PATH).replace(/\s+/g, ' ');
    for (const item of BLAMELESS_REVIEW_CHECKLIST) {
      expect(doc).toContain(item.question.replace(/\s+/g, ' '));
    }
  });
});
