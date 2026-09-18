#!/usr/bin/env node
/**
 * Audit the SLO catalogue and the wiring that makes it real.
 *
 * `SloStack` already validates every objective it is handed, and throws at synth
 * on anything malformed. That covers the objectives that reach a stack, which is
 * exactly the set this gate is least worried about. The failures worth a review
 * gate are the ones where nothing is ever synthesised:
 *
 *   An objective written down and never wired. `docs/slo.md` describes it, the
 *   catalogue holds it, a quarterly review reads it off a dashboard that does not
 *   exist, and no alarm was ever created. Nothing fails; there is simply no
 *   signal, which is indistinguishable from a signal that never fires.
 *
 *   An objective wired before its SLI exists. A `proposed` entry has no metric
 *   behind it, so its alarms would sit in INSUFFICIENT_DATA from the day they
 *   deploy — the state a dashboard tile ends up in when everyone has learned to
 *   ignore one amber square.
 *
 *   The same objective stated twice. Before the catalogue existed, `bin/app.ts`
 *   held `{ target: 0.999, windowDays: 30, minimumRequestsPerWindow: 60 }` as
 *   literals passed to the stack that rolls deployments back. Two copies of an
 *   objective do not disagree loudly: one gets tightened, the rollback keeps
 *   using the old budget, and the burn rate that mutates production is computed
 *   against a number nobody believes any more.
 *
 *   A `proposed` objective that is malformed. Those never reach `assertValidSlo`,
 *   because nothing wires them — so the only place an unreachable burn-rate
 *   policy or a single-error traffic floor on a proposed objective can be caught
 *   is here, before it is promoted to `active` months later by someone who reads
 *   the catalogue as reviewed.
 *
 * The rules:
 *
 *   (every rule in validateSloCatalogue)   see lib/slo-definitions.ts
 *   catalogue-empty          nothing defined at all
 *   unknown-slo-wired        a wired id with no catalogue entry
 *   slo-not-wired            an `active` entry no SloStack measures
 *   proposed-slo-wired       a `proposed` entry wired anyway
 *   environment-without-slo-stack  an environment with objectives and no stack
 *   rollback-without-slo     burn-rate rollback for an environment that has
 *                            declared no objective to burn against
 *   objective-literal        an objective restated in bin/app.ts instead of
 *                            taken from the catalogue
 *   slo-undocumented         an entry docs/slo.md does not mention
 *
 * See docs/slo.md.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  SLO_CATALOGUE,
  SloDefinition,
  SloFinding,
  validateSloCatalogue,
} from '../lib/slo-definitions';

/** Construct whose instantiations declare which objectives are measured. */
const SLO_STACK_CLASS = 'SloStack';
/** Construct that acts on a burn rate. It must be burning against a declared objective. */
const ROLLBACK_STACK_CLASS = 'SloBurnRateRollbackStack';

/**
 * Strip comments so a commented-out stack does not read as a wired one.
 *
 * Quote-aware, because a `//` inside a URL — and every runbook link in the
 * catalogue is one — would otherwise swallow the rest of the line. Template
 * literals are treated as quotes too: `lib/slo-stack.ts` ships a Lambda as one,
 * and while that file is not scanned here, the helper is the sort that gets
 * reused.
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
        // Newlines are preserved so line numbers in any future message still
        // line up with the file on disk.
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

/**
 * The argument text of every `new <className>(...)` in `source`.
 *
 * Balanced-paren extraction rather than a regex: the argument list spans dozens
 * of lines and contains parentheses of its own, and a regex that stops at the
 * first `)` reads only as far as the first nested call — which is where the
 * `envName` usually is, so it would appear to work.
 */
export const constructorArguments = (source: string, className: string): string[] => {
  const stripped = stripComments(source);
  const needle = `new ${className}(`;
  const blocks: string[] = [];

  let from = 0;
  for (;;) {
    const start = stripped.indexOf(needle, from);
    if (start === -1) break;

    let index = start + needle.length;
    let depth = 1;
    let quote: string | undefined;

    while (index < stripped.length && depth > 0) {
      const char = stripped[index];
      if (quote !== undefined) {
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === quote) quote = undefined;
      } else if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
      }
      index += 1;
    }

    blocks.push(stripped.slice(start + needle.length, index - 1));
    from = index;
  }

  return blocks;
};

/** One `new SloStack(...)`, as much of it as this gate reads. */
export interface WiredSloStack {
  readonly envName?: string;
  readonly sloIds: readonly string[];
}

const stringProperty = (block: string, name: string): string | undefined => {
  const match = new RegExp(`\\b${name}\\s*:\\s*'([^']*)'`).exec(block);
  return match?.[1];
};

const stringProperties = (block: string, name: string): string[] => {
  const pattern = new RegExp(`\\b${name}\\s*:\\s*'([^']*)'`, 'g');
  return [...block.matchAll(pattern)].map((match) => match[1]);
};

/** Every objective wired into an `SloStack` in `appSource`. */
export const wiredSloStacks = (appSource: string): WiredSloStack[] =>
  constructorArguments(appSource, SLO_STACK_CLASS).map((block) => ({
    envName: stringProperty(block, 'envName'),
    sloIds: stringProperties(block, 'sloId'),
  }));

/**
 * Environments that instantiate the burn-rate rollback stack.
 *
 * That stack takes an `envName` prop with a default, so the prop is read when
 * present and the construct id — `SloBurnRateRollbackStack-Production` — is the
 * fallback, lower-cased. Reading only the prop would silently find nothing in a
 * repository that relies on the default.
 */
export const rollbackEnvironments = (appSource: string): string[] =>
  constructorArguments(appSource, ROLLBACK_STACK_CLASS).map((block) => {
    const fromProp = stringProperty(block, 'envName');
    if (fromProp !== undefined) return fromProp;
    const id = /,\s*'([^']+)'/.exec(block);
    const suffix = id?.[1].split('-').slice(1).join('-');
    return (suffix ?? 'production').toLowerCase();
  });

/**
 * A numeric objective written into `bin/app.ts` rather than read from the
 * catalogue.
 *
 * Matches `target:` followed by a number, which is the shape
 * `SloBurnRateRollbackStack`'s `slo` prop takes. `target: someSlo.objective` is a
 * property access, not a number, and is what this rule is asking for.
 */
export const objectiveLiterals = (appSource: string): string[] =>
  [...stripComments(appSource).matchAll(/\btarget\s*:\s*(\d+(?:\.\d+)?)/g)].map((m) => m[1]);

export interface AuditInputs {
  readonly catalogue: readonly SloDefinition[];
  /** Contents of `bin/app.ts`. */
  readonly appSource: string;
  /** Contents of `docs/slo.md`. */
  readonly docsSource: string;
}

export const auditSloDefinitions = (inputs: AuditInputs): SloFinding[] => {
  const { catalogue, appSource, docsSource } = inputs;
  const findings: SloFinding[] = [...validateSloCatalogue(catalogue)];
  const report = (sloId: string, rule: string, message: string) =>
    findings.push({ sloId, rule, message });

  if (catalogue.length === 0) {
    report(
      '<catalogue>',
      'catalogue-empty',
      'The SLO catalogue is empty. Alarms in this repository burn error budget against objectives; ' +
        'with none declared there is nothing to burn against.',
    );
    return findings;
  }

  const stacks = wiredSloStacks(appSource);
  const wiredIds = new Set(stacks.flatMap((stack) => stack.sloIds));
  const stackEnvironments = new Set(
    stacks.map((stack) => stack.envName).filter((env): env is string => env !== undefined),
  );
  const byId = new Map(catalogue.map((slo) => [slo.id, slo]));

  for (const id of wiredIds) {
    if (!byId.has(id)) {
      report(
        id,
        'unknown-slo-wired',
        `bin/app.ts wires SLO '${id}', which is not in the catalogue. Defined ids: ` +
          `${catalogue.map((slo) => slo.id).join(', ')}.`,
      );
    }
  }

  for (const slo of catalogue) {
    if (slo.status === 'active' && !wiredIds.has(slo.id)) {
      report(
        slo.id,
        'slo-not-wired',
        `'${slo.id}' is active but no SloStack in bin/app.ts measures it. An objective nobody alarms on ` +
          `produces no signal, which looks exactly like a signal that never fires — and it will be read ` +
          `off a review as met.`,
      );
    }

    if (slo.status === 'proposed' && wiredIds.has(slo.id)) {
      report(
        slo.id,
        'proposed-slo-wired',
        `'${slo.id}' is proposed but wired into an SloStack. Its SLI has no source yet` +
          `${slo.blockedOn ? ` (${slo.blockedOn})` : ''}, so its alarms would sit in INSUFFICIENT_DATA ` +
          `from the day they deploy. Give the SLI a source and set status to 'active', or leave it unwired.`,
      );
    }

    if (slo.status === 'active' && stackEnvironments.size > 0 && !stackEnvironments.has(slo.envName)) {
      report(
        slo.id,
        'environment-without-slo-stack',
        `'${slo.id}' is an active objective for environment '${slo.envName}', and bin/app.ts has no ` +
          `SloStack with envName '${slo.envName}'. Environments with an SloStack: ` +
          `${[...stackEnvironments].join(', ')}.`,
      );
    }

    if (!docsSource.includes(slo.id)) {
      report(
        slo.id,
        'slo-undocumented',
        `docs/slo.md does not mention '${slo.id}'. The catalogue records the number; the document is ` +
          `where the reason for it, and what happens when the budget runs out, has to be written down — ` +
          `an objective nobody can find the rationale for is one that gets loosened the first time it is ` +
          `inconvenient.`,
      );
    }
  }

  const activeEnvironments = new Set(
    catalogue.filter((slo) => slo.status === 'active').map((slo) => slo.envName),
  );
  for (const envName of new Set(rollbackEnvironments(appSource))) {
    if (!activeEnvironments.has(envName)) {
      report(
        '<catalogue>',
        'rollback-without-slo',
        `bin/app.ts rolls back '${envName}' deployments on an error-budget burn rate, and the catalogue ` +
          `declares no active objective for '${envName}'. The rollback is computing a burn rate against a ` +
          `budget nobody wrote down.`,
      );
    }
  }

  for (const literal of objectiveLiterals(appSource)) {
    report(
      '<catalogue>',
      'objective-literal',
      `bin/app.ts sets an objective as the literal 'target: ${literal}'. Objectives live in ` +
        `lib/slo-definitions.ts and are read from it — two copies of one objective do not disagree ` +
        `loudly: one gets tightened, and the stack still holding the old number keeps computing a burn ` +
        `rate against a budget nobody believes. Use 'target: requireSlo(...).objective'.`,
    );
  }

  return findings;
};

export const formatFindings = (findings: readonly SloFinding[]): string =>
  findings.map((f) => `${f.sloId}  [${f.rule}]\n    ${f.message}`).join('\n\n');

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

  const findings = auditSloDefinitions({
    catalogue: SLO_CATALOGUE,
    appSource: read(path.join(cdkRoot, 'bin', 'app.ts')),
    docsSource: read(path.join(repoRoot, 'docs', 'slo.md')),
  });

  if (findings.length > 0) {
    console.error(`\n${findings.length} SLO violation(s):\n`);
    console.error(formatFindings(findings));
    console.error('\nSee docs/slo.md.\n');
    process.exit(1);
  }

  const active = SLO_CATALOGUE.filter((slo) => slo.status === 'active');
  const proposed = SLO_CATALOGUE.length - active.length;
  console.log(
    `${active.length} active objective(s) across ` +
      `${new Set(active.map((slo) => slo.envName)).size} environment(s) are declared, owned, wired, ` +
      `documented, and have reachable burn-rate policies` +
      `${proposed > 0 ? `; ${proposed} proposed objective(s) carry a recorded blocker` : ''}.`,
  );
}
