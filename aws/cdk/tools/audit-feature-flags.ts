#!/usr/bin/env node
/**
 * Audit the feature flag manifest.
 *
 * A feature flag is a branch in production that someone promised to delete. The
 * promise is the whole bargain: flags are cheap to add and each one doubles the
 * number of code paths that exist at runtime, so a codebase that adds them
 * faster than it removes them ends up in a state no test suite covers and no
 * engineer can reason about. Nothing about the promise is self-enforcing —
 * `if (flags.newDashboard)` works exactly as well eighteen months after the
 * rollout finished — so the deadline has to live somewhere a machine can read.
 *
 * It lives in the manifest, next to the flag. Every flag declares who owns it,
 * why it exists, where its removal is tracked, and the date by which it should
 * be gone; this script checks that those declarations are present, internally
 * consistent, and not quietly infinite.
 *
 * The manifest is also the deployed artifact — `AppConfigStack` bootstraps the
 * hosted configuration from this file and attaches {@link
 * FEATURE_FLAG_MANIFEST_SCHEMA} to the configuration profile as a JSON Schema
 * validator, so AppConfig rejects a malformed version at
 * `CreateHostedConfigurationVersion` rather than shipping it. That covers
 * structure. It cannot cover the rules below that relate two fields to each
 * other, or a field to the calendar, which is what this script is for.
 *
 * The rules, and the failure each one prevents:
 *
 *   unsupported-version     a manifest in a format the readers do not parse
 *   invalid-flags           `flags` missing or not an object
 *   invalid-key             a key that is not a valid identifier — flags are
 *                           read as `flags.someName` in application code
 *   unknown-field           a typo'd field, which is silently ignored at
 *                           runtime and therefore never noticed
 *   missing-field           a required declaration absent
 *   invalid-type            a field of the wrong JSON type
 *   invalid-kind            a kind outside the vocabulary
 *   invalid-date            a date that is not an ISO `YYYY-MM-DD` calendar day
 *   missing-expiry          a temporary flag with no removal date, which is a
 *                           permanent flag that nobody decided to make permanent
 *   expiry-on-permanent     an expiry on a kill switch, which will never be met
 *   expiry-before-creation  a deadline that had already passed when it was set
 *   expiry-horizon          a deadline so far out it is not a plan
 *   missing-ticket          no record of where the removal work is tracked
 *   value-on-temporary      a payload on a flag that is going to be deleted
 *   rollout-out-of-range    a percentage that is not one
 *   rollout-on-disabled     a rollout percentage on a flag that is off, which
 *                           reads as a partial rollout and reaches nobody
 *   enabled-at-zero-rollout a flag that reads as on and reaches nobody
 *   expired                 past its own deadline (only when `now` is supplied)
 *
 * On the calendar rules: `expired` is reported only when a clock is passed in,
 * and the repository's CI gate does not pass one. A flag's deadline has nothing
 * to do with whether an unrelated pull request is correct, and a gate that turns
 * every build in the repository red on a date somebody else chose is a gate
 * teams learn to bypass. The deadline is enforced where it belongs — at deploy
 * time (`workflow-templates/deploy-feature-flags.yml` refuses to ship an expired
 * flag) and continuously by the sweep in `FeatureFlagLifecycleStack`, which
 * reads what is actually live and raises it with the flag's owner.
 * `expiry-horizon` is the time-independent half of the same rule, and is what
 * stops a deadline being set far enough out to never arrive.
 *
 * Usage:
 *   npm run audit:flags                                    # aws/appconfig
 *   npx ts-node tools/audit-feature-flags.ts <dir>
 *   npx ts-node tools/audit-feature-flags.ts <dir> --now            # today
 *   npx ts-node tools/audit-feature-flags.ts <dir> --now=2026-09-01
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Where feature flag manifests live, relative to the repository root. */
export const DEFAULT_MANIFEST_DIR = path.posix.join('aws', 'appconfig');

/** Manifests are matched by name so a schema or a README in the same directory is not read as one. */
export const MANIFEST_FILE_PATTERN = /^feature-flags(\..+)?\.json$/;

/** The only manifest version the readers in this repository parse. */
export const MANIFEST_VERSION = '1';

/**
 * Longest a temporary flag may be scheduled to live, in days.
 *
 * Ninety days is not a law of nature; it is long enough for a rollout that has
 * to wait on a quarterly client release and short enough that the date is still
 * a date somebody expects to be around for. The point of a bound is that
 * `expiresOn` cannot be set to a year out and mean nothing.
 */
export const DEFAULT_MAX_LIFETIME_DAYS = 90;

export type FlagKind = 'release' | 'experiment' | 'operational';

export const FLAG_KINDS: readonly FlagKind[] = ['release', 'experiment', 'operational'];

/**
 * Kinds that describe work in progress and therefore end.
 *
 * `operational` is the exception: a kill switch, a rate limit, a circuit
 * breaker. Those are not unfinished work, they are controls, and asking for
 * their removal date is asking the wrong question — so they carry no expiry and
 * are the only kind allowed to carry a `value`.
 */
export const TEMPORARY_KINDS: readonly FlagKind[] = ['release', 'experiment'];

export type FindingRule =
  | 'unsupported-version'
  | 'invalid-flags'
  | 'invalid-key'
  | 'unknown-field'
  | 'missing-field'
  | 'invalid-type'
  | 'invalid-kind'
  | 'invalid-date'
  | 'missing-expiry'
  | 'expiry-on-permanent'
  | 'expiry-before-creation'
  | 'expiry-horizon'
  | 'missing-ticket'
  | 'value-on-temporary'
  | 'rollout-out-of-range'
  | 'rollout-on-disabled'
  | 'enabled-at-zero-rollout'
  | 'expired';

export interface Finding {
  readonly rule: FindingRule;
  /** Dotted path into the manifest, as the reader would search for it. */
  readonly path: string;
  readonly message: string;
}

export interface AuditOptions {
  /**
   * Clock for the calendar rules. Omit to run the time-independent rules only —
   * see the note on `expired` in the module comment.
   */
  readonly now?: Date;
  readonly maxLifetimeDays?: number;
}

/** Fields every flag declares, and the JSON type each one must have. */
const FIELD_TYPES = {
  description: 'string',
  kind: 'string',
  owner: 'string',
  ticket: 'string',
  createdOn: 'string',
  expiresOn: 'string',
  enabled: 'boolean',
  rolloutPercentage: 'number',
  value: 'any',
} as const;

type FieldName = keyof typeof FIELD_TYPES;

const REQUIRED_FIELDS: readonly FieldName[] = [
  'description',
  'kind',
  'owner',
  'createdOn',
  'enabled',
];

/**
 * Flag keys are read as `flags.newDashboard` in application code and appear in
 * dashboards and metric dimensions, so they are constrained to the intersection
 * of what every consumer can express: a lower-camelCase identifier.
 */
const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * JSON Schema for the manifest, attached to the AppConfig configuration profile
 * as a validator so the service rejects a bad version instead of deploying it.
 *
 * It covers structure — required fields, types, ranges, the kind vocabulary,
 * `additionalProperties: false` so a typo is a rejection rather than a silent
 * no-op. It deliberately does not attempt the cross-field rules (a temporary
 * flag needing an expiry, an expiry needing to follow its creation date): JSON
 * Schema can express some of them and the resulting document is unreadable,
 * and none of it can express the calendar. Those live in {@link
 * auditFeatureFlags}, which runs before anything reaches AWS.
 */
export const FEATURE_FLAG_MANIFEST_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Feature flag manifest',
  type: 'object',
  required: ['version', 'flags'],
  additionalProperties: false,
  properties: {
    version: { type: 'string', enum: [MANIFEST_VERSION] },
    flags: {
      type: 'object',
      propertyNames: { pattern: KEY_PATTERN.source },
      additionalProperties: {
        type: 'object',
        required: [...REQUIRED_FIELDS],
        additionalProperties: false,
        properties: {
          description: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: [...FLAG_KINDS] },
          owner: { type: 'string', minLength: 1 },
          ticket: { type: 'string', minLength: 1 },
          createdOn: { type: 'string', pattern: ISO_DATE_PATTERN.source },
          expiresOn: { type: 'string', pattern: ISO_DATE_PATTERN.source },
          enabled: { type: 'boolean' },
          rolloutPercentage: { type: 'integer', minimum: 0, maximum: 100 },
          value: {},
        },
      },
    },
  },
} as const;

export interface Manifest {
  readonly version: string;
  readonly flags: Record<string, Record<string, unknown>>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parse an ISO calendar day at UTC midnight, rejecting anything that is not a
 * real day. `Date.parse` accepts `2026-02-30` and rolls it into March, which
 * would turn a typo'd deadline into a silently different deadline.
 */
export const parseIsoDate = (value: string): Date | undefined => {
  if (!ISO_DATE_PATTERN.test(value)) return undefined;

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (parsed.toISOString().slice(0, 10) !== value) return undefined;

  return parsed;
};

const daysBetween = (from: Date, to: Date): number =>
  Math.round((to.getTime() - from.getTime()) / DAY_MS);

/**
 * The UTC calendar day `instant` falls on, at midnight.
 *
 * Expiry is a date, not a moment: a flag due on the 15th is due at the end of
 * the 15th, and comparing a timestamp against midnight would call it overdue
 * for the twenty-four hours it still has.
 */
export const startOfUtcDay = (instant: Date): Date =>
  new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));

/** Structural checks on one flag. Returns the fields that survived, for the rules that follow. */
const fieldFindings = (key: string, flag: Record<string, unknown>): Finding[] => {
  const findings: Finding[] = [];
  const at = (field?: string) => `flags.${key}${field ? `.${field}` : ''}`;

  for (const field of Object.keys(flag)) {
    if (!(field in FIELD_TYPES)) {
      findings.push({
        rule: 'unknown-field',
        path: at(field),
        message:
          `\`${field}\` is not a field of a flag declaration. Nothing reads it, so whatever it ` +
          `was meant to control is not being controlled. Known fields: ` +
          `${Object.keys(FIELD_TYPES).join(', ')}.`,
      });
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (flag[field] === undefined) {
      findings.push({
        rule: 'missing-field',
        path: at(field),
        message:
          `\`${field}\` is required. A flag without it cannot be traced back to a person, a ` +
          'reason, or a plan, which is the state every abandoned flag is already in.',
      });
    }
  }

  for (const [field, expected] of Object.entries(FIELD_TYPES) as [FieldName, string][]) {
    const value = flag[field];
    if (value === undefined || expected === 'any') continue;

    const actual = Array.isArray(value) ? 'array' : typeof value;
    if (actual !== expected) {
      findings.push({
        rule: 'invalid-type',
        path: at(field),
        message: `\`${field}\` must be a ${expected}; found ${actual} (${JSON.stringify(value)}).`,
      });
      continue;
    }

    if (expected === 'string' && (value as string).trim() === '') {
      findings.push({
        rule: 'invalid-type',
        path: at(field),
        message: `\`${field}\` is empty. An empty declaration is the same as an absent one.`,
      });
    }
  }

  return findings;
};

/** The kind, and the rules that follow from it: expiry, ticket, and payload. */
const kindFindings = (key: string, flag: Record<string, unknown>): Finding[] => {
  const findings: Finding[] = [];
  const at = (field?: string) => `flags.${key}${field ? `.${field}` : ''}`;
  const kind = flag.kind;

  if (typeof kind !== 'string') return findings;

  if (!FLAG_KINDS.includes(kind as FlagKind)) {
    findings.push({
      rule: 'invalid-kind',
      path: at('kind'),
      message:
        `\`${kind}\` is not a flag kind. Use one of ${FLAG_KINDS.join(', ')} — the kind decides ` +
        'whether the flag is expected to be removed, and everything else follows from that.',
    });
    return findings;
  }

  const temporary = TEMPORARY_KINDS.includes(kind as FlagKind);

  if (temporary && flag.expiresOn === undefined) {
    findings.push({
      rule: 'missing-expiry',
      path: at('expiresOn'),
      message:
        `A ${kind} flag is unfinished work and needs a date by which it is finished. Without ` +
        'one it is a permanent flag that nobody decided to make permanent — if it genuinely is ' +
        'a control rather than a rollout, declare `kind: "operational"` and say so.',
    });
  }

  if (!temporary && flag.expiresOn !== undefined) {
    findings.push({
      rule: 'expiry-on-permanent',
      path: at('expiresOn'),
      message:
        'An operational flag is a control — a kill switch, a limit, a breaker — and is not ' +
        'scheduled for removal. This deadline will pass and be renewed forever, which teaches ' +
        'everyone reading the manifest that deadlines here are decoration.',
    });
  }

  if (temporary && flag.ticket === undefined) {
    findings.push({
      rule: 'missing-ticket',
      path: at('ticket'),
      message:
        `A ${kind} flag needs a \`ticket\` recording where its removal is tracked. The removal ` +
        'is work — deleting the branch, the flag, and the dead side of the conditional — and ' +
        'work that is not in a backlog does not happen.',
    });
  }

  if (temporary && flag.value !== undefined) {
    findings.push({
      rule: 'value-on-temporary',
      path: at('value'),
      message:
        `\`value\` carries configuration, and a ${kind} flag is going to be deleted. Anything ` +
        'read from here disappears with it. Configuration that outlives the rollout belongs in ' +
        'Parameter Store, or in an `operational` flag.',
    });
  }

  return findings;
};

/** Dates: that they are real, ordered, and bounded. */
const dateFindings = (
  key: string,
  flag: Record<string, unknown>,
  options: AuditOptions,
): Finding[] => {
  const findings: Finding[] = [];
  const at = (field: string) => `flags.${key}.${field}`;
  const maxLifetimeDays = options.maxLifetimeDays ?? DEFAULT_MAX_LIFETIME_DAYS;

  const dates: Partial<Record<'createdOn' | 'expiresOn', Date>> = {};

  for (const field of ['createdOn', 'expiresOn'] as const) {
    const raw = flag[field];
    if (typeof raw !== 'string') continue;

    const parsed = parseIsoDate(raw);
    if (parsed === undefined) {
      findings.push({
        rule: 'invalid-date',
        path: at(field),
        message:
          `\`${raw}\` is not an ISO calendar day (YYYY-MM-DD). Note that a date like 2026-02-30 ` +
          'is rejected here rather than rolled forward into March, because a deadline that ' +
          'quietly moves is worse than one that fails to parse.',
      });
      continue;
    }
    dates[field] = parsed;
  }

  const { createdOn, expiresOn } = dates;
  if (expiresOn === undefined) return findings;

  if (createdOn !== undefined) {
    if (expiresOn.getTime() <= createdOn.getTime()) {
      findings.push({
        rule: 'expiry-before-creation',
        path: at('expiresOn'),
        message:
          `The flag expires on ${expiresOn.toISOString().slice(0, 10)}, on or before the ` +
          `${createdOn.toISOString().slice(0, 10)} it was created. The deadline had passed ` +
          'before the rollout began.',
      });
    } else {
      const lifetime = daysBetween(createdOn, expiresOn);
      if (lifetime > maxLifetimeDays) {
        findings.push({
          rule: 'expiry-horizon',
          path: at('expiresOn'),
          message:
            `The flag is scheduled to live ${lifetime} days, over the ${maxLifetimeDays}-day ` +
            'limit. A deadline that far out is not a plan — nobody involved in setting it ' +
            'expects to be the one who meets it. Split the rollout or shorten the window.',
        });
      }
    }
  }

  if (options.now !== undefined && startOfUtcDay(options.now).getTime() > expiresOn.getTime()) {
    findings.push({
      rule: 'expired',
      path: at('expiresOn'),
      message:
        `The flag was due for removal on ${expiresOn.toISOString().slice(0, 10)} and is still ` +
        'here. Every code path it guards is still live and still untested in combination with ' +
        'every other flag in this state.',
    });
  }

  return findings;
};

/** Whether the declared rollout state means anything at runtime. */
const rolloutFindings = (key: string, flag: Record<string, unknown>): Finding[] => {
  const findings: Finding[] = [];
  const at = (field: string) => `flags.${key}.${field}`;
  const rollout = flag.rolloutPercentage;
  const enabled = flag.enabled;

  if (typeof rollout !== 'number') return findings;

  if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) {
    findings.push({
      rule: 'rollout-out-of-range',
      path: at('rolloutPercentage'),
      message:
        `\`${rollout}\` is not a whole percentage between 0 and 100. Bucketing is done against ` +
        'this number directly (see `lib/feature-flag-bucketing.ts`), so a value outside the ' +
        'range silently rounds to always-on or always-off.',
    });
    return findings;
  }

  if (enabled === false && rollout > 0) {
    findings.push({
      rule: 'rollout-on-disabled',
      path: at('rolloutPercentage'),
      message:
        `The flag is off, so its ${rollout}% rollout reaches nobody. Read at a glance this ` +
        'looks like a rollout in progress, which is the one state it is not in.',
    });
  }

  if (enabled === true && rollout === 0) {
    findings.push({
      rule: 'enabled-at-zero-rollout',
      path: at('rolloutPercentage'),
      message:
        'The flag is on at 0%, so it reads as enabled everywhere it is listed and reaches ' +
        'nobody. Set `enabled: false` while it is off, and raise the percentage to turn it on.',
    });
  }

  return findings;
};

/** Audit one parsed manifest. Findings are ordered by flag, then by rule. */
export const auditFeatureFlags = (manifest: unknown, options: AuditOptions = {}): Finding[] => {
  if (!isObject(manifest)) {
    return [
      {
        rule: 'invalid-flags',
        path: '',
        message: 'The manifest must be a JSON object.',
      },
    ];
  }

  const findings: Finding[] = [];

  if (manifest.version !== MANIFEST_VERSION) {
    findings.push({
      rule: 'unsupported-version',
      path: 'version',
      message:
        `\`version\` must be "${MANIFEST_VERSION}"; found ${JSON.stringify(manifest.version)}. ` +
        'The version is what lets a reader refuse a manifest it does not understand rather ' +
        'than reading a flag as absent, which is indistinguishable from off.',
    });
  }

  if (!isObject(manifest.flags)) {
    findings.push({
      rule: 'invalid-flags',
      path: 'flags',
      message: '`flags` must be an object mapping flag keys to declarations.',
    });
    return findings;
  }

  for (const [key, flag] of Object.entries(manifest.flags)) {
    if (!KEY_PATTERN.test(key)) {
      findings.push({
        rule: 'invalid-key',
        path: `flags.${key}`,
        message:
          `\`${key}\` is not a lower-camelCase identifier. Flags are read as \`flags.${key}\` ` +
          'in application code and used as CloudWatch metric dimensions, and neither can ' +
          'express every string.',
      });
    }

    if (!isObject(flag)) {
      findings.push({
        rule: 'invalid-type',
        path: `flags.${key}`,
        message: `A flag declaration must be an object; found ${JSON.stringify(flag)}.`,
      });
      continue;
    }

    findings.push(
      ...fieldFindings(key, flag),
      ...kindFindings(key, flag),
      ...dateFindings(key, flag, options),
      ...rolloutFindings(key, flag),
    );
  }

  return findings;
};

export const formatFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.path || '<root>'}  [${f.rule}]\n    ${f.message}`).join('\n\n');

export interface ManifestFile {
  /** Repository-relative path, POSIX separators. */
  readonly file: string;
  readonly manifest: unknown;
}

/** Read every feature flag manifest in `directory`, relative to `root`. */
export const readManifests = (root: string, directory: string): ManifestFile[] => {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];

  return fs
    .readdirSync(absolute)
    .filter((name) => MANIFEST_FILE_PATTERN.test(name))
    .sort()
    .map((name) => ({
      file: path.posix.join(directory.split(path.sep).join('/'), name),
      manifest: JSON.parse(fs.readFileSync(path.join(absolute, name), 'utf8')) as unknown,
    }));
};

/** Parse `--now` / `--now=YYYY-MM-DD`. Returns undefined when the flag is absent. */
export const parseNowArgument = (argv: readonly string[]): Date | undefined => {
  const argument = argv.find((value) => value === '--now' || value.startsWith('--now='));
  if (argument === undefined) return undefined;

  if (argument === '--now') return new Date();

  const value = argument.slice('--now='.length);
  const parsed = parseIsoDate(value);
  if (parsed === undefined) {
    throw new Error(`--now expects an ISO calendar day (YYYY-MM-DD); got '${value}'.`);
  }
  return parsed;
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..', '..');
  const directory = process.argv.slice(2).find((value) => !value.startsWith('--')) ?? DEFAULT_MANIFEST_DIR;
  const now = parseNowArgument(process.argv.slice(2));
  const manifests = readManifests(root, directory);

  if (manifests.length === 0) {
    console.error(`No feature flag manifest found under ${path.join(root, directory)}.`);
    process.exit(1);
  }

  const findings = manifests.flatMap(({ file, manifest }) =>
    auditFeatureFlags(manifest, { now }).map((finding) => ({
      ...finding,
      path: `${file}:${finding.path}`,
    })),
  );

  if (findings.length > 0) {
    console.error(`\n${findings.length} feature flag violation(s):\n`);
    console.error(formatFindings(findings));
    console.error('\nSee docs/feature-flags.md.\n');
    process.exit(1);
  }

  const flagCount = manifests.reduce(
    (total, { manifest }) =>
      total + Object.keys((manifest as Manifest).flags ?? {}).length,
    0,
  );
  console.log(
    `${flagCount} flag(s) across ${manifests.length} manifest(s) in ${directory} are ` +
      `declared, owned, and bounded${now ? ' and none has passed its removal date' : ''}.`,
  );
}
