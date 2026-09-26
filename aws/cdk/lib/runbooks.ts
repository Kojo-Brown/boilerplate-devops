/**
 * The runbook catalogue: which alarm reaches which runbook, and what the first
 * step of that runbook actually runs.
 *
 * Every alarm in this repository already carries a description, and the SLO
 * alarms already carry a link — `docs/slo.md#7-responding-to-a-burn-rate-alert`.
 * That link is a document, and the first thing it tells the responder to do is
 * "open the `<env>-slo` dashboard". At 04:00 on a phone that is not a step, it
 * is a prerequisite: console access, the right account, the right region, and
 * knowing which of the nine dashboards is meant. The gap between an alert that
 * names a runbook and an alert a responder can *act* on is where the first ten
 * minutes of every incident go.
 *
 * So each entry here declares a first step that is an SSM Automation document
 * `RunbookStack` creates, and `RunbookStack`'s enricher starts it when the alarm
 * fires and puts the execution in the notification. The responder's first action
 * is reading an answer, not gathering one.
 *
 * Four things in here are easy to get wrong in a way that looks like coverage,
 * and each has a rule — in {@link validateRunbookCatalogue} where it can be
 * decided from this file, and in `tools/audit-runbooks.ts` where it needs the
 * synthesised templates:
 *
 *   1. A runbook link whose anchor no longer exists. Renaming a heading in
 *      `docs/runbooks.md` does not break the link — GitHub serves 200 and lands
 *      the reader at the top of the page, where the first thing they see is
 *      somebody else's runbook. The audit resolves every anchor against the
 *      markdown.
 *
 *   2. An alarm that matches no entry, or two. No match is an alert with no
 *      runbook, which is the state this whole item exists to end. Two matches is
 *      worse than none: the enricher takes the first, so the alert carries a
 *      runbook — a confidently wrong one.
 *
 *   3. A first step that cannot be run without input a human has to go and find.
 *      An automation whose parameters are an ARN and a target group name is a
 *      form, not a first step. Every parameter is therefore either defaulted at
 *      synth time by `RunbookStack` or listed in
 *      {@link RunbookFirstStep.alarmFilledParameters}, which is the set the
 *      enricher can fill from the notification itself — and that set is exactly
 *      {@link ALARM_FILLED_PARAMETERS}, because a composite alarm's notification
 *      carries no metric, no namespace and no dimensions.
 *
 *   4. A first step that changes something. "Restart the service" is a plausible
 *      first line in a runbook and a terrible thing to hand a responder who has
 *      been awake for ninety seconds, especially as a one-click link in a page.
 *      The first step is read-only by construction: the audit rejects a document
 *      whose API call is not a `Describe`, `Get` or `List`.
 *
 * See docs/runbooks.md.
 */

/**
 * Where the runbooks live, relative to the repository root.
 *
 * One document rather than one file per runbook: the anchors are checked against
 * it on every build, and a responder who lands on the wrong section is one
 * scroll from the right one.
 */
export const RUNBOOK_DOC_PATH = 'docs/runbooks.md';

/**
 * Base for the links that go into alerts.
 *
 * A blob URL on `main` rather than a rendered docs site: the runbook has to be
 * reachable from a phone with no VPN, and this repository has no docs site to
 * point at. A consumer who has one overrides {@link RunbookStackProps.docBaseUrl}.
 */
export const RUNBOOK_DOC_BASE_URL =
  'https://github.com/Kojo-Brown/boilerplate-devops/blob/main';

/**
 * Parameters the enricher can fill from an alarm notification.
 *
 * Deliberately one. The SNS message CloudWatch sends for a metric alarm carries
 * `Trigger.Namespace`, `Trigger.MetricName` and `Trigger.Dimensions`; the message
 * it sends for a *composite* alarm carries none of them, and ten of the
 * alarms this repository routes to a human are composite. A parameter that is
 * fillable for a metric alarm and empty for a composite one produces an
 * automation that starts, fails on a validation error nobody reads, and leaves
 * the alert looking enriched.
 */
export const ALARM_FILLED_PARAMETERS = ['AlarmName'] as const;

export type AlarmFilledParameter = (typeof ALARM_FILLED_PARAMETERS)[number];

/**
 * The one command a responder should run before they do anything else.
 *
 * `documentKey` names an SSM Automation document `RunbookStack` creates as
 * `<envName>-rb-<documentKey>`. Two runbooks may share one: "is a deployment in
 * progress and are the tasks running" is the first question for a 5xx page and
 * for a CPU page alike, and duplicating the document would mean maintaining the
 * same read twice.
 */
export interface RunbookFirstStep {
  /** Kebab-case key of the document. See {@link RunbookStack}. */
  readonly documentKey: string;
  /** What the responder learns by running it. One line, present tense. */
  readonly summary: string;
  /**
   * Parameters the enricher fills from the alarm, rather than from a default.
   *
   * Must be a subset of {@link ALARM_FILLED_PARAMETERS}. Every other parameter
   * the document declares has to carry a default, or the "executable" first step
   * is a form.
   */
  readonly alarmFilledParameters: readonly AlarmFilledParameter[];
}

export interface RunbookDefinition {
  /** Unique, stable, kebab-case. Appears in the enriched alert. */
  readonly id: string;
  /** Heading of the section in {@link RUNBOOK_DOC_PATH}. */
  readonly title: string;
  /**
   * The team that answers the page, never an individual — a runbook outlives
   * anyone's time on a rota.
   */
  readonly owner: string;
  /**
   * Anchor of that section, including the leading `#`.
   *
   * Checked against the markdown by `tools/audit-runbooks.ts`: a renamed heading
   * leaves a link that resolves, which is the failure mode worth a rule.
   */
  readonly anchor: string;
  /**
   * Alarm names this runbook answers for. `*` matches any run of characters;
   * everything else is literal.
   *
   * Patterns rather than a list of alarm names because the alarms are created in
   * twelve stacks across two environments and three regions, and a catalogue
   * that enumerated them would be a second copy of those stacks' naming.
   */
  readonly alarmNamePatterns: readonly string[];
  /** One line: what has actually happened when one of these alarms fires. */
  readonly summary: string;
  readonly firstStep: RunbookFirstStep;
}

/**
 * Every alarm in this repository that reaches a human, and the runbook it
 * reaches them with.
 *
 * Ordered roughly by how often it is expected to fire. The patterns are checked
 * against the synthesised templates on every build, so an alarm added to any
 * stack without an entry here fails the build rather than paging someone with
 * nothing attached.
 */
export const RUNBOOK_CATALOGUE: readonly RunbookDefinition[] = [
  {
    id: 'api-5xx',
    title: 'The API is returning 5xx',
    owner: 'platform-team',
    anchor: '#2-the-api-is-returning-5xx',
    alarmNamePatterns: ['*-alb-5xx-elb', '*-alb-5xx-target', '*-canary-5xx', '*-canary-latency'],
    summary:
      'Requests are failing at the load balancer, at the targets behind it, or at the canary ' +
      'target group of a deployment in progress.',
    firstStep: {
      documentKey: 'ecs-service-state',
      summary:
        'reads the ECS service: how many tasks are running against how many are wanted, and ' +
        'whether a deployment is in progress right now',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'ecs-saturation',
    title: 'ECS tasks are saturated',
    owner: 'platform-team',
    anchor: '#3-ecs-tasks-are-saturated',
    alarmNamePatterns: ['*-ecs-cpu-high', '*-ecs-memory-high'],
    summary:
      'Service-level CPU or memory utilisation is sustained above its threshold. Nothing is ' +
      'failing yet; this is the alarm that fires before the 5xx one does.',
    firstStep: {
      documentKey: 'ecs-service-state',
      summary:
        'reads the ECS service: the running and desired task counts, and whether a deployment ' +
        'changed them in the window the alarm covers',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'slo-burn-rate',
    title: 'An error budget is burning',
    owner: 'platform-team',
    anchor: '#4-an-error-budget-is-burning',
    alarmNamePatterns: [
      '*-burn-fast',
      '*-burn-medium',
      '*-burn-slow',
      '*-burn-*-long',
      '*-burn-*-short',
      '*-slo-burn-rate-fast',
      '*-slo-burn-rate-slow',
      '*-budget-low',
      '*-budget-exhausted',
      '*-availability-no-data',
    ],
    summary:
      'An objective in `lib/slo-definitions.ts` is spending its error budget faster than the ' +
      'objective affords, or has spent it.',
    firstStep: {
      documentKey: 'environment-alarm-state',
      summary:
        'lists every alarm in this environment that is currently in ALARM, which is the ' +
        'difference between one objective degrading and the platform being down',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'rds-connections',
    title: 'The database is running out of connections',
    owner: 'platform-team',
    anchor: '#5-the-database-is-running-out-of-connections',
    alarmNamePatterns: ['*-rds-connections-high'],
    summary:
      'Open connections to the PostgreSQL instance are close to the limit the instance class ' +
      'allows. The next connection attempt after the limit is an application error, not a ' +
      'slow query.',
    firstStep: {
      documentKey: 'rds-instance-state',
      summary:
        'reads the RDS instance: its class, its status, whether it is mid-failover, and ' +
        'whether a modification is pending',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'log-pipeline',
    title: 'The log pipeline is dropping or leaking records',
    owner: 'platform-team',
    anchor: '#6-the-log-pipeline-is-dropping-or-leaking-records',
    alarmNamePatterns: ['*-log-pipeline-*', '*-log-scrubber-failing'],
    summary:
      'The scrubbing pipeline in `docs/log-pipeline.md` is failing, backing up, or dropping ' +
      'records. Its failure mode is silent: delivery metrics stay healthy while unscrubbed or ' +
      'truncated records land in the archive.',
    firstStep: {
      documentKey: 'log-delivery-state',
      summary:
        'reads the Firehose delivery stream: its status, its destination, and whether a ' +
        'processor is attached to it at all',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'synthetic-canary',
    title: 'The synthetic canaries cannot reach the service',
    owner: 'platform-team',
    anchor: '#7-the-synthetic-canaries-cannot-reach-the-service',
    alarmNamePatterns: [
      '*-canary-health-*',
      '*-canary-home-*',
      '*-health-*-failed',
      '*-home-*-failed',
    ],
    summary:
      'Probes running outside the account cannot get a good response. This is the only signal ' +
      'here measured from where the user is, so it sees DNS, TLS and WAF, which nothing ' +
      'inside the account does.',
    firstStep: {
      documentKey: 'environment-alarm-state',
      summary:
        'lists every alarm in this environment that is currently in ALARM, which separates one ' +
        'unhappy region from an outage every region can see',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'waf-blocked-requests',
    title: 'The WAF is blocking an unusual number of requests',
    owner: 'security-team',
    anchor: '#8-the-waf-is-blocking-an-unusual-number-of-requests',
    alarmNamePatterns: ['*-waf-blocked-requests'],
    summary:
      'Blocked requests are above the threshold. This is the one alarm here whose healthy ' +
      'value is not zero, so the question is never "why is it blocking" but "is this more ' +
      'than yesterday, and is it one client".',
    firstStep: {
      documentKey: 'alarm-history',
      summary:
        'reads this alarm\'s own state transitions, which is what separates a spike from a ' +
        'threshold that has been wrong since the traffic pattern changed',
      alarmFilledParameters: ['AlarmName'],
    },
  },
  {
    id: 'platform-tooling',
    title: 'A platform component has stopped reporting',
    owner: 'platform-team',
    anchor: '#9-a-platform-component-has-stopped-reporting',
    alarmNamePatterns: [
      '*-slo-budget-reporter-errors',
      '*-runbook-enricher-errors',
      '*lead-time-unmeasurable',
      '*expired-feature-flags',
      '*unreadable-flag-manifest',
    ],
    summary:
      'Something that measures the platform has failed, rather than the platform itself. ' +
      'These are tickets, not pages, and each one means a signal above it is now reading ' +
      'stale data or none.',
    firstStep: {
      documentKey: 'alarm-history',
      summary:
        'reads this alarm\'s own state transitions, so the answer to "how long has this been ' +
        'broken" comes before the answer to "what broke"',
      alarmFilledParameters: ['AlarmName'],
    },
  },
];

/**
 * Alarm topics the enricher deliberately does not subscribe to.
 *
 * An exemption is not a suppression: the alarm still fires and still reaches
 * whoever is subscribed to the topic. What it loses is the runbook link and the
 * started first step, and the reason has to say why that is acceptable — the
 * audit rejects an exemption whose topic now has an enricher, so a stale one is
 * a build failure rather than a permanent hole.
 */
export interface EnrichmentExemption {
  /** Topic name, `*` wildcards allowed. */
  readonly topicNamePattern: string;
  readonly reason: string;
}

export const ENRICHMENT_EXEMPTIONS: readonly EnrichmentExemption[] = [
  {
    // `<env>-canary-<region>`: production-canary-us-east-1,
    // staging-canary-eu-west-1, production-canary-ap-southeast-1. The two
    // trailing wildcards are what distinguish a region from
    // `<env>-canary-ticket` or `<env>-canary-deployment-notifications`.
    topicNamePattern: '*-canary-*-*-?',
    reason:
      'The per-region canary topics belong to SyntheticCanaryStack, one per probing region. An ' +
      'SNS topic can only deliver to a Lambda in its own region, so enriching these needs a ' +
      'RunbookStack in every region the fleet probes from — which is a cost decision for the ' +
      'consumer, not a default. The alarms they carry are per-region tickets by design; the ' +
      'page is the quorum alarm below.',
  },
  {
    topicNamePattern: '*-canary-page',
    reason:
      'The canary quorum aggregates in `canaryAggregationRegion`, which defaults to eu-west-1 ' +
      'while RunbookStack lives in the primary region, and SNS cannot deliver to a Lambda ' +
      'outside its own region. `bin/app.ts` subscribes this topic when the two regions match, ' +
      'so the exemption covers the default configuration only. Losing enrichment here costs ' +
      'the link and the first step; the page itself is unaffected.',
  },
  {
    topicNamePattern: '*-canary-ticket',
    reason:
      'Same region constraint as `*-canary-page`: the quorum stack is deployed in ' +
      '`canaryAggregationRegion`. Subscribed automatically by `bin/app.ts` when that region is ' +
      'the primary one. These are the per-region and heartbeat tickets, which are the lower ' +
      'half of the fleet\'s signal.',
  },
];

/* ── Matching ─────────────────────────────────────────────────────────────── */

const globToRegExp = (pattern: string): RegExp =>
  new RegExp(
    `^${pattern
      .split('')
      .map((character) => {
        if (character === '*') return '.*';
        if (character === '?') return '.';
        return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('')}$`,
  );

/** Does `value` match a pattern in which `*` is any run and `?` is any one character? */
export const matchesPattern = (pattern: string, value: string): boolean =>
  globToRegExp(pattern).test(value);

/**
 * Every runbook whose patterns match this alarm name.
 *
 * Returns all of them rather than the first: two matches is a defect the audit
 * reports, and a helper that hid it would be the reason nobody noticed.
 */
export const runbooksForAlarm = (
  alarmName: string,
  catalogue: readonly RunbookDefinition[] = RUNBOOK_CATALOGUE,
): RunbookDefinition[] =>
  catalogue.filter((runbook) =>
    runbook.alarmNamePatterns.some((pattern) => matchesPattern(pattern, alarmName)),
  );

/** Is this topic exempt from enrichment, and why? */
export const exemptionForTopic = (
  topicName: string,
  exemptions: readonly EnrichmentExemption[] = ENRICHMENT_EXEMPTIONS,
): EnrichmentExemption | undefined =>
  exemptions.find((exemption) => matchesPattern(exemption.topicNamePattern, topicName));

/** The URL that goes in the alert. */
export const runbookUrl = (
  runbook: RunbookDefinition,
  baseUrl: string = RUNBOOK_DOC_BASE_URL,
): string => `${baseUrl.replace(/\/+$/, '')}/${RUNBOOK_DOC_PATH}${runbook.anchor}`;

/** `<env>-rb-<key>`: the SSM Automation document name `RunbookStack` creates. */
export const firstStepDocumentName = (envName: string, documentKey: string): string =>
  `${envName}-rb-${documentKey}`;

/** Distinct document keys the catalogue needs, in first-use order. */
export const requiredDocumentKeys = (
  catalogue: readonly RunbookDefinition[] = RUNBOOK_CATALOGUE,
): string[] => [...new Set(catalogue.map((runbook) => runbook.firstStep.documentKey))];

/* ── Validation ───────────────────────────────────────────────────────────── */

/** A rule violation in the catalogue. */
export interface RunbookFinding {
  /** Id of the offending entry, or `<catalogue>` for a cross-entry rule. */
  readonly runbookId: string;
  /** Stable rule name, for discussion and docs. */
  readonly rule: string;
  readonly message: string;
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ANCHOR = /^#[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Every rule that can be decided from this file alone.
 *
 * The rules that need the markdown, the synthesised documents or the real alarm
 * names live in `tools/audit-runbooks.ts`, because they need something this file
 * cannot see. Findings rather than throws, so a catalogue with three problems
 * reports three.
 */
export const validateRunbookCatalogue = (
  catalogue: readonly RunbookDefinition[] = RUNBOOK_CATALOGUE,
  exemptions: readonly EnrichmentExemption[] = ENRICHMENT_EXEMPTIONS,
): RunbookFinding[] => {
  const findings: RunbookFinding[] = [];
  const report = (runbookId: string, rule: string, message: string) =>
    findings.push({ runbookId, rule, message });

  if (catalogue.length === 0) {
    report('<catalogue>', 'catalogue-empty', 'the catalogue has no runbooks in it.');
  }

  const seenIds = new Map<string, number>();
  const seenAnchors = new Map<string, string[]>();
  const seenPatterns = new Map<string, string[]>();

  for (const runbook of catalogue) {
    seenIds.set(runbook.id, (seenIds.get(runbook.id) ?? 0) + 1);
    seenAnchors.set(runbook.anchor, [...(seenAnchors.get(runbook.anchor) ?? []), runbook.id]);

    if (!KEBAB_CASE.test(runbook.id)) {
      report(
        runbook.id,
        'id-not-kebab-case',
        `id '${runbook.id}' must be lower-case kebab-case: it is quoted in the alert and used ` +
          'to correlate one across notifications.',
      );
    }

    if (!runbook.title.trim()) {
      report(runbook.id, 'title-missing', 'title is required: it is the heading of the section.');
    }
    if (!runbook.summary.trim()) {
      report(
        runbook.id,
        'summary-missing',
        'summary is required: it is the line the alert leads with, and an alert whose first ' +
          'line is an alarm name has told the responder nothing they did not already know.',
      );
    }

    if (!runbook.owner) {
      report(runbook.id, 'owner-missing', 'owner is required: a runbook with no owner is nobody\'s to keep true.');
    } else if (runbook.owner.includes('@')) {
      report(
        runbook.id,
        'owner-is-an-individual',
        `owner '${runbook.owner}' looks like a person. A runbook outlives anyone's time on a ` +
          'rota; name the team.',
      );
    }

    if (!ANCHOR.test(runbook.anchor)) {
      report(
        runbook.id,
        'anchor-malformed',
        `anchor '${runbook.anchor}' must be '#' followed by the lower-case kebab-case slug ` +
          'GitHub generates from the heading.',
      );
    }

    if (runbook.alarmNamePatterns.length === 0) {
      report(
        runbook.id,
        'no-alarm-patterns',
        'alarmNamePatterns is empty, so no alarm can ever reach this runbook. It is ' +
          'documentation, and the coverage rules will report the alarms it was written for as ' +
          'uncovered.',
      );
    }

    for (const pattern of runbook.alarmNamePatterns) {
      seenPatterns.set(pattern, [...(seenPatterns.get(pattern) ?? []), runbook.id]);

      if (pattern.trim() !== pattern || pattern === '') {
        report(
          runbook.id,
          'alarm-pattern-malformed',
          `pattern '${pattern}' is empty or padded with whitespace; alarm names are not.`,
        );
      }
      if (/^\*+$/.test(pattern)) {
        report(
          runbook.id,
          'alarm-pattern-catch-all',
          `pattern '${pattern}' matches every alarm in the account. Every coverage rule then ` +
            'passes and every alert carries the same runbook, which is the appearance of ' +
            'coverage and none of it.',
        );
      }
    }

    const step = runbook.firstStep;
    if (!KEBAB_CASE.test(step.documentKey)) {
      report(
        runbook.id,
        'document-key-not-kebab-case',
        `firstStep.documentKey '${step.documentKey}' must be lower-case kebab-case: it becomes ` +
          'part of an SSM document name.',
      );
    }
    if (!step.summary.trim()) {
      report(
        runbook.id,
        'first-step-summary-missing',
        'firstStep.summary is required: the alert says what the automation it started was for, ' +
          'and an execution id with no sentence beside it is not an answer.',
      );
    }
    for (const parameter of step.alarmFilledParameters) {
      if (!(ALARM_FILLED_PARAMETERS as readonly string[]).includes(parameter)) {
        report(
          runbook.id,
          'alarm-filled-parameter-unknown',
          `firstStep.alarmFilledParameters names '${parameter}', which the enricher cannot read ` +
            `from an alarm notification. It knows ${ALARM_FILLED_PARAMETERS.join(', ')} and ` +
            'nothing else, because a composite alarm notification carries no metric.',
        );
      }
    }
    if (new Set(step.alarmFilledParameters).size !== step.alarmFilledParameters.length) {
      report(
        runbook.id,
        'alarm-filled-parameter-duplicated',
        'firstStep.alarmFilledParameters lists a parameter twice.',
      );
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) {
      report(
        id,
        'duplicate-id',
        `id '${id}' is defined ${count} times; the enricher resolves by first match, so the ` +
          'second entry is unreachable and reads as coverage.',
      );
    }
  }

  for (const [anchor, ids] of seenAnchors) {
    if (ids.length > 1) {
      report(
        '<catalogue>',
        'duplicate-anchor',
        `anchor '${anchor}' is claimed by ${ids.join(', ')}. Two runbooks pointing at one ` +
          'section means one of them has no section.',
      );
    }
  }

  for (const [pattern, ids] of seenPatterns) {
    if (ids.length > 1) {
      report(
        '<catalogue>',
        'duplicate-alarm-pattern',
        `pattern '${pattern}' appears in ${ids.join(' and ')}. Every alarm it matches has two ` +
          'runbooks, and the enricher will attach whichever comes first.',
      );
    }
  }

  for (const exemption of exemptions) {
    if (!exemption.topicNamePattern.trim()) {
      report(
        '<catalogue>',
        'exemption-pattern-empty',
        'an enrichment exemption has an empty topic pattern.',
      );
    }
    if (/^\*+$/.test(exemption.topicNamePattern)) {
      report(
        '<catalogue>',
        'exemption-pattern-catch-all',
        `exemption '${exemption.topicNamePattern}' exempts every topic in the account, which ` +
          'turns the topic-coverage rule off while leaving it in the build.',
      );
    }
    if (exemption.reason.trim().length < 40) {
      report(
        '<catalogue>',
        'exemption-without-reason',
        `exemption '${exemption.topicNamePattern}' has no real reason against it. An exemption ` +
          'is the one place in this gate where a hole is allowed, so the reason is the whole ' +
          'of the review.',
      );
    }
  }

  return findings;
};

/**
 * Throw on any violation. Used by `RunbookStack`.
 *
 * All of them are reported, not just the first: a bad entry usually produces
 * several, and fixing them one synth at a time is how the last one gets
 * committed.
 */
export const assertValidRunbookCatalogue = (
  catalogue: readonly RunbookDefinition[] = RUNBOOK_CATALOGUE,
  exemptions: readonly EnrichmentExemption[] = ENRICHMENT_EXEMPTIONS,
): void => {
  const findings = validateRunbookCatalogue(catalogue, exemptions);
  if (findings.length > 0) {
    throw new Error(
      'The runbook catalogue is invalid:\n' +
        findings.map((f) => `  [${f.rule}] ${f.runbookId}: ${f.message}`).join('\n') +
        '\nSee docs/runbooks.md.',
    );
  }
};
