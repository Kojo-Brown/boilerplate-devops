#!/usr/bin/env node
/**
 * Audit the postmortem process: is the thing people fill in still the thing the
 * process describes, and is it still blameless?
 *
 * Reads `docs/postmortem.md`, `.github/ISSUE_TEMPLATE/postmortem.yml` and
 * `docs/runbooks.md`, and holds all three against the single declaration in
 * `lib/postmortems.ts`. Every failure it looks for is one where each file is
 * perfectly reasonable on its own:
 *
 *   A section the form never asks for. Added to the process, described in the
 *   doc, and absent from the only place anyone types. Nobody notices, because a
 *   postmortem missing a section it was never asked for reads complete.
 *
 *   A field the process never described. The reverse, and worse: people fill it
 *   in with a guess, and the guesses differ per author, so the field is
 *   populated and unusable.
 *
 *   A required section whose field is optional. It survives exactly until the
 *   first incident written up at 23:00, which is the incident whose write-up
 *   matters most.
 *
 *   A dropdown that has drifted from the list behind it. An incident filed at a
 *   severity the trigger table has no row for, or a detection source no report
 *   groups by — both of which look like a full form.
 *
 *   Blame language in the form. The prompts decide what kind of document gets
 *   written, and "what was the root cause" produces one cause and stops. This is
 *   also the thing most likely to arrive in a well-meant edit, since every
 *   template on the internet asks for it.
 *
 *   A checklist that has drifted from the paragraphs explaining it. The review
 *   then asks a question whose reason nobody can look up, which is how a
 *   checklist becomes a ritual.
 *
 *   A runbook no severity names. The alarm pages, the runbook answers it, the
 *   incident ends, and nothing says whether a write-up is owed — which is the
 *   default state of every runbook added after this file, since adding one
 *   touches neither the process nor the form.
 *
 *   A trigger keyed to something that no longer exists — a renamed runbook id,
 *   or an objective that is `proposed` and therefore measured by nothing. The
 *   severity stops classifying anything and the file still reads correct.
 *
 *   A postmortem doc nothing links to. The responder is in `docs/runbooks.md` at
 *   04:00 and the process is a document they have never opened. An unlinked
 *   process is the same as no process, and it is invisible in review because
 *   both documents are fine.
 *
 * ## The rules
 *
 *   section-heading-missing        a declared section with no heading in the doc
 *   section-field-missing          a declared section the form never asks for
 *   form-field-undeclared          a form field nothing in lib/postmortems.ts
 *                                  declares
 *   field-requirement-mismatch     required in one place and optional in the
 *                                  other, in either direction
 *   field-kind-mismatch            a declared input rendered as a textarea, or
 *                                  a dropdown as free text
 *   dropdown-options-mismatch      a dropdown whose options are not the list
 *                                  behind it, in order
 *   checklist-options-mismatch     the checkboxes field and the checklist have
 *                                  diverged
 *   checklist-question-not-in-doc  a checklist question the doc does not explain
 *   blame-language-in-form         a label, description or placeholder that asks
 *                                  who, or asks for the root cause
 *   issue-form-label-missing       the form does not apply the label the "have we
 *                                  seen this before" query depends on
 *   issue-form-title-missing       the form does not prefix the issue title
 *   runbook-reference-unknown      a severity keyed to a runbook id that is not
 *                                  in RUNBOOK_CATALOGUE
 *   runbook-without-severity       a runbook no severity names, so an alarm that
 *                                  reached a human through it is unclassified
 *   budget-objective-not-active    a budget trigger keyed to an objective that is
 *                                  missing or `proposed`, so it can never fire
 *   doc-anchor-missing             a link into the postmortem doc that resolves
 *                                  to the top of the page
 *   cross-link-missing             the responder's document does not reach the
 *                                  process, or the process does not reach back
 *
 * Plus every rule in `validatePostmortemProcess` — see lib/postmortems.ts.
 *
 * See docs/postmortem.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import {
  BLAMELESS_REVIEW_CHECKLIST,
  BLAME_LANGUAGE,
  BUDGET_TRIGGER_OBJECTIVE_IDS,
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
  blameLanguageIn,
  sectionAnchor,
  validatePostmortemProcess,
} from '../lib/postmortems';
import { RUNBOOK_CATALOGUE, RUNBOOK_DOC_PATH } from '../lib/runbooks';
import { SLO_CATALOGUE } from '../lib/slo-definitions';
import { anchorsIn } from './audit-runbooks';

/* ── Contract constants, restated ─────────────────────────────────────────── */

/*
 * Restated rather than imported, for the reason `audit-runbooks.ts` gives: a
 * gate that imports the constants it checks cannot catch a change to them. The
 * catalogue itself *is* imported, because it is the input under review.
 * `test/audit-postmortems.test.ts` holds these against the library's exports, so
 * a deliberate rename is one failing assertion rather than a silently weakened
 * rule.
 */

/** GitHub issue-form element types that carry an answer. */
export const ANSWERING_ELEMENT_TYPES = ['input', 'textarea', 'dropdown', 'checkboxes'] as const;

/** The element type the review checklist has to be. */
export const CHECKLIST_ELEMENT_TYPE = 'checkboxes';

/**
 * The status an objective must have for a budget trigger keyed to it to mean
 * anything. See `lib/slo-definitions.ts`.
 */
export const MEASURED_SLO_STATUS = 'active';

/* ── Types ────────────────────────────────────────────────────────────────── */

export type PostmortemAuditRule =
  | 'section-heading-missing'
  | 'section-field-missing'
  | 'form-field-undeclared'
  | 'field-requirement-mismatch'
  | 'field-kind-mismatch'
  | 'dropdown-options-mismatch'
  | 'checklist-options-mismatch'
  | 'checklist-question-not-in-doc'
  | 'blame-language-in-form'
  | 'issue-form-label-missing'
  | 'issue-form-title-missing'
  | 'runbook-reference-unknown'
  | 'runbook-without-severity'
  | 'budget-objective-not-active'
  | 'doc-anchor-missing'
  | 'cross-link-missing'
  | 'process';

export interface Violation {
  readonly rule: PostmortemAuditRule;
  readonly file: string;
  readonly location: string;
  readonly message: string;
}

export interface AuditInput {
  /** Contents of {@link POSTMORTEM_DOC_PATH}. */
  readonly doc: string;
  /** Raw YAML of {@link POSTMORTEM_ISSUE_FORM_PATH}. */
  readonly issueForm: string;
  /** Contents of `docs/runbooks.md`, the document the responder is already in. */
  readonly runbookDoc: string;
  readonly sections?: readonly PostmortemSection[];
  readonly severities?: readonly PostmortemSeverity[];
  readonly checklist?: readonly BlamelessChecklistItem[];
  readonly detectionSources?: readonly DetectionSource[];
  readonly metadataFields?: readonly PostmortemMetadataField[];
  /** Runbook ids that exist. Defaults to `RUNBOOK_CATALOGUE`. */
  readonly runbookIds?: readonly string[];
  /** Objective id → status. Defaults to `SLO_CATALOGUE`. */
  readonly sloStatuses?: ReadonlyMap<string, string>;
  /** Objective ids a budget trigger is keyed to. Defaults to the library's. */
  readonly budgetObjectiveIds?: readonly string[];
}

export interface AuditResult {
  readonly violations: readonly Violation[];
  readonly fieldsRead: number;
  readonly anchorsChecked: number;
}

/* ── Issue-form reading ───────────────────────────────────────────────────── */

/** One element of the form's `body`, narrowed defensively — this is a file on disk. */
export interface FormField {
  readonly type: string;
  readonly id?: string;
  readonly label?: string;
  readonly description?: string;
  readonly placeholder?: string;
  readonly options: readonly string[];
  readonly required: boolean;
  /** Every human-readable string on the element, for the blame-language scan. */
  readonly texts: readonly string[];
}

export interface IssueForm {
  readonly name?: string;
  readonly title?: string;
  readonly labels: readonly string[];
  readonly fields: readonly FormField[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * Options of a dropdown or a checkboxes element, as plain strings.
 *
 * A dropdown's `options` are strings; a checkboxes element's are objects with a
 * `label`. Reading only one of the two shapes is how a checklist rule ends up
 * comparing against an empty list and passing.
 */
const optionsOf = (attributes: Record<string, unknown>): string[] => {
  const raw = attributes.options;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option) => {
    if (typeof option === 'string') return [option];
    const label = asRecord(option).label;
    return typeof label === 'string' ? [label] : [];
  });
};

/**
 * Whatever `js-yaml` produced, or nothing.
 *
 * `load` throws on an empty file and on invalid YAML, and both reach this gate
 * as a stack trace out of a dependency — which reads like the gate is broken
 * rather than like the form is. Returning nothing instead lets the `fieldsRead`
 * check in the CLI say what actually happened: the form no longer parses, so
 * every rule below it is unevaluated.
 */
const loadOrNothing = (yaml: string): unknown => {
  try {
    return load(yaml);
  } catch {
    return undefined;
  }
};

export const parseIssueForm = (yaml: string): IssueForm => {
  const document = asRecord(loadOrNothing(yaml));
  const body = Array.isArray(document.body) ? document.body : [];

  const fields = body.map((element): FormField => {
    const record = asRecord(element);
    const attributes = asRecord(record.attributes);
    const validations = asRecord(record.validations);
    const options = optionsOf(attributes);
    const label = typeof attributes.label === 'string' ? attributes.label : undefined;
    const description =
      typeof attributes.description === 'string' ? attributes.description : undefined;
    const placeholder =
      typeof attributes.placeholder === 'string' ? attributes.placeholder : undefined;
    const value = typeof attributes.value === 'string' ? attributes.value : undefined;

    return {
      type: typeof record.type === 'string' ? record.type : '',
      id: typeof record.id === 'string' ? record.id : undefined,
      label,
      description,
      placeholder,
      options,
      required: validations.required === true,
      texts: [label, description, placeholder, value, ...options].filter(
        (text): text is string => typeof text === 'string',
      ),
    };
  });

  const labels =
    typeof document.labels === 'string'
      ? document.labels.split(',').map((entry) => entry.trim())
      : asStringArray(document.labels);

  return {
    name: typeof document.name === 'string' ? document.name : undefined,
    title: typeof document.title === 'string' ? document.title : undefined,
    labels,
    fields,
  };
};

/* ── Link reading ─────────────────────────────────────────────────────────── */

/**
 * Every `docs/postmortem.md#anchor` reference in a piece of text.
 *
 * Matched against the path rather than against markdown link syntax, because the
 * references worth checking are in three different syntaxes — a markdown link in
 * the README, a bare path in a YAML description, and a relative link inside the
 * doc itself — and the anchor is the part that rots in all three.
 */
export const postmortemAnchorsReferencedIn = (text: string, docPath: string): string[] => {
  const escaped = docPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(#[A-Za-z0-9-]+)`, 'g');
  const anchors = new Set<string>();
  for (const match of text.matchAll(pattern)) anchors.add(match[1].toLowerCase());
  return [...anchors];
};

/**
 * Every in-page anchor a markdown link in the doc points at.
 *
 * The doc's own cross-references are written as `[§2](#2-which-incidents-owe-one)`
 * rather than with the path in front, so they are invisible to the rule above —
 * and they are the numerous ones, because renumbering a section rewrites the
 * heading and leaves every reference to it resolving to the top of the page.
 */
export const inPageAnchorsIn = (markdown: string): string[] => {
  const anchors = new Set<string>();
  for (const match of markdown.matchAll(/\]\((#[A-Za-z0-9-]+)\)/g)) {
    anchors.add(match[1].toLowerCase());
  }
  return [...anchors];
};

/** Does `text` link to `docPath` at all, anchor or not? */
export const linksTo = (text: string, docPath: string): boolean => {
  const basename = path.basename(docPath);
  return text.includes(docPath) || text.includes(`./${basename}`) || text.includes(`(${basename}`);
};

/* ── The audit ────────────────────────────────────────────────────────────── */

const describeList = (values: readonly string[]): string =>
  values.length === 0 ? '(none)' : values.map((value) => `'${value}'`).join(', ');

export const auditPostmortems = (input: AuditInput): AuditResult => {
  const sections = input.sections ?? POSTMORTEM_SECTIONS;
  const severities = input.severities ?? POSTMORTEM_SEVERITIES;
  const checklist = input.checklist ?? BLAMELESS_REVIEW_CHECKLIST;
  const detectionSources = input.detectionSources ?? DETECTION_SOURCES;
  const metadataFields = input.metadataFields ?? POSTMORTEM_METADATA_FIELDS;
  const runbookIds =
    input.runbookIds ?? RUNBOOK_CATALOGUE.map((runbook) => runbook.id);
  const sloStatuses =
    input.sloStatuses ?? new Map(SLO_CATALOGUE.map((slo) => [slo.id, slo.status]));
  const budgetObjectiveIds = input.budgetObjectiveIds ?? BUDGET_TRIGGER_OBJECTIVE_IDS;

  const violations: Violation[] = [];
  const add = (rule: PostmortemAuditRule, file: string, location: string, message: string) =>
    violations.push({ rule, file, location, message });

  for (const finding of validatePostmortemProcess(
    severities,
    sections,
    checklist,
    detectionSources,
    metadataFields,
  )) {
    add('process', 'lib/postmortems.ts', finding.subject, `[${finding.rule}] ${finding.message}`);
  }

  const form = parseIssueForm(input.issueForm);
  const fieldsById = new Map(
    form.fields
      .filter((field): field is FormField & { id: string } => field.id !== undefined)
      .map((field) => [field.id, field]),
  );
  const docAnchors = anchorsIn(input.doc);

  /* Sections: doc heading, form field, and the requirement, in both directions. */

  for (const section of sections) {
    if (!docAnchors.has(sectionAnchor(section))) {
      add(
        'section-heading-missing',
        POSTMORTEM_DOC_PATH,
        section.id,
        `no heading '${section.heading}' in the document, so the section the form asks for is ` +
          'one nobody has explained. Anything linking to it lands at the top of the page, which ' +
          'GitHub answers 200 for.',
      );
    }

    const field = fieldsById.get(section.formFieldId);
    if (!field) {
      add(
        'section-field-missing',
        POSTMORTEM_ISSUE_FORM_PATH,
        section.formFieldId,
        `the process declares section '${section.id}' and the form never asks for it. A ` +
          'postmortem missing a section nobody asked for reads complete.',
      );
      continue;
    }

    if (field.required !== section.required) {
      add(
        'field-requirement-mismatch',
        POSTMORTEM_ISSUE_FORM_PATH,
        section.formFieldId,
        section.required
          ? 'the process requires this section and the form will submit without it. That holds ' +
            'until the first write-up typed at 23:00, which is the one that matters most.'
          : 'the process marks this section optional and the form refuses to submit without it. ' +
            'The first incident of its kind genuinely has nothing to put here, and a form that ' +
            'cannot be submitted honestly teaches people to type "n/a".',
      );
    }

    if (field.type !== 'textarea') {
      add(
        'field-kind-mismatch',
        POSTMORTEM_ISSUE_FORM_PATH,
        section.formFieldId,
        `is a '${field.type}'. Every narrative section is a textarea: a single-line input for a ` +
          'timeline is a field people answer in one sentence because that is what fits.',
      );
    }
  }

  /* Metadata fields: kind, requirement and, for dropdowns, the list behind them. */

  for (const declared of metadataFields) {
    const field = fieldsById.get(declared.id);
    if (!field) {
      add(
        'section-field-missing',
        POSTMORTEM_ISSUE_FORM_PATH,
        declared.id,
        `the process declares the field '${declared.id}' and the form does not have it. These ` +
          'are the facts a report is built from, and a missing one is a column of nulls.',
      );
      continue;
    }

    if (field.type !== declared.kind) {
      add(
        'field-kind-mismatch',
        POSTMORTEM_ISSUE_FORM_PATH,
        declared.id,
        `is a '${field.type}' where the process declares a '${declared.kind}'. A dropdown ` +
          'rendered as free text is a column nothing can group by.',
      );
    }

    if (field.required !== declared.required) {
      add(
        'field-requirement-mismatch',
        POSTMORTEM_ISSUE_FORM_PATH,
        declared.id,
        `the process ${declared.required ? 'requires' : 'does not require'} this field and the ` +
          `form ${field.required ? 'does' : 'does not'}.`,
      );
    }

    if (declared.optionsFrom !== undefined) {
      const expected =
        declared.optionsFrom === 'severities'
          ? severities.map((severity) => severity.label)
          : detectionSources.map((source) => source.label);
      if (
        field.options.length !== expected.length ||
        field.options.some((option, index) => option !== expected[index])
      ) {
        add(
          'dropdown-options-mismatch',
          POSTMORTEM_ISSUE_FORM_PATH,
          declared.id,
          `offers ${describeList(field.options)} where the ${declared.optionsFrom} list is ` +
            `${describeList(expected)}. An incident filed against an option the process has no ` +
            'row for is a full form and an unclassified incident.',
        );
      }
    }
  }

  /* Every answering field in the form is something the process declared. */

  const declaredFieldIds = new Set<string>([
    ...sections.map((section) => section.formFieldId),
    ...metadataFields.map((field) => field.id),
    CHECKLIST_FIELD_ID,
  ]);
  for (const field of form.fields) {
    // A `markdown` element carries no answer and needs no id, which is why the
    // coverage rule is over the answering types rather than over the body.
    if (!(ANSWERING_ELEMENT_TYPES as readonly string[]).includes(field.type)) continue;
    if (field.id === undefined) {
      add(
        'form-field-undeclared',
        POSTMORTEM_ISSUE_FORM_PATH,
        `${field.type}/${field.label ?? '(unlabelled)'}`,
        'has no id, so GitHub keys its answer by the label. Renaming the label then silently ' +
          'renames the field, and nothing in the process declares it in the first place.',
      );
      continue;
    }
    if (!declaredFieldIds.has(field.id)) {
      add(
        'form-field-undeclared',
        POSTMORTEM_ISSUE_FORM_PATH,
        field.id,
        'is not declared in lib/postmortems.ts. People fill it in with a guess, the guesses ' +
          'differ per author, and the field ends up populated and unusable.',
      );
    }
  }

  /* The checklist: the form, the doc and the library say the same ten things. */

  const checklistField = fieldsById.get(CHECKLIST_FIELD_ID);
  if (!checklistField) {
    add(
      'checklist-options-mismatch',
      POSTMORTEM_ISSUE_FORM_PATH,
      CHECKLIST_FIELD_ID,
      `the form has no '${CHECKLIST_FIELD_ID}' field, so "blameless" is an adjective in a ` +
        'document rather than anything the review does.',
    );
  } else {
    if (checklistField.type !== CHECKLIST_ELEMENT_TYPE) {
      add(
        'field-kind-mismatch',
        POSTMORTEM_ISSUE_FORM_PATH,
        CHECKLIST_FIELD_ID,
        `is a '${checklistField.type}' where the checklist has to be a ` +
          `'${CHECKLIST_ELEMENT_TYPE}'. Anything else is prose nobody has to answer.`,
      );
    }

    const expected = checklist.map((item) => item.question);
    const missing = expected.filter((question) => !checklistField.options.includes(question));
    const extra = checklistField.options.filter((option) => !expected.includes(option));
    if (missing.length > 0 || extra.length > 0) {
      add(
        'checklist-options-mismatch',
        POSTMORTEM_ISSUE_FORM_PATH,
        CHECKLIST_FIELD_ID,
        `the form and the checklist have diverged. Missing from the form: ` +
          `${describeList(missing)}. Not in the checklist: ${describeList(extra)}. A question ` +
          'the review asks and the doc does not explain gets ticked without being applied.',
      );
    }
  }

  // Compared with runs of whitespace collapsed. The questions are ~90 characters
  // and this document wraps at 80, so a literal `includes` would demand an
  // unwrapped line in a wrapped file — a rule that fights the format it checks
  // is a rule somebody deletes. What it still catches is a word changed in one
  // place and not the other, which is the actual failure.
  const flattenedDoc = input.doc.replace(/\s+/g, ' ');
  for (const item of checklist) {
    if (!flattenedDoc.includes(item.question.replace(/\s+/g, ' '))) {
      add(
        'checklist-question-not-in-doc',
        POSTMORTEM_DOC_PATH,
        item.id,
        `the question '${item.question}' does not appear. The paragraph explaining why ` +
          'an item is there is the difference between a review and a ritual, and a paraphrase ' +
          'is how the two stop matching.',
      );
    }
  }

  /* Blame language in the form. */

  for (const field of form.fields) {
    // The checklist is exempt, and has to be: two of its questions name the
    // language the process rejects — a counterfactual and "should have noticed"
    // — because a checklist that cannot quote what it is looking for is a
    // checklist nobody can apply. Scoped to this one field id rather than to the
    // `checkboxes` type, so a second checkboxes field does not inherit the
    // exemption.
    if (field.id === CHECKLIST_FIELD_ID) continue;

    for (const text of field.texts) {
      const blame = blameLanguageIn(text, BLAME_LANGUAGE);
      if (blame) {
        add(
          'blame-language-in-form',
          POSTMORTEM_ISSUE_FORM_PATH,
          field.id ?? field.type,
          `matches ${blame.pattern}: ${blame.reason}`,
        );
        // One finding per field. The reason is what the author needs, and a
        // placeholder that trips three patterns is one edit.
        break;
      }
    }
  }

  /* The form's own wiring. */

  if (!form.labels.includes(POSTMORTEM_LABEL)) {
    add(
      'issue-form-label-missing',
      POSTMORTEM_ISSUE_FORM_PATH,
      'labels',
      `does not apply '${POSTMORTEM_LABEL}'. "Have we seen this contributing factor before" is ` +
        'answerable only if the postmortems are one query, and an issue whose label was left to ' +
        'the author is not in it.',
    );
  }

  if (form.title === undefined || !form.title.startsWith(POSTMORTEM_TITLE_PREFIX)) {
    add(
      'issue-form-title-missing',
      POSTMORTEM_ISSUE_FORM_PATH,
      'title',
      `does not prefix the issue title with '${POSTMORTEM_TITLE_PREFIX}', so the list of ` +
        'postmortems reads as a list of unrelated issues.',
    );
  }

  /* Triggers keyed to things that have to still exist. */

  const knownRunbookIds = new Set(runbookIds);
  for (const severity of severities) {
    for (const runbookId of severity.runbookIds) {
      if (!knownRunbookIds.has(runbookId)) {
        add(
          'runbook-reference-unknown',
          'lib/postmortems.ts',
          `${severity.id}/${runbookId}`,
          `names a runbook that is not in RUNBOOK_CATALOGUE. A rename leaves this severity ` +
            'keyed to an id nothing produces: no build fails, no alarm changes, and the row ' +
            'simply stops classifying anything.',
        );
      }
    }
  }

  const classifiedRunbookIds = new Set(
    severities.flatMap((severity) => [...severity.runbookIds]),
  );
  for (const runbookId of runbookIds) {
    if (!classifiedRunbookIds.has(runbookId)) {
      add(
        'runbook-without-severity',
        'lib/postmortems.ts',
        runbookId,
        `is a runbook no severity names, so an alarm that reached a human through it ends with ` +
          'nothing saying whether a write-up is owed. This is the default state of every runbook ' +
          'added later, because adding one touches neither the process nor the form.',
      );
    }
  }

  for (const objectiveId of budgetObjectiveIds) {
    const status = sloStatuses.get(objectiveId);
    if (status === undefined) {
      add(
        'budget-objective-not-active',
        'lib/postmortems.ts',
        objectiveId,
        'is not in SLO_CATALOGUE, so the budget-spend trigger keyed to it reads off an ' +
          'objective that does not exist.',
      );
    } else if (status !== MEASURED_SLO_STATUS) {
      add(
        'budget-objective-not-active',
        'lib/postmortems.ts',
        objectiveId,
        `is '${status}' rather than '${MEASURED_SLO_STATUS}'. Nothing measures a proposed ` +
          'objective, so there is no budget to have spent and the trigger can never fire — ' +
          'while reading exactly like one that can.',
      );
    }
  }

  /* Links, in both directions. */

  const referenced = [
    ...postmortemAnchorsReferencedIn(input.doc, POSTMORTEM_DOC_PATH),
    ...postmortemAnchorsReferencedIn(input.issueForm, POSTMORTEM_DOC_PATH),
    ...postmortemAnchorsReferencedIn(input.runbookDoc, POSTMORTEM_DOC_PATH),
    ...inPageAnchorsIn(input.doc),
  ];
  const uniqueReferenced = [...new Set(referenced)];
  for (const anchor of uniqueReferenced) {
    if (!docAnchors.has(anchor)) {
      add(
        'doc-anchor-missing',
        POSTMORTEM_DOC_PATH,
        anchor,
        `is linked to and has no heading. GitHub answers 200 for an anchor that does not exist ` +
          'and lands the reader at the top of the page, so the link looks fine in review and ' +
          'sends the responder to the wrong section.',
      );
    }
  }

  if (!linksTo(input.runbookDoc, POSTMORTEM_DOC_PATH)) {
    add(
      'cross-link-missing',
      RUNBOOK_DOC_PATH,
      'postmortem',
      `does not link ${POSTMORTEM_DOC_PATH}. The responder is in this document at 04:00; if ` +
        'nothing here says a write-up is owed, the process is one nobody has opened. An ' +
        'unlinked process is the same as no process, and both documents look fine on their own.',
    );
  }

  if (!linksTo(input.doc, RUNBOOK_DOC_PATH)) {
    add(
      'cross-link-missing',
      POSTMORTEM_DOC_PATH,
      'runbooks',
      `does not link ${RUNBOOK_DOC_PATH}. Two of the checklist items are about what the runbook ` +
        'said and whether it has been corrected, and neither is actionable without the way back.',
    );
  }

  return {
    violations,
    fieldsRead: fieldsById.size,
    anchorsChecked: uniqueReferenced.length,
  };
};

export const formatViolations = (violations: readonly Violation[]): string =>
  violations.map((v) => `  [${v.rule}] ${v.file} ${v.location}\n      ${v.message}`).join('\n');

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));

  const read = (relative: string): string => {
    const absolute = path.join(root, relative);
    if (!fs.existsSync(absolute)) {
      console.error(
        `\n${relative} does not exist. This gate holds the process, the form and the ` +
          'responder\'s document against each other, and it cannot report on a file it cannot ' +
          'read.\n',
      );
      process.exit(1);
    }
    return fs.readFileSync(absolute, 'utf8');
  };

  const result = auditPostmortems({
    doc: read(POSTMORTEM_DOC_PATH),
    issueForm: read(POSTMORTEM_ISSUE_FORM_PATH),
    runbookDoc: read(RUNBOOK_DOC_PATH),
  });

  // A gate that reported nothing because it read nothing passes identically to
  // one that read everything and found nothing.
  if (result.fieldsRead === 0) {
    console.error(
      `\nNo identified fields in ${POSTMORTEM_ISSUE_FORM_PATH}. Either the form was replaced ` +
        'with a markdown template or its body no longer parses, and both leave every rule below ' +
        'unevaluated while this gate stays green.\n',
    );
    process.exit(1);
  }

  if (result.violations.length > 0) {
    console.error(`\n${result.violations.length} postmortem process violation(s):\n`);
    console.error(formatViolations(result.violations));
    console.error(`\nSee ${POSTMORTEM_DOC_PATH}.\n`);
    process.exit(1);
  }

  console.log(
    `${POSTMORTEM_SECTIONS.length} section(s) and ${POSTMORTEM_METADATA_FIELDS.length} ` +
      `structured field(s) across ${result.fieldsRead} form field(s): each has a heading in ` +
      `${POSTMORTEM_DOC_PATH}, is collected with the requirement the process declares, and ` +
      `carries no blame-shaped prompt; ${BLAMELESS_REVIEW_CHECKLIST.length} checklist item(s) ` +
      `match the form and the doc; ${POSTMORTEM_SEVERITIES.length} severities are keyed to ` +
      `runbooks and objectives that exist; and ${result.anchorsChecked} cross-document anchor(s) ` +
      'resolve.',
  );
}
