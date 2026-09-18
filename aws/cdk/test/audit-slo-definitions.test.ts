import * as fs from 'fs';
import * as path from 'path';
import { SLO_CATALOGUE, SloDefinition } from '../lib/slo-definitions';
import {
  auditSloDefinitions,
  constructorArguments,
  formatFindings,
  objectiveLiterals,
  rollbackEnvironments,
  stripComments,
  wiredSloStacks,
} from '../tools/audit-slo-definitions';

/**
 * Tests for the SLO review gate.
 *
 * The gate's whole value is the cases where nothing is synthesised, so the tests
 * are mostly about a catalogue and an `bin/app.ts` that disagree in ways neither
 * `tsc` nor `cdk synth` can see.
 */

const ACTIVE: SloDefinition = {
  id: 'test-api-availability',
  service: 'api',
  envName: 'test',
  sli: { kind: 'availability', minimumEventsPerMinute: 15 },
  objective: 0.999,
  windowDays: 30,
  owner: 'platform-team',
  runbookUrl: 'https://runbooks.invalid/slo',
  description: 'Requests that did not fail',
  status: 'active',
};

const PROPOSED: SloDefinition = {
  ...ACTIVE,
  id: 'test-api-latency',
  sli: { kind: 'latency', thresholdSeconds: 0.3, minimumEventsPerMinute: 15 },
  objective: 0.99,
  status: 'proposed',
  blockedOn: 'the application emits no fast-request counter',
};

const APP_WIRING = `
new SloStack(app, 'SloStack-Test', {
  envName: 'test',
  slos: [
    {
      sloId: 'test-api-availability',
      source: { kind: 'alb', loadBalancerFullName: alb.name, targetGroupFullName: tg.name },
    },
  ],
});
`;

const DOCS = `
# SLOs
test-api-availability is the availability objective.
test-api-latency is proposed.
`;

const audit = (overrides: Partial<Parameters<typeof auditSloDefinitions>[0]> = {}) =>
  auditSloDefinitions({
    catalogue: [ACTIVE, PROPOSED],
    appSource: APP_WIRING,
    docsSource: DOCS,
    ...overrides,
  });

const rules = (findings: ReturnType<typeof audit>) => findings.map((f) => f.rule);

describe('source scanning', () => {
  it('strips comments without being confused by a URL', () => {
    // Every runbook link in the catalogue contains `//`, and a naive line-comment
    // strip would swallow the rest of the line.
    const stripped = stripComments(
      "const url = 'https://runbooks.invalid/slo'; // trailing note\nconst x = 1;",
    );
    expect(stripped).toContain("'https://runbooks.invalid/slo'");
    expect(stripped).not.toContain('trailing note');
    expect(stripped).toContain('const x = 1;');
  });

  it('strips block comments and keeps the line count', () => {
    const stripped = stripComments('a\n/* two\nlines */\nb');
    expect(stripped.split('\n')).toHaveLength(4);
    expect(stripped).not.toContain('two');
  });

  it('does not read a commented-out stack as a wired one', () => {
    // The failure this prevents: an objective marked active, its stack commented
    // out during an incident, and a gate that keeps reporting it as measured.
    const source = `// new SloStack(app, 'SloStack-Test', { envName: 'test', slos: [{ sloId: 'x' }] });`;
    expect(wiredSloStacks(source)).toEqual([]);
  });

  it('extracts an argument list containing nested calls and parentheses', () => {
    // A regex stopping at the first `)` reads only as far as the first nested
    // call, which is usually past `envName` — so it appears to work.
    const source = `
      new SloStack(app, 'SloStack-Test', {
        envName: 'test',
        slos: [{ sloId: 'a', source: makeSource(alb.name, tg.name) }],
        pageEmails: [mail('x')],
      });
      new SloStack(app, 'SloStack-Other', { envName: 'other', slos: [{ sloId: 'b' }] });
    `;
    const blocks = constructorArguments(source, 'SloStack');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain('pageEmails');
    expect(wiredSloStacks(source)).toEqual([
      { envName: 'test', sloIds: ['a'] },
      { envName: 'other', sloIds: ['b'] },
    ]);
  });

  it('is not fooled by a parenthesis inside a string', () => {
    const source = `new SloStack(app, 'x', { envName: 'test', description: 'a ) b', slos: [{ sloId: 'a' }] });`;
    expect(wiredSloStacks(source)).toEqual([{ envName: 'test', sloIds: ['a'] }]);
  });

  it('reads the rollback stack environment from the prop, or the construct id', () => {
    expect(
      rollbackEnvironments(
        `new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Staging', { envName: 'staging' });`,
      ),
    ).toEqual(['staging']);
    // `envName` has a default in that stack, so a repository relying on it would
    // otherwise read as having no rollback at all.
    expect(
      rollbackEnvironments(
        `new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Production', { slo: x });`,
      ),
    ).toEqual(['production']);
  });

  it('finds a numeric objective literal and ignores a derived one', () => {
    expect(objectiveLiterals('slo: { target: 0.999, windowDays: 30 }')).toEqual(['0.999']);
    expect(objectiveLiterals('slo: { target: someSlo.objective }')).toEqual([]);
  });
});

describe('auditSloDefinitions', () => {
  it('passes a catalogue that matches its wiring', () => {
    expect(audit()).toEqual([]);
  });

  it('reports an active objective nothing measures', () => {
    // Nothing fails: there is simply no signal, which is indistinguishable from a
    // signal that never fires — and it gets read off a review as met.
    const findings = audit({ appSource: '' });
    expect(rules(findings)).toContain('slo-not-wired');
    expect(findings[0].message).toContain('test-api-availability');
  });

  it('reports a proposed objective that has been wired', () => {
    const findings = audit({
      appSource: APP_WIRING.replace('test-api-availability', 'test-api-latency'),
    });
    expect(rules(findings)).toEqual(
      expect.arrayContaining(['proposed-slo-wired', 'slo-not-wired']),
    );
    expect(findings.find((f) => f.rule === 'proposed-slo-wired')?.message).toContain(
      'fast-request counter',
    );
  });

  it('reports a wired id that is not in the catalogue', () => {
    const findings = audit({
      appSource: APP_WIRING.replace('test-api-availability', 'test-api-avaliability'),
    });
    expect(rules(findings)).toContain('unknown-slo-wired');
    expect(findings.find((f) => f.rule === 'unknown-slo-wired')?.message).toContain(
      'test-api-availability',
    );
  });

  it('reports an environment with objectives and no stack', () => {
    const findings = audit({
      catalogue: [ACTIVE, { ...ACTIVE, id: 'prod-api-availability', envName: 'production' }],
    });
    expect(rules(findings)).toContain('environment-without-slo-stack');
    expect(findings.find((f) => f.rule === 'environment-without-slo-stack')?.message).toContain(
      "envName 'production'",
    );
  });

  it('reports a rollback burning against an objective nobody declared', () => {
    const findings = audit({
      appSource:
        APP_WIRING +
        `new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Production', { envName: 'production' });`,
    });
    expect(rules(findings)).toContain('rollback-without-slo');
  });

  it('accepts a rollback for an environment that has an objective', () => {
    const findings = audit({
      appSource:
        APP_WIRING +
        `new SloBurnRateRollbackStack(app, 'SloBurnRateRollbackStack-Test', { envName: 'test' });`,
    });
    expect(rules(findings)).not.toContain('rollback-without-slo');
  });

  it('reports an objective restated as a literal', () => {
    // Two copies of an objective do not disagree loudly: one gets tightened, and
    // the stack still holding the old number keeps rolling back against a budget
    // nobody believes.
    const findings = audit({
      appSource: `${APP_WIRING}\nnew SloBurnRateRollbackStack(app, 'x', { envName: 'test', slo: { target: 0.995 } });`,
    });
    expect(rules(findings)).toContain('objective-literal');
    expect(findings.find((f) => f.rule === 'objective-literal')?.message).toContain('0.995');
  });

  it('reports an objective the documentation does not mention', () => {
    const findings = audit({ docsSource: '# SLOs\n' });
    expect(rules(findings).filter((r) => r === 'slo-undocumented')).toHaveLength(2);
  });

  it('reports an empty catalogue and stops there', () => {
    const findings = audit({ catalogue: [] });
    expect(rules(findings)).toEqual(['catalogue-empty']);
  });

  it('validates proposed objectives, which no stack ever sees', () => {
    // A proposed entry never reaches `assertValidSlo`, so this gate is the only
    // place an unreachable policy on one can be caught — before it is promoted to
    // active months later by someone who reads the catalogue as reviewed.
    const findings = audit({
      catalogue: [
        ACTIVE,
        { ...PROPOSED, objective: 0.9, sli: { kind: 'availability', minimumEventsPerMinute: 200 } },
      ],
    });
    expect(rules(findings)).toContain('policy-unreachable');
  });

  it('formats findings with the rule name and the objective', () => {
    const text = formatFindings(audit({ appSource: '' }));
    expect(text).toContain('[slo-not-wired]');
    expect(text).toContain('test-api-availability');
  });
});

describe('this repository', () => {
  const cdkRoot = path.resolve(__dirname, '..');
  const repoRoot = path.resolve(cdkRoot, '..', '..');
  const appSource = fs.readFileSync(path.join(cdkRoot, 'bin', 'app.ts'), 'utf8');
  const docsSource = fs.readFileSync(path.join(repoRoot, 'docs', 'slo.md'), 'utf8');

  it('has a catalogue that agrees with its wiring', () => {
    expect(
      auditSloDefinitions({ catalogue: SLO_CATALOGUE, appSource, docsSource }),
    ).toEqual([]);
  });

  it('wires every active objective into an SloStack for its own environment', () => {
    const stacks = wiredSloStacks(appSource);
    for (const slo of SLO_CATALOGUE.filter((s) => s.status === 'active')) {
      expect(
        stacks.some((stack) => stack.envName === slo.envName && stack.sloIds.includes(slo.id)),
      ).toBe(true);
    }
  });

  it('states no objective as a literal in bin/app.ts', () => {
    expect(objectiveLiterals(appSource)).toEqual([]);
  });

  it('rolls back only environments that have declared an objective', () => {
    const declared = new Set(
      SLO_CATALOGUE.filter((s) => s.status === 'active').map((s) => s.envName),
    );
    for (const envName of rollbackEnvironments(appSource)) {
      expect(declared.has(envName)).toBe(true);
    }
  });
});
