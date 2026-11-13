#!/usr/bin/env node
/**
 * Audit the tagging policy and the dashboard that reads it.
 *
 * `validateTaggingPolicy` already holds the catalogue to arithmetic that must
 * be true of any catalogue, and `CostAllocationStack` calls it at synth. That
 * covers a catalogue which cannot generate a working document. The failures
 * worth a review gate are the ones where everything generates, attaches, and
 * deploys, and the two halves have quietly stopped describing the same
 * organization:
 *
 *   A checked-in SCP edited by hand. `policy/organizations/*.json` is what
 *   somebody copies into the management account; `lib/tagging-policy.ts` is what
 *   the dashboard, the alarms and this gate are built from. Both keep working
 *   when they disagree — the file still attaches, the catalogue still
 *   validates — and the disagreement surfaces as spend appearing in no series.
 *
 *   A tag required by one gate and not the other.
 *   `policy/cloudformation/tags.rego` holds every resource *this repository*
 *   synthesises to `ManagedBy` and `Stack`; the SCP holds everything created in
 *   the account to the same thing. A key added to one and not the other leaves a
 *   population governed by nobody, and the rego pack is the half that is easy to
 *   forget because it is a different language in a different directory.
 *
 *   An environment spelling that exists in one list only. `allowed_environments`
 *   in the rego pack and `Environment`'s `allowedValues` here are two copies of
 *   one set. Cost and access reports group on an exact string, so a fourth
 *   spelling is a fourth environment — and a value allowed by the SCP but not
 *   the rego pack deploys and then fails review, while the reverse passes review
 *   and is denied at create time.
 *
 *   A costly resource type with no create action behind it. `tags.rego` names
 *   the types that cost money, hold data, or grant access. The SCP catalogue
 *   names the actions that bring them into existence. A type in the first with
 *   no entry in the second is a gap, and a gap with a recorded reason is a
 *   decision — the two are indistinguishable unless the reason is required.
 *
 *   A dashboard nobody wired. `CostAllocationStack` is where every metric behind
 *   the untagged share is published. Not instantiating it leaves a catalogue, an
 *   SCP, two policy files and no measurement of whether any of it worked.
 *
 * The rules:
 *
 *   (every rule in validateTaggingPolicy)  see lib/tagging-policy.ts
 *   policy-file-missing        a generated document that is not checked in
 *   policy-file-drift          a checked-in document the catalogue no longer generates
 *   rego-required-tag-missing  a key tags.rego requires that the SCP does not
 *   scp-required-tag-missing   a key the SCP requires that tags.rego does not
 *   environment-values-drift   the two copies of the environment set disagree
 *   resource-type-uncovered    a governed type no catalogued action creates
 *   dashboard-not-wired        no CostAllocationStack in bin/app.ts
 *   tag-key-undocumented       a governed key docs/cost-allocation.md never names
 *   activation-undocumented    activation not explained where a reader will look
 *
 * See docs/cost-allocation.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  GOVERNED_TAGS,
  type GovernedTag,
  type ScpAction,
  SCP_ACTION_CATALOGUE,
  type TaggingFinding,
  buildOrganizationsTagPolicy,
  buildTagEnforcementScp,
  costAllocationTagKeys,
  requiredTagKeys,
  serialisePolicy,
  validateTaggingPolicy,
} from '../lib/tagging-policy';

/** Construct whose instantiation means the dashboard exists. */
const COST_ALLOCATION_STACK_CLASS = 'CostAllocationStack';

/** Repository-relative paths of the two generated documents. */
export const SCP_PATH = 'policy/organizations/tag-enforcement-scp.json';
export const TAG_POLICY_PATH = 'policy/organizations/cost-allocation-tag-policy.json';

/** Rego file holding the other copy of the required-tag set. */
export const REGO_TAGS_PATH = 'policy/cloudformation/tags.rego';

/**
 * The members of a Rego set literal, e.g. `required_tag_keys := {"A", "B"}`.
 *
 * Returns `undefined` when the assignment is absent, which is reported as a
 * finding rather than treated as an empty set: a renamed rule and a rule
 * governing nothing are different problems, and only one of them is a drift.
 *
 * The body is matched up to the closing brace rather than line by line, because
 * `governed_tag_types` spans twenty lines and carries a comment above every
 * one of them.
 */
export const regoSetMembers = (source: string, name: string): string[] | undefined => {
  const start = new RegExp(`^\\s*${name}\\s*:=\\s*\\{`, 'm').exec(source);
  if (start === null) return undefined;

  const from = start.index + start[0].length;
  const end = source.indexOf('}', from);
  if (end === -1) return undefined;

  return [...source.slice(from, end).matchAll(/"([^"]*)"/g)].map((match) => match[1]);
};

/**
 * Strip comments so a commented-out stack does not read as a wired one.
 *
 * Quote-aware: a `//` inside a URL would otherwise swallow the rest of the
 * line, and `bin/app.ts` is full of console links.
 */
export const stripComments = (source: string): string => {
  let out = '';
  let index = 0;
  let quote: string | undefined;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = undefined;
      index += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      out += char;
      index += 1;
      continue;
    }

    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    if (char === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        // Newlines preserved so line numbers still line up with the file.
        if (source[index] === '\n') out += '\n';
        index += 1;
      }
      index += 2;
      continue;
    }

    out += char;
    index += 1;
  }

  return out;
};

/** How many times `new <className>(` appears outside a comment or a string. */
export const constructorCount = (source: string, className: string): number =>
  stripComments(source).split(`new ${className}(`).length - 1;

export interface AuditInputs {
  readonly tags: readonly GovernedTag[];
  readonly actions: readonly ScpAction[];
  /** Checked-in document contents, or `undefined` when the file is absent. */
  readonly scpFile?: string;
  readonly tagPolicyFile?: string;
  /** Contents of `policy/cloudformation/tags.rego`. */
  readonly regoSource: string;
  /** Contents of `bin/app.ts`. */
  readonly appSource: string;
  /** Contents of `docs/cost-allocation.md`. */
  readonly docsSource: string;
}

export const auditTaggingPolicy = (inputs: AuditInputs): TaggingFinding[] => {
  const { tags, actions, regoSource, appSource, docsSource } = inputs;
  const findings: TaggingFinding[] = [...validateTaggingPolicy(tags, actions)];
  const report = (subject: string, rule: string, message: string) =>
    findings.push({ subject, rule, message });

  // ── The generated documents ────────────────────────────────────────────────

  const generated: readonly [string, string | undefined, string][] = [
    [SCP_PATH, inputs.scpFile, serialisePolicy(buildTagEnforcementScp(tags, actions))],
    [TAG_POLICY_PATH, inputs.tagPolicyFile, serialisePolicy(buildOrganizationsTagPolicy(tags))],
  ];

  for (const [file, current, expected] of generated) {
    if (current === undefined) {
      report(
        file,
        'policy-file-missing',
        `${file} does not exist. Nothing in this repository attaches these documents — the ` +
          'file is the artefact somebody copies into the management account, so a catalogue ' +
          'with no file is a policy nobody can apply. Run `npm run policy:organizations`.',
      );
      continue;
    }
    if (current !== expected) {
      report(
        file,
        'policy-file-drift',
        `${file} is not what lib/tagging-policy.ts generates. Both halves keep working when ` +
          'they disagree: the file still attaches and the catalogue still validates, and the ' +
          'disagreement surfaces months later as spend that appears in no series on the ' +
          'dashboard. Run `npm run policy:organizations` and commit the result.',
      );
    }
  }

  // ── The rego pack, which governs a different population ────────────────────

  const regoRequired = regoSetMembers(regoSource, 'required_tag_keys');
  const regoEnvironments = regoSetMembers(regoSource, 'allowed_environments');
  const regoTypes = regoSetMembers(regoSource, 'governed_tag_types');
  const scpRequired = requiredTagKeys(tags);

  if (regoRequired === undefined) {
    report(
      REGO_TAGS_PATH,
      'rego-required-tag-missing',
      `${REGO_TAGS_PATH} declares no required_tag_keys set this gate can read. Either the rule ` +
        'was renamed or the pack no longer requires anything, and the second reads exactly ' +
        'like the first from here.',
    );
  } else {
    for (const key of regoRequired) {
      if (!scpRequired.includes(key)) {
        report(
          key,
          'rego-required-tag-missing',
          `${REGO_TAGS_PATH} requires '${key}' on every resource this repository synthesises, ` +
            'and the SCP does not require it on anything. The population the SCP governs — the ' +
            'console, another pipeline, everything that already existed — is the population a ' +
            "cost report is made of, and it is exactly the one this key is missing from.",
        );
      }
    }
    for (const key of scpRequired) {
      if (!regoRequired.includes(key)) {
        report(
          key,
          'scp-required-tag-missing',
          `The SCP denies creating a resource without '${key}' and ${REGO_TAGS_PATH} does not ` +
            'require it. A stack in this repository can therefore pass review and be denied at ' +
            'deploy time, which is the slowest possible place to find out.',
        );
      }
    }
  }

  const environmentTag = tags.find((tag) => tag.key === 'Environment');
  if (regoEnvironments !== undefined && environmentTag?.allowedValues !== undefined) {
    const here = [...environmentTag.allowedValues].sort();
    const there = [...regoEnvironments].sort();
    if (here.join(',') !== there.join(',')) {
      report(
        'Environment',
        'environment-values-drift',
        `Environment values disagree: the catalogue allows ${here.join(', ')} and ` +
          `${REGO_TAGS_PATH} allows ${there.join(', ')}. These are two copies of one set, and ` +
          'both reports group on an exact string match — a value in one list only is either ' +
          'denied at create time after passing review, or accepted at create time and reported ' +
          'as a fourth environment.',
      );
    }
  }

  if (regoTypes !== undefined) {
    const covered = new Set(actions.flatMap((entry) => entry.resourceTypes));
    for (const type of regoTypes) {
      if (!covered.has(type)) {
        report(
          type,
          'resource-type-uncovered',
          `${REGO_TAGS_PATH} governs '${type}' and SCP_ACTION_CATALOGUE names no action that ` +
            'creates one. Add the create action, or add it with coverage ' +
            "'no-tag-on-create' and the reason — a type nobody listed and a type deliberately " +
            'left unenforceable look identical in a catalogue.',
        );
      }
    }
  }

  // ── The measurement ────────────────────────────────────────────────────────

  if (constructorCount(appSource, COST_ALLOCATION_STACK_CLASS) === 0) {
    report(
      '<catalogue>',
      'dashboard-not-wired',
      `bin/app.ts instantiates no ${COST_ALLOCATION_STACK_CLASS}. The catalogue, the SCP and ` +
        'the tag policy would all exist with nothing measuring whether any of them worked, and ' +
        'an unmeasured tagging policy is believed rather than checked.',
    );
  }

  // ── The document a reader actually reaches for ─────────────────────────────

  for (const tag of tags) {
    if (!docsSource.includes(tag.key)) {
      report(
        tag.key,
        'tag-key-undocumented',
        `docs/cost-allocation.md never names '${tag.key}'. The catalogue records what is ` +
          'enforced; the document is where why it is enforced — and what it deliberately does ' +
          'not reach — has to be written down.',
      );
    }
  }

  for (const key of costAllocationTagKeys(tags)) {
    if (!docsSource.includes('not retroactive')) {
      report(
        key,
        'activation-undocumented',
        'docs/cost-allocation.md does not say that cost allocation tag activation is not ' +
          'retroactive. It is the single fact that makes a correct, empty widget look like a ' +
          'broken one, and the reader who needs it is looking at the dashboard, not at this ' +
          'catalogue.',
      );
      break;
    }
  }

  return findings;
};

export const formatFindings = (findings: readonly TaggingFinding[]): string =>
  findings.map((f) => `${f.subject}  [${f.rule}]\n    ${f.message}`).join('\n\n');

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const cdkRoot = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(cdkRoot, '..', '..');

  const read = (file: string): string => {
    if (!fs.existsSync(file)) {
      console.error(`Expected to find ${file}.`);
      process.exit(1);
    }
    return fs.readFileSync(file, 'utf8');
  };

  const readOptional = (file: string): string | undefined =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;

  const findings = auditTaggingPolicy({
    tags: GOVERNED_TAGS,
    actions: SCP_ACTION_CATALOGUE,
    scpFile: readOptional(path.join(repoRoot, SCP_PATH)),
    tagPolicyFile: readOptional(path.join(repoRoot, TAG_POLICY_PATH)),
    regoSource: read(path.join(repoRoot, REGO_TAGS_PATH)),
    appSource: read(path.join(cdkRoot, 'bin', 'app.ts')),
    docsSource: read(path.join(repoRoot, 'docs', 'cost-allocation.md')),
  });

  if (findings.length > 0) {
    console.error(`\n${findings.length} tagging policy violation(s):\n`);
    console.error(formatFindings(findings));
    console.error('\nSee docs/cost-allocation.md.\n');
    process.exit(1);
  }

  const enforced = requiredTagKeys().length;
  const grouped = costAllocationTagKeys().length;
  const unenforceable = SCP_ACTION_CATALOGUE.filter(
    (entry) => entry.coverage === 'no-tag-on-create',
  ).length;

  console.log(
    `${GOVERNED_TAGS.length} governed tag(s): ${enforced} denied on create, ${grouped} drawn on ` +
      `the cost-allocation dashboard. The SCP covers ` +
      `${SCP_ACTION_CATALOGUE.length - unenforceable} create action(s) and records ` +
      `${unenforceable} that cannot be enforced at create time, with reasons. Both generated ` +
      `documents match the catalogue.`,
  );
}
