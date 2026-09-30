/**
 * The postmortem process as data: what gets written after an incident, what the
 * review asks of it, and which incidents owe one at all.
 *
 * Everything before this item makes a failure visible and puts a procedure in
 * the responder's hand. None of it changes anything afterwards. The incident
 * ends, the page clears, the responder goes back to bed, and the next one has
 * the same contributing factors — which is not a documentation problem, because
 * a postmortem nobody wrote is indistinguishable from an incident that taught us
 * nothing, and both look like a quiet week.
 *
 * Three failures shaped this file, and each is invisible in review:
 *
 *   1. **Nothing triggers a postmortem.** "Was that bad enough to write up?" is
 *      decided at the end of a long night by the person least able to judge it,
 *      and the answer trends to no. {@link POSTMORTEM_SEVERITIES} makes the
 *      trigger a property of the incident — a signal that fired, a budget spend,
 *      a class of impact — rather than a judgement call, and every severity
 *      records *something* even when it does not owe a full write-up.
 *
 *   2. **The template asks who.** A timeline that names people is a performance
 *      review with the grammar of an analysis, and the cost is not fairness: it
 *      is that the next person edits their answer, and the document stops being
 *      a record of what was actually known at the time. The section prompts here
 *      never ask who, {@link BLAME_LANGUAGE} is the set of phrases the gate
 *      refuses in the prompts and in the issue form, and
 *      {@link BLAMELESS_REVIEW_CHECKLIST} is what the review asks instead.
 *
 *   3. **The three copies drift.** The process lives in `docs/postmortem.md`,
 *      the thing people actually fill in is
 *      `.github/ISSUE_TEMPLATE/postmortem.yml`, and the review reads off a
 *      checklist. Nothing in GitHub reconciles them: a section added to the doc
 *      and not to the form is a section nobody is asked for, a form field the
 *      doc never describes is a box people guess at, and a checklist item that
 *      matches neither is a question the review asks about a field that does not
 *      exist. All three read as correct on their own, which is why this file is
 *      the single declaration and `tools/audit-postmortems.ts` holds the other
 *      two against it.
 *
 * Rules that can be decided from this file alone are in
 * {@link validatePostmortemProcess}. The rules that need the markdown, the issue
 * form, the runbook catalogue or the SLO catalogue are in
 * `tools/audit-postmortems.ts`, because they need something this file cannot
 * see.
 *
 * See docs/postmortem.md.
 */

/** Where the process lives, relative to the repository root. */
export const POSTMORTEM_DOC_PATH = 'docs/postmortem.md';

/**
 * The GitHub issue form people actually fill in.
 *
 * An issue form rather than a markdown template, and rather than a document in a
 * wiki: the form can mark a field required, which is the only mechanism in reach
 * that stops a postmortem being filed without a timeline. A markdown template is
 * a set of headings the author is free to delete, and the ones deleted under
 * time pressure are reliably {@link POSTMORTEM_SECTIONS} 6 and 7.
 */
export const POSTMORTEM_ISSUE_FORM_PATH = '.github/ISSUE_TEMPLATE/postmortem.yml';

/**
 * The label the form applies.
 *
 * Load-bearing rather than decoration: "have we seen this contributing factor
 * before" is answerable only if the postmortems are one query, and an issue
 * whose label was left to the author is not in it.
 */
export const POSTMORTEM_LABEL = 'postmortem';

/** Prefix the form puts in the issue title, so the list reads as a list. */
export const POSTMORTEM_TITLE_PREFIX = 'Postmortem: ';

/** Id of the checkboxes field carrying {@link BLAMELESS_REVIEW_CHECKLIST}. */
export const CHECKLIST_FIELD_ID = 'blameless-review';

/* ── Severity and what it obliges ─────────────────────────────────────────── */

/**
 * An incident severity, its triggers, and what it owes.
 *
 * `triggers` are deliberately observable facts rather than adjectives. "Major
 * customer impact" is a judgement made by the person who has been awake since
 * 03:00; "the canary quorum alarm paged" is a row in an alarm history.
 */
export interface PostmortemSeverity {
  /** Stable, lower-case. Appears in the issue form's dropdown and in the title. */
  readonly id: string;
  /**
   * What the severity dropdown shows.
   *
   * The dropdowns in the issue form offer labels rather than ids, for both this
   * list and {@link DETECTION_SOURCES}: GitHub records the chosen option's text
   * in the issue body, and `burn-rate` in a document read during the next
   * incident is worse than the sentence it stands for. The id is what the gate
   * and the doc's trigger table use.
   */
  readonly label: string;
  /**
   * Facts about the incident, any one of which puts it at this severity.
   *
   * Each one has to be checkable after the fact from something this repository
   * already records — an alarm state history, an error-budget reading, a
   * canary's verdict.
   */
  readonly triggers: readonly string[];
  /**
   * Runbooks whose alarms reach this severity, by id in `lib/runbooks.ts`.
   *
   * Checked against `RUNBOOK_CATALOGUE` by the gate. A runbook rename otherwise
   * leaves a severity keyed to an id nothing produces, which fires no build
   * failure and no page — it simply stops classifying anything.
   */
  readonly runbookIds: readonly string[];
  /** A full write-up, or only a record. */
  readonly requiresPostmortem: boolean;
  /**
   * Whether the incident is recorded at all.
   *
   * Never false. A severity that records nothing is how "is this the third time
   * this month?" becomes unanswerable, and the answer to that question is the
   * only reason the lower severities have a row here.
   */
  readonly requiresRecord: boolean;
  /**
   * Business days from the incident ending to the review.
   *
   * `undefined` where no write-up is owed. A deadline rather than "as soon as
   * possible", because the document is written from memory and the memory is
   * gone in a fortnight — and because a review with no date is scheduled after
   * the next incident.
   */
  readonly dueWithinBusinessDays?: number;
}

/**
 * Objectives whose error-budget spend is a trigger.
 *
 * By id in `lib/slo-definitions.ts`. The gate rejects an id that is missing from
 * that catalogue *or* whose status is `proposed`: a trigger keyed to an
 * objective nothing measures can never fire, and it reads in this file exactly
 * like one that can. `production-api-latency` is `proposed` for the reason
 * docs/slo.md §5 gives, so it is deliberately not here.
 */
export const BUDGET_TRIGGER_OBJECTIVE_IDS = ['production-api-availability'] as const;

/**
 * Error-budget spend, as a percentage of one objective's window budget, that
 * obliges a write-up on its own.
 *
 * A single incident spending a quarter of a 30-day budget is a quarter of the
 * month's allowance gone in an afternoon, whatever it felt like at the time —
 * which is the point of having a number here rather than an impression.
 */
export const SEV1_BUDGET_SPEND_PERCENT = 25;
export const SEV2_BUDGET_SPEND_PERCENT = 5;

export const POSTMORTEM_SEVERITIES: readonly PostmortemSeverity[] = [
  {
    id: 'sev1',
    label: 'Sev1',
    triggers: [
      'A synthetic canary quorum alarm paged: probes outside the account could not get a good ' +
        'response, which is the only signal here measured from where the user is.',
      `A single incident spent ${SEV1_BUDGET_SPEND_PERCENT}% or more of an objective's error ` +
        'budget for its window.',
      'Data was lost, or personal data left the systems that are allowed to hold it.',
      'Recovery needed a change nobody had rehearsed — a manual database write, a rollback ' +
        'outside the deploy pipeline, a resource recreated by hand.',
    ],
    runbookIds: ['synthetic-canary', 'api-5xx', 'log-pipeline'],
    requiresPostmortem: true,
    requiresRecord: true,
    dueWithinBusinessDays: 5,
  },
  {
    id: 'sev2',
    label: 'Sev2',
    triggers: [
      'A paging alarm fired and a human changed something to clear it.',
      `A single incident spent between ${SEV2_BUDGET_SPEND_PERCENT}% and ` +
        `${SEV1_BUDGET_SPEND_PERCENT}% of an objective's error budget.`,
      'The database or the cache was degraded in a way users could measure, even if no ' +
        'objective breached.',
    ],
    runbookIds: ['ecs-saturation', 'slo-burn-rate', 'rds-connections', 'db-recovery'],
    requiresPostmortem: true,
    requiresRecord: true,
    dueWithinBusinessDays: 10,
  },
  {
    id: 'sev3',
    label: 'Sev3',
    triggers: [
      'A ticket-severity alarm fired: something that measures the platform stopped reporting, ' +
        'or a threshold was crossed with no user-visible effect.',
      'A page cleared itself before anyone acted on it.',
      'A near miss: the system was one failure away from a Sev2 and that failure did not happen.',
    ],
    runbookIds: ['platform-tooling', 'waf-blocked-requests'],
    requiresPostmortem: false,
    requiresRecord: true,
  },
];

/* ── How we found out ─────────────────────────────────────────────────────── */

/**
 * The options on the "how did we find out" field.
 *
 * `isHuman` marks the answers that mean no signal fired. At least one has to
 * exist: a form whose detection options are all machines makes the true answer
 * unselectable, so the author picks the nearest machine and the one number worth
 * having out of the whole document — how often we learn about our own outages
 * from someone else — is quietly wrong in the safe direction.
 */
export interface DetectionSource {
  readonly id: string;
  readonly label: string;
  readonly isHuman: boolean;
}

export const DETECTION_SOURCES: readonly DetectionSource[] = [
  { id: 'canary', label: 'A synthetic canary alarm', isHuman: false },
  { id: 'burn-rate', label: 'An SLO burn-rate or error-budget alarm', isHuman: false },
  { id: 'alarm', label: 'Another CloudWatch alarm', isHuman: false },
  { id: 'deploy-gate', label: 'A deployment gate or an automated rollback', isHuman: false },
  { id: 'customer', label: 'A customer told us', isHuman: true },
  { id: 'colleague', label: 'A colleague noticed something', isHuman: true },
  { id: 'incidental', label: 'Found while looking at something else', isHuman: true },
];

/* ── The narrative sections ───────────────────────────────────────────────── */

/**
 * One section of the write-up.
 *
 * `heading` is the heading in {@link POSTMORTEM_DOC_PATH} that explains the
 * section and shows a filled-in example; `formFieldId` is the field in
 * {@link POSTMORTEM_ISSUE_FORM_PATH} that collects it. The gate holds all three
 * together, in both directions, because each pair can drift on its own and none
 * of the three looks wrong alone.
 */
export interface PostmortemSection {
  /** Stable, kebab-case. Used in discussion and in the gate's output. */
  readonly id: string;
  /** Exact heading text in the doc, without the `## ` and without a number. */
  readonly heading: string;
  /** `id` of the field in the issue form. */
  readonly formFieldId: string;
  /**
   * Whether the form refuses to submit without it.
   *
   * Checked in both directions. A required section whose field is optional is a
   * section that gets skipped under time pressure; an optional section whose
   * field is required is a form that cannot be submitted for the first incident
   * of its kind, which is how a template gets abandoned in week two.
   */
  readonly required: boolean;
  /**
   * The question the section asks the author.
   *
   * Scanned for {@link BLAME_LANGUAGE}: this is the text that decides what kind
   * of document gets written, and "what was the root cause" produces one cause
   * and stops.
   */
  readonly prompt: string;
}

export const POSTMORTEM_SECTIONS: readonly PostmortemSection[] = [
  {
    id: 'summary',
    heading: 'Summary',
    formFieldId: 'summary',
    required: true,
    prompt:
      'What broke, for whom, for how long, and what has changed since. Three sentences, ' +
      'written for somebody who was not there and has thirty seconds.',
  },
  {
    id: 'impact',
    heading: 'Impact',
    formFieldId: 'impact',
    required: true,
    prompt:
      'What users could not do, measured in requests, sessions or error-budget minutes rather ' +
      'than in CPU percent. If the number is unknown, say that it is unknown and why — an ' +
      'estimate that reads like a measurement is worse than a gap.',
  },
  {
    id: 'detection',
    heading: 'Detection',
    formFieldId: 'detection',
    required: true,
    prompt:
      'Which signal fired first, how long after the impact started, and what the alert carried. ' +
      'If the runbook was reached, say whether its first step answered the question it exists ' +
      'to answer.',
  },
  {
    id: 'timeline',
    heading: 'Timeline',
    formFieldId: 'timeline',
    required: true,
    prompt:
      'One line per observable event, in UTC: what happened, what a signal showed, what was ' +
      'known at that moment, and what was believed. Keep the beliefs that turned out to be ' +
      'wrong — the gap between what was known and what was true is the whole analysis.',
  },
  {
    id: 'contributing-factors',
    heading: 'Contributing factors',
    formFieldId: 'contributing-factors',
    required: true,
    prompt:
      'Each condition without which this incident would not have happened, and for each one, ' +
      'what made the wrong thing look correct at the time. Expect several; an incident with ' +
      'exactly one is an analysis that stopped at the first thing that looked wrong.',
  },
  {
    id: 'what-went-well',
    heading: 'What went well',
    formFieldId: 'what-went-well',
    required: true,
    prompt:
      'Which safeguard, signal or habit shortened this. Required, because these are the things ' +
      'a cost review removes when nobody has written down what they bought.',
  },
  {
    id: 'where-we-got-lucky',
    heading: 'Where we got lucky',
    formFieldId: 'where-we-got-lucky',
    required: true,
    prompt:
      'What would have made this materially worse and did not happen this time. Every incident ' +
      'has one; a blank answer means nobody looked, and luck is the safeguard that will not ' +
      'hold next time.',
  },
  {
    id: 'action-items',
    heading: 'Action items',
    formFieldId: 'action-items',
    required: true,
    prompt:
      'One line each: `[class] owning team — what changes — tracking issue`. Class is one of ' +
      'prevent, detect, mitigate or process, and at least one has to be a detect: prevention ' +
      'items assume the next one is a repeat of this one.',
  },
  {
    id: 'related-incidents',
    heading: 'Related incidents',
    formFieldId: 'related-incidents',
    required: false,
    prompt:
      'Earlier postmortems sharing a contributing factor with this one, by issue number. ' +
      'Optional, and the only optional section here: the first incident of its kind genuinely ' +
      'has none, and a required field with nothing to put in it teaches people to type "n/a".',
  },
];

/* ── The structured facts ─────────────────────────────────────────────────── */

/**
 * A field that carries a fact rather than a narrative.
 *
 * Separate from {@link POSTMORTEM_SECTIONS} because these have no heading in the
 * doc and no prose in the issue: they are the columns you would want if you ever
 * asked "what is our median time to detect, and is it going down". A sentence in
 * a summary cannot answer that; a required input can.
 *
 * `optionsFrom` names the list a dropdown's options must equal, so the form and
 * this file cannot come to offer different severities.
 */
export interface PostmortemMetadataField {
  readonly id: string;
  /** GitHub issue-form element type. */
  readonly kind: 'input' | 'dropdown' | 'textarea';
  readonly label: string;
  readonly required: boolean;
  /** Only for `dropdown`. The gate holds the options to this list, in order. */
  readonly optionsFrom?: 'severities' | 'detection-sources';
}

export const POSTMORTEM_METADATA_FIELDS: readonly PostmortemMetadataField[] = [
  {
    id: 'incident-id',
    kind: 'input',
    label: 'Incident id',
    required: true,
  },
  {
    id: 'severity',
    kind: 'dropdown',
    label: 'Severity',
    required: true,
    optionsFrom: 'severities',
  },
  {
    id: 'owning-team',
    kind: 'input',
    label: 'Team running this review',
    required: true,
  },
  {
    id: 'started-at',
    kind: 'input',
    label: 'Impact started (UTC)',
    required: true,
  },
  {
    id: 'resolved-at',
    kind: 'input',
    label: 'Impact ended (UTC)',
    required: true,
  },
  {
    id: 'detection-source',
    kind: 'dropdown',
    label: 'How we found out',
    required: true,
    optionsFrom: 'detection-sources',
  },
  {
    id: 'time-to-detect',
    kind: 'input',
    label: 'Minutes from impact starting to the first signal',
    required: true,
  },
  {
    id: 'budget-spent',
    kind: 'input',
    label: 'Error budget spent, as a percentage of the objective window',
    required: false,
  },
];

/** Classes an action item may carry. */
export const ACTION_ITEM_CLASSES = ['prevent', 'detect', 'mitigate', 'process'] as const;

export type ActionItemClass = (typeof ACTION_ITEM_CLASSES)[number];

/**
 * The class at least one action item must have.
 *
 * Detection, not prevention. Prevention items are the ones that write themselves
 * at the end of a review, and they are all predicated on the next incident
 * resembling this one. The detection item is the one that pays off when it does
 * not.
 */
export const REQUIRED_ACTION_ITEM_CLASS: ActionItemClass = 'detect';

/* ── The review checklist ─────────────────────────────────────────────────── */

/**
 * One question the review asks of the document in front of it.
 *
 * `question` appears verbatim in three places — this file, the doc's checklist
 * section, and the issue form's checkboxes — and the gate holds them to the
 * character. Paraphrasing is how a checklist item in the form stops matching the
 * paragraph in the doc that explains why it is there.
 */
export interface BlamelessChecklistItem {
  readonly id: string;
  /** Asked of the document, answerable yes or no by reading it. */
  readonly question: string;
  /** What goes wrong when the answer is no. One or two sentences. */
  readonly why: string;
}

export const BLAMELESS_REVIEW_CHECKLIST: readonly BlamelessChecklistItem[] = [
  {
    id: 'no-names',
    question: 'Is the document free of individual names outside the attendee list?',
    why:
      'A name in a timeline turns a systems review into a performance review. The cost is not ' +
      'unfairness — it is that everyone who reads it afterwards edits their own answers, and ' +
      'the document stops recording what was actually known at the time.',
  },
  {
    id: 'no-counterfactuals',
    question:
      'Is the document free of counterfactuals — "if only X had checked", "they should have ' +
      'noticed"?',
    why:
      'A counterfactual describes a world that did not happen, so nothing in it can be built, ' +
      'measured or deployed. It is blame with the grammar of analysis, and it occupies the ' +
      'space where an action item would have gone.',
  },
  {
    id: 'factors-plural',
    question: 'Are there at least two contributing factors, each with what made it look correct?',
    why:
      'One cause means the analysis stopped at the first thing that looked wrong. The condition ' +
      'that made a wrong action the reasonable one is the part that can be changed; the action ' +
      'itself is not.',
  },
  {
    id: 'detection-measured',
    question: 'Is time-to-detection a number, and does it come from a signal rather than a memory?',
    why:
      'This is the number the alarms, canaries and burn-rate policies exist to move, and it is ' +
      'the one nobody writes down. "A customer told us" is a finding rather than an ' +
      'embarrassment: it is the finding that changes what gets built next.',
  },
  {
    id: 'luck-recorded',
    question: 'Is there something concrete in "Where we got lucky"?',
    why:
      'A blank answer means nobody looked. Luck is a safeguard that happened to hold, and the ' +
      'next incident is where it does not.',
  },
  {
    id: 'actions-owned',
    question: 'Does every action item name an owning team, a class, and a tracking issue?',
    why:
      'An action item with no issue is a sentence in a document nobody opens again. An owner ' +
      'who is a person rather than a team expires when they change rota.',
  },
  {
    id: 'one-detection-action',
    question: 'Is at least one action item a detect?',
    why:
      'Prevention items are the easy ones to write and they all assume the next incident looks ' +
      'like this one. Detection is what holds when it does not.',
  },
  {
    id: 'no-be-more-careful',
    question:
      'Is every action item a change to the system, rather than "be more careful" or "add ' +
      'training"?',
    why:
      'Neither is a change to the system, so neither can be reviewed, tested or deployed. If ' +
      'the only available action is care, the gap is a missing guardrail and that is the item.',
  },
  {
    id: 'runbook-updated',
    question: 'If a runbook was used, did it work — and has it been corrected?',
    why:
      'The gap between what the runbook said and what actually helped is free to collect for a ' +
      'few days after an incident and impossible afterwards. `lib/runbooks.ts` is where the ' +
      'correction goes.',
  },
  {
    id: 'signal-reviewed',
    question: 'Did every alarm that fired deserve to, and did every one that should have fire?',
    why:
      'An alarm that fired and told the responder nothing is noise that will be ignored during ' +
      'the next incident. An alarm that stayed green through this one is the more expensive ' +
      'finding, and the only chance to notice it is now.',
  },
];

/* ── Language the process refuses ─────────────────────────────────────────── */

/**
 * Phrases the gate refuses in the section prompts and in the issue form.
 *
 * Deliberately scoped to the prompts and the form, not to the whole document:
 * `docs/postmortem.md` has to be able to explain *why* "root cause" is not the
 * question it asks, and a rule that could not tell the explanation from the
 * instance would make the documentation unwritable — which is how a rule like
 * this gets suppressed and then deleted.
 *
 * `reason` is in the failure message. A gate that says "blame language found"
 * gets worked around; one that says what to ask instead gets used.
 */
export interface BlamePattern {
  readonly pattern: RegExp;
  readonly reason: string;
}

export const BLAME_LANGUAGE: readonly BlamePattern[] = [
  {
    pattern: /\bhuman error\b/i,
    reason:
      '"human error" is a restatement of the incident, not an explanation of it. Ask what made ' +
      'the wrong action the reasonable one.',
  },
  {
    pattern: /\broot cause\b/i,
    reason:
      '"root cause" asks for one, so the analysis stops at the first plausible answer. This ' +
      'process asks for contributing factors, plural.',
  },
  {
    pattern: /\b(who (caused|broke|did|was responsible)|whose fault|at fault|to blame)\b/i,
    reason:
      'The document is read by the people it describes. Asking who produces a document written ' +
      'defensively, which is a worse record of what was known at the time.',
  },
  {
    pattern: /\bshould have (known|noticed|checked|realised|realized|caught)\b/i,
    reason:
      'A counterfactual cannot be built or deployed. Ask what the system made easy and what it ' +
      'made invisible.',
  },
  {
    pattern: /\bfailed to (follow|read|check)\b/i,
    reason:
      'If a procedure was not followed, the reviewable question is what the procedure asked for ' +
      'at the time and whether it was possible.',
  },
  {
    pattern: /\bnegligen(t|ce)\b/i,
    reason: 'A finding about a person is not an action item about a system.',
  },
];

/**
 * The first {@link BLAME_LANGUAGE} entry this text matches, if any.
 *
 * One rather than all: the first is enough to reject the text, and the reason is
 * what the author needs.
 */
export const blameLanguageIn = (
  text: string,
  patterns: readonly BlamePattern[] = BLAME_LANGUAGE,
): BlamePattern | undefined =>
  // `test` on a shared RegExp is only stateful with the `g` flag, which none of
  // these carry — `validatePostmortemProcess` asserts that, because a `g` here
  // would make the same input match on one call and not the next.
  patterns.find((candidate) => candidate.pattern.test(text));

/* ── Lookups ──────────────────────────────────────────────────────────────── */

export const severityById = (
  id: string,
  severities: readonly PostmortemSeverity[] = POSTMORTEM_SEVERITIES,
): PostmortemSeverity | undefined => severities.find((severity) => severity.id === id);

/** Severities that owe a full write-up, in declaration order. */
export const severitiesRequiringPostmortem = (
  severities: readonly PostmortemSeverity[] = POSTMORTEM_SEVERITIES,
): PostmortemSeverity[] => severities.filter((severity) => severity.requiresPostmortem);

/** Runbook ids any severity is keyed to, deduplicated, in first-use order. */
export const referencedRunbookIds = (
  severities: readonly PostmortemSeverity[] = POSTMORTEM_SEVERITIES,
): string[] => [...new Set(severities.flatMap((severity) => [...severity.runbookIds]))];

/**
 * The anchor of a doc heading, as GitHub generates it.
 *
 * Kept here rather than in the gate because the doc links in
 * {@link POSTMORTEM_DOC_PATH} and in `docs/runbooks.md` are written by hand
 * against these headings, and the gate resolves them with
 * `anchorsIn` from `tools/audit-runbooks.ts` — the same implementation the
 * runbook links are checked with, so the two documents cannot disagree about
 * what an anchor is.
 */
export const sectionAnchor = (section: PostmortemSection): string =>
  `#${section.heading
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s/g, '-')}`;

/* ── Validation ───────────────────────────────────────────────────────────── */

export interface PostmortemFinding {
  /** Id of the offending entry, or `<process>` for a cross-entry rule. */
  readonly subject: string;
  /** Stable rule name, for discussion and docs. */
  readonly rule: string;
  readonly message: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every rule that can be decided from this file alone.
 *
 * Findings rather than throws, so a process with three problems reports three.
 */
export const validatePostmortemProcess = (
  severities: readonly PostmortemSeverity[] = POSTMORTEM_SEVERITIES,
  sections: readonly PostmortemSection[] = POSTMORTEM_SECTIONS,
  checklist: readonly BlamelessChecklistItem[] = BLAMELESS_REVIEW_CHECKLIST,
  detectionSources: readonly DetectionSource[] = DETECTION_SOURCES,
  metadataFields: readonly PostmortemMetadataField[] = POSTMORTEM_METADATA_FIELDS,
  blameLanguage: readonly BlamePattern[] = BLAME_LANGUAGE,
): PostmortemFinding[] => {
  const findings: PostmortemFinding[] = [];
  const report = (subject: string, rule: string, message: string) =>
    findings.push({ subject, rule, message });

  /* Severities. */

  if (severities.length === 0) {
    report('<process>', 'no-severities', 'no severities are declared, so nothing triggers a postmortem.');
  }

  if (severities.length > 0 && !severities[0].requiresPostmortem) {
    report(
      severities[0].id,
      'top-severity-without-postmortem',
      `'${severities[0].id}' is the highest severity declared and owes no write-up. Whatever ` +
        'else the process does, the worst class of incident cannot be the one nobody reviews.',
    );
  }

  const seenSeverityIds = new Set<string>();
  let previousDue = 0;
  for (const severity of severities) {
    if (!KEBAB_CASE.test(severity.id)) {
      report(
        severity.id,
        'severity-id-not-kebab-case',
        `id '${severity.id}' must be lower-case kebab-case: it names the row in the doc's ` +
          'trigger table and is what the gate and any report group incidents by.',
      );
    }
    if (seenSeverityIds.has(severity.id)) {
      report(
        severity.id,
        'duplicate-severity-id',
        `id '${severity.id}' is declared twice. The dropdown would offer it twice and the two ` +
          'rows would disagree about what it obliges.',
      );
    }
    seenSeverityIds.add(severity.id);

    if (!severity.label.trim()) {
      report(severity.id, 'severity-label-missing', 'label is required: it is what the dropdown shows.');
    }

    if (severity.triggers.length === 0) {
      report(
        severity.id,
        'severity-without-triggers',
        `'${severity.id}' has no triggers, so choosing it is a judgement call at the end of a ` +
          'long night — which is exactly the decision this table exists to take away.',
      );
    }
    for (const trigger of severity.triggers) {
      if (trigger.trim().length < 20) {
        report(
          severity.id,
          'severity-trigger-not-checkable',
          `trigger '${trigger}' is too short to be a fact about an incident. A trigger has to ` +
            'be checkable afterwards from something already recorded.',
        );
      }
    }

    if (severity.runbookIds.length === 0) {
      report(
        severity.id,
        'severity-without-runbooks',
        `'${severity.id}' names no runbook, so nothing in docs/runbooks.md tells the responder ` +
          'that this class of incident owes anything. The gate cannot check coverage it was ' +
          'never given.',
      );
    }
    if (new Set(severity.runbookIds).size !== severity.runbookIds.length) {
      report(severity.id, 'severity-runbook-duplicated', 'runbookIds lists the same runbook twice.');
    }

    if (!severity.requiresRecord) {
      report(
        severity.id,
        'severity-records-nothing',
        `'${severity.id}' records nothing at all. "Is this the third time this month?" is then ` +
          'unanswerable, and that question is the only reason a severity below the paging ones ' +
          'is in this table.',
      );
    }

    if (severity.requiresPostmortem) {
      if (severity.dueWithinBusinessDays === undefined) {
        report(
          severity.id,
          'due-date-missing',
          `'${severity.id}' owes a write-up with no deadline. The document is written from ` +
            'memory, the memory is gone in a fortnight, and a review with no date is scheduled ' +
            'after the next incident.',
        );
      } else if (severity.dueWithinBusinessDays <= 0) {
        report(
          severity.id,
          'due-date-not-positive',
          `dueWithinBusinessDays is ${severity.dueWithinBusinessDays}, which asks for the ` +
            'review before the incident has ended.',
        );
      } else if (severity.dueWithinBusinessDays < previousDue) {
        report(
          severity.id,
          'due-dates-not-ordered',
          `'${severity.id}' is due in ${severity.dueWithinBusinessDays} business days, sooner ` +
            `than the ${previousDue} allowed for a more severe incident above it. The ordering ` +
            'is the only thing that makes the table a scale.',
        );
      }
      previousDue = Math.max(previousDue, severity.dueWithinBusinessDays ?? 0);
    } else if (severity.dueWithinBusinessDays !== undefined) {
      report(
        severity.id,
        'due-date-without-postmortem',
        `'${severity.id}' owes no write-up but carries a deadline of ` +
          `${severity.dueWithinBusinessDays} business days, which reads as an obligation ` +
          'nothing enforces.',
      );
    }
  }

  /* Sections. */

  if (sections.length === 0) {
    report('<process>', 'no-sections', 'the template has no sections.');
  }

  const seenSectionIds = new Set<string>();
  const seenFieldIds = new Map<string, string[]>();
  for (const section of sections) {
    if (!KEBAB_CASE.test(section.id)) {
      report(
        section.id,
        'section-id-not-kebab-case',
        `id '${section.id}' must be lower-case kebab-case.`,
      );
    }
    if (seenSectionIds.has(section.id)) {
      report(section.id, 'duplicate-section-id', `section id '${section.id}' is declared twice.`);
    }
    seenSectionIds.add(section.id);

    seenFieldIds.set(section.formFieldId, [
      ...(seenFieldIds.get(section.formFieldId) ?? []),
      section.id,
    ]);

    if (!KEBAB_CASE.test(section.formFieldId)) {
      report(
        section.id,
        'form-field-id-not-kebab-case',
        `formFieldId '${section.formFieldId}' must be lower-case kebab-case: GitHub uses it as ` +
          'the field key in the issue body.',
      );
    }

    if (!section.heading.trim()) {
      report(section.id, 'section-heading-empty', 'heading is required: the gate resolves it against the doc.');
    }
    if (/^\d/.test(section.heading.trim())) {
      report(
        section.id,
        'section-heading-numbered',
        `heading '${section.heading}' starts with a number. The doc numbers its own headings, ` +
          'so a number here means the anchor this file computes and the anchor GitHub generates ' +
          'differ by exactly the part nobody reads.',
      );
    }

    if (section.prompt.trim().length < 40) {
      report(
        section.id,
        'section-prompt-too-short',
        'prompt is missing or too short to be a question. The prompt is what decides the kind ' +
          'of document that gets written.',
      );
    }

    const blame = blameLanguageIn(section.prompt, blameLanguage);
    if (blame) {
      report(
        section.id,
        'section-prompt-blame-shaped',
        `prompt matches ${blame.pattern}: ${blame.reason}`,
      );
    }
  }

  for (const [fieldId, sectionIds] of seenFieldIds) {
    if (sectionIds.length > 1) {
      report(
        '<process>',
        'duplicate-form-field-id',
        `form field '${fieldId}' is claimed by ${sectionIds.join(' and ')}. GitHub keys the ` +
          'issue body by field id, so the second section would overwrite the first.',
      );
    }
  }

  if (sections.length > 0 && !sections.some((section) => section.required)) {
    report(
      '<process>',
      'no-required-sections',
      'every section is optional, so a postmortem can be filed empty and will read as filed.',
    );
  }

  if (sections.some((section) => section.formFieldId === CHECKLIST_FIELD_ID)) {
    report(
      '<process>',
      'section-collides-with-checklist',
      `a section claims '${CHECKLIST_FIELD_ID}', which is the checkboxes field carrying the ` +
        'review checklist. One of the two would be dropped from the issue body.',
    );
  }

  /* Metadata fields. */

  const sectionFieldIds = new Set(sections.map((section) => section.formFieldId));
  const seenMetadataIds = new Set<string>();
  const optionSources = new Map<string, string[]>();
  for (const field of metadataFields) {
    if (!KEBAB_CASE.test(field.id)) {
      report(field.id, 'metadata-id-not-kebab-case', `id '${field.id}' must be lower-case kebab-case.`);
    }
    if (seenMetadataIds.has(field.id)) {
      report(field.id, 'duplicate-metadata-id', `metadata field '${field.id}' is declared twice.`);
    }
    seenMetadataIds.add(field.id);

    if (sectionFieldIds.has(field.id) || field.id === CHECKLIST_FIELD_ID) {
      report(
        field.id,
        'metadata-field-collides',
        `'${field.id}' is also a section or the checklist field. GitHub keys the issue body by ` +
          'field id, so one of the two answers would be lost.',
      );
    }

    if (!field.label.trim()) {
      report(field.id, 'metadata-label-missing', 'label is required: it is what the form shows.');
    }

    if (field.kind === 'dropdown' && field.optionsFrom === undefined) {
      report(
        field.id,
        'dropdown-without-option-source',
        `'${field.id}' is a dropdown with no optionsFrom, so its options are whatever the YAML ` +
          'happens to list and nothing holds them to this file.',
      );
    }
    if (field.kind !== 'dropdown' && field.optionsFrom !== undefined) {
      report(
        field.id,
        'option-source-on-free-text',
        `'${field.id}' is a ${field.kind} with optionsFrom set. A free-text field has no ` +
          'options, so the gate would be checking a list that does not exist.',
      );
    }
    if (field.optionsFrom !== undefined) {
      optionSources.set(field.optionsFrom, [
        ...(optionSources.get(field.optionsFrom) ?? []),
        field.id,
      ]);
    }
  }

  for (const [source, fieldIds] of optionSources) {
    if (fieldIds.length > 1) {
      report(
        '<process>',
        'duplicate-option-source',
        `${fieldIds.join(' and ')} both offer the ${source} list. Two dropdowns over one list ` +
          'is two answers to one question, and a report reading either of them is reading half ' +
          'the incidents.',
      );
    }
  }

  /* The checklist. */

  if (checklist.length === 0) {
    report(
      '<process>',
      'no-checklist',
      'the review has no checklist, so "blameless" is an adjective in a document rather than ' +
        'anything the review does.',
    );
  }

  const seenChecklistIds = new Set<string>();
  const seenQuestions = new Set<string>();
  for (const item of checklist) {
    if (!KEBAB_CASE.test(item.id)) {
      report(item.id, 'checklist-id-not-kebab-case', `id '${item.id}' must be lower-case kebab-case.`);
    }
    if (seenChecklistIds.has(item.id)) {
      report(item.id, 'duplicate-checklist-id', `checklist id '${item.id}' is declared twice.`);
    }
    seenChecklistIds.add(item.id);

    if (!item.question.trim().endsWith('?')) {
      report(
        item.id,
        'checklist-item-not-a-question',
        `'${item.question}' is not a question. A checklist of statements is read as a summary ` +
          'and agreed with; one of questions has to be answered.',
      );
    }
    if (seenQuestions.has(item.question)) {
      report(
        item.id,
        'duplicate-checklist-question',
        'two checklist items ask the same question, so the form would show it twice and the ' +
          'gate could not tell which one the doc explains.',
      );
    }
    seenQuestions.add(item.question);

    if (item.why.trim().length < 40) {
      report(
        item.id,
        'checklist-item-without-reason',
        'why is missing or too short. A checklist item with no reason beside it is ticked ' +
          'without being applied, which is how a review becomes a ritual.',
      );
    }
  }

  /* Detection sources. */

  if (!detectionSources.some((source) => source.isHuman)) {
    report(
      '<process>',
      'detection-without-human-source',
      'no detection source is marked isHuman, so "a customer told us" is unselectable. The ' +
        'author then picks the nearest signal and the one number worth having — how often we ' +
        'hear about our own outages from someone else — is wrong in the reassuring direction.',
    );
  }
  if (!detectionSources.some((source) => !source.isHuman)) {
    report(
      '<process>',
      'detection-without-automated-source',
      'every detection source is a human, so the field cannot record a signal firing and ' +
        'time-to-detect has nothing to measure against.',
    );
  }
  const seenSourceIds = new Set<string>();
  for (const source of detectionSources) {
    if (!KEBAB_CASE.test(source.id)) {
      report(source.id, 'detection-id-not-kebab-case', `id '${source.id}' must be lower-case kebab-case.`);
    }
    if (seenSourceIds.has(source.id)) {
      report(source.id, 'duplicate-detection-id', `detection source '${source.id}' is declared twice.`);
    }
    seenSourceIds.add(source.id);
    if (!source.label.trim()) {
      report(source.id, 'detection-label-missing', 'label is required: it is what the dropdown shows.');
    }
  }

  /* The blame patterns themselves. */

  for (const entry of blameLanguage) {
    if (entry.pattern.flags.includes('g')) {
      report(
        '<process>',
        'blame-pattern-is-global',
        `pattern ${entry.pattern} carries the 'g' flag. A shared global RegExp keeps its ` +
          '`lastIndex` between calls, so the same prompt is rejected on one run and accepted ' +
          'on the next.',
      );
    }
    if (entry.pattern.test('')) {
      report(
        '<process>',
        'blame-pattern-matches-everything',
        `pattern ${entry.pattern} matches the empty string, so every prompt and every form ` +
          'label is blame-shaped and the rule reports nothing useful.',
      );
    }
    if (entry.reason.trim().length < 40) {
      report(
        '<process>',
        'blame-pattern-without-reason',
        `pattern ${entry.pattern} has no real reason against it. A gate that says "blame ` +
          'language found" gets worked around; one that says what to ask instead gets used.',
      );
    }
  }

  if (!(ACTION_ITEM_CLASSES as readonly string[]).includes(REQUIRED_ACTION_ITEM_CLASS)) {
    report(
      '<process>',
      'required-action-class-unknown',
      `REQUIRED_ACTION_ITEM_CLASS is '${REQUIRED_ACTION_ITEM_CLASS}', which is not one of ` +
        `${ACTION_ITEM_CLASSES.join(', ')}. The review would ask for a class nobody can write.`,
    );
  }

  return findings;
};

/**
 * Throw on any violation.
 *
 * All of them are reported, not just the first: a bad edit usually produces
 * several, and fixing them one run at a time is how the last one gets committed.
 */
export const assertValidPostmortemProcess = (
  severities: readonly PostmortemSeverity[] = POSTMORTEM_SEVERITIES,
  sections: readonly PostmortemSection[] = POSTMORTEM_SECTIONS,
  checklist: readonly BlamelessChecklistItem[] = BLAMELESS_REVIEW_CHECKLIST,
  detectionSources: readonly DetectionSource[] = DETECTION_SOURCES,
  metadataFields: readonly PostmortemMetadataField[] = POSTMORTEM_METADATA_FIELDS,
): void => {
  const findings = validatePostmortemProcess(
    severities,
    sections,
    checklist,
    detectionSources,
    metadataFields,
  );
  if (findings.length > 0) {
    throw new Error(
      'The postmortem process is invalid:\n' +
        findings.map((f) => `  [${f.rule}] ${f.subject}: ${f.message}`).join('\n') +
        `\nSee ${POSTMORTEM_DOC_PATH}.`,
    );
  }
};
