import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  GAME_DAY_SCENARIOS,
  MAX_RESOLUTION_SECONDS,
  PROBE_RESOLUTION_SECONDS,
  PROBE_SAMPLES_PER_INVOCATION,
  PROBE_SAMPLE_INTERVAL_SECONDS,
  RECORDER_INTERVAL_SECONDS,
  RECOVERY_OBJECTIVES,
  restorePointAlarmThresholdSeconds,
} from '../lib/game-days';
import { FailoverGameDayStack } from '../lib/failover-game-day-stack';
import { BackupRestoreDrillStack } from '../lib/backup-restore-drill-stack';
import { gameDayDocumentName } from '../lib/game-days';
import * as fs from 'fs';
import * as path from 'path';
import {
  DOCUMENT_NAME_INFIX,
  EXPECTED_RECORDER_INTERVAL_SECONDS,
  EXPECTED_SAMPLES_PER_INVOCATION,
  EXPECTED_SAMPLE_INTERVAL_SECONDS,
  EXPECTED_STORAGE_RESOLUTION,
  GAME_DAY_DOC_PATH,
  GAME_DAY_AUDIT_RULES,
  GameDayAuditRule,
  auditGameDays,
  expectedRestorePointThreshold,
} from '../tools/audit-game-days';

/**
 * Tests for the game-day gate.
 *
 * The baseline is the real stack's own synthesised template, mutated one
 * property at a time. A hand-written fixture would drift from what the stack
 * produces, and a gate whose fixture has drifted reports nothing about the
 * repository it is guarding — which is the same failure the gate itself is for.
 */

const VPC_CONTEXT = {
  'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

/**
 * The two stacks' real templates.
 *
 * The catalogue spans them now — the failover scenarios are built in one and the
 * restore drills in the other — so a mutation has to be applied against one
 * while the other stays pristine, or every mutation would also trip the rules
 * about the stack it did not touch.
 */
const bothStacks = (): { failover: Record<string, any>; drill: Record<string, any> } => {
  const app = new cdk.App({ context: VPC_CONTEXT });
  const networkStack = new cdk.Stack(app, 'Network', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });
  const failover = new FailoverGameDayStack(app, 'FailoverGameDayStack-Test', {
    envName: 'production',
    vpc,
    databaseSecurityGroupId: 'sg-0123456789abcdef0',
    databaseEndpointAddress: 'production-postgres.example.invalid',
    databaseInstanceIdentifier: 'production-postgres',
    service: { clusterName: 'production-cluster', serviceName: 'production-service' },
    approverArns: ['platform-team-oncall'],
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const drill = new BackupRestoreDrillStack(app, 'BackupRestoreDrillStack-Test', {
    envName: 'production',
    vpc,
    sourceInstanceIdentifier: 'production-postgres',
    env: { account: '123456789012', region: 'us-east-1' },
  });
  return {
    failover: Template.fromStack(failover).toJSON(),
    drill: Template.fromStack(drill).toJSON(),
  };
};

const baseline = (): Record<string, any> => bothStacks().failover;
const drillBaseline = (): Record<string, any> => bothStacks().drill;

const DOC = [
  '## 2. The database loses its writer',
  '## 3. The data is wrong and has to be rolled back',
  '## 4. How the RTO is measured',
  '## 5. The RPO nobody watches',
  '## 6. The alarm that is supposed to fire',
  '## 14. What the drill verifies',
  '## 15. The copy that outlives the drill',
].join('\n\n');

const run = (document: Record<string, any>, gameDayDoc = DOC) =>
  auditGameDays({
    templates: [
      { path: 'FailoverGameDayStack-Test.template.json', document },
      { path: 'BackupRestoreDrillStack-Test.template.json', document: drillBaseline() },
    ],
    gameDayDoc,
  });

const rulesFrom = (document: Record<string, any>, gameDayDoc = DOC): GameDayAuditRule[] =>
  run(document, gameDayDoc).violations.map((violation) => violation.rule);

/** The same, with the drill template mutated and the failover one pristine. */
const rulesFromDrill = (document: Record<string, any>, gameDayDoc = DOC): GameDayAuditRule[] =>
  auditGameDays({
    templates: [
      { path: 'FailoverGameDayStack-Test.template.json', document: baseline() },
      { path: 'BackupRestoreDrillStack-Test.template.json', document },
    ],
    gameDayDoc,
  }).violations.map((violation) => violation.rule);

/** The drill's automation document, by name. */
const theDrillDocument = (document: Record<string, any>) =>
  find(document, 'AWS::SSM::Document', (properties) =>
    typeof properties.Name === 'string' && properties.Name.endsWith('-rds-pitr-drill'),
  );

const drillSteps = (document: Record<string, any>): Record<string, any>[] =>
  theDrillDocument(document).Content.mainSteps;

const drillStepNamed = (document: Record<string, any>, name: string) => {
  const found = drillSteps(document).find((step) => step.name === name);
  if (found === undefined) throw new Error(`no drill step named ${name}`);
  return found;
};

/** The logical id of the one resource of a type whose properties match. */
const logicalIdOf = (
  document: Record<string, any>,
  type: string,
  matches: (properties: Record<string, any>) => boolean,
): string => {
  const entry = Object.entries(document.Resources as Record<string, any>).find(
    ([, resource]: [string, any]) => resource.Type === type && matches(resource.Properties ?? {}),
  );
  if (entry === undefined) throw new Error(`no ${type} matching the predicate`);
  return entry[0];
};

/** The one resource of a type whose properties match a predicate. */
const find = (
  document: Record<string, any>,
  type: string,
  matches: (properties: Record<string, any>) => boolean,
): Record<string, any> => {
  const entry = Object.values(document.Resources as Record<string, any>).find(
    (resource: any) => resource.Type === type && matches(resource.Properties ?? {}),
  );
  if (entry === undefined) throw new Error(`no ${type} matching the predicate`);
  return entry.Properties;
};

const alarmNamed = (document: Record<string, any>, name: string) =>
  find(document, 'AWS::CloudWatch::Alarm', (properties) => properties.AlarmName === name);

const theDocument = (document: Record<string, any>) =>
  find(document, 'AWS::SSM::Document', (properties) =>
    typeof properties.Name === 'string' && properties.Name.includes(DOCUMENT_NAME_INFIX),
  );

const probe = (document: Record<string, any>) =>
  find(document, 'AWS::Lambda::Function', (properties) =>
    properties.FunctionName === 'production-game-day-probe',
  );

const steps = (document: Record<string, any>): Record<string, any>[] =>
  theDocument(document).Content.mainSteps;

const stepNamed = (document: Record<string, any>, name: string) => {
  const found = steps(document).find((step) => step.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};

/* ── The restated constants ───────────────────────────────────────────────── */

describe('the constants this gate restates', () => {
  /*
   * Restated in the tool rather than imported, so that a change to the library's
   * value is caught rather than followed. These assertions are what make that
   * deliberate: a rename is one failing line here, not a rule that quietly stops
   * checking anything.
   */
  it('matches the library', () => {
    expect(EXPECTED_SAMPLE_INTERVAL_SECONDS).toBe(PROBE_SAMPLE_INTERVAL_SECONDS);
    expect(EXPECTED_SAMPLES_PER_INVOCATION).toBe(PROBE_SAMPLES_PER_INVOCATION);
    expect(EXPECTED_STORAGE_RESOLUTION).toBe(PROBE_RESOLUTION_SECONDS);
    expect(EXPECTED_RECORDER_INTERVAL_SECONDS).toBe(RECORDER_INTERVAL_SECONDS);
    expect(GAME_DAY_DOC_PATH).toBe('docs/game-days.md');
    expect(DOCUMENT_NAME_INFIX).toBe('-gameday-');
  });

  it('derives the restore-point threshold the same way', () => {
    for (const objective of RECOVERY_OBJECTIVES) {
      expect(expectedRestorePointThreshold(objective)).toBe(
        restorePointAlarmThresholdSeconds(objective),
      );
    }
  });

  it('keeps the tolerated resolution consistent with the sample interval', () => {
    expect(MAX_RESOLUTION_SECONDS).toBe(EXPECTED_SAMPLE_INTERVAL_SECONDS * 2);
  });
});

/* ── The baseline ─────────────────────────────────────────────────────────── */

describe('the real stack', () => {
  it('reports nothing', () => {
    const result = run(baseline());
    expect(result.violations).toEqual([]);
    // Both exercises: the failover's and the drill's. `run` pairs the mutated
    // template with a pristine one from the other stack, because the catalogue
    // spans the two.
    expect(result.documentsRead).toBe(2);
    expect(result.alarmsRead).toBeGreaterThan(5);
  });

  it('discovers the environment from what synth wrote, not from what it was told', () => {
    expect(run(baseline()).environmentsRead).toEqual(['production']);
  });
});

/* ── The documentation ────────────────────────────────────────────────────── */

describe('the documentation', () => {
  it('reports an objective whose section has been renamed', () => {
    // GitHub answers 200 for an anchor that does not exist and lands the reader
    // at the top of the page, so nothing about the link looks broken.
    expect(rulesFrom(baseline(), '## 2. Something else entirely')).toContain(
      'objective-anchor-missing',
    );
  });

  it('reports an alarm description pointing at a heading that is gone', () => {
    const doc = DOC.replace('## 6. The alarm that is supposed to fire', '## 6. Expected pages');
    expect(rulesFrom(baseline(), doc)).toContain('doc-anchor-missing');
  });
});

/* ── The blast radius ─────────────────────────────────────────────────────── */

describe('the blast radius', () => {
  it('reports a document in an environment the scenario does not sanction', () => {
    // The radius is enforced by which documents exist, so a scenario narrowed in
    // the catalogue leaves a working exercise behind in production.
    const document = baseline();
    const result = auditGameDays({
      templates: [{ path: 'FailoverGameDayStack-Test.template.json', document }],
      gameDayDoc: DOC,
      scenarios: [{ ...GAME_DAY_SCENARIOS[0], allowedEnvironments: ['staging'] }],
    });
    expect(result.violations.map((violation) => violation.rule)).toContain(
      'document-in-forbidden-environment',
    );
  });

  it('reports a document whose scenario is no longer in the catalogue at all', () => {
    const document = baseline();
    theDocument(document).Name = gameDayDocumentName('production', 'something-removed');
    expect(rulesFrom(document)).toContain('document-in-forbidden-environment');
  });

  it('reports a sanctioned environment with no exercise in it', () => {
    const document = baseline();
    delete (document.Resources as Record<string, any>)[
      Object.keys(document.Resources).find(
        (key) => (document.Resources as any)[key].Type === 'AWS::SSM::Document',
      )!
    ];
    expect(rulesFrom(document)).toContain('scenario-document-missing');
  });
});

/* ── The approval ─────────────────────────────────────────────────────────── */

describe('the approval', () => {
  it('reports an exercise that does not start from a human', () => {
    const document = baseline();
    theDocument(document).Content.mainSteps = steps(document).slice(1);
    expect(rulesFrom(document)).toContain('document-without-approval');
  });

  it('reports an approve step with nobody to ask', () => {
    // Deploys cleanly, passes every other rule, and fails at run time — during
    // the exercise somebody put in the calendar.
    const document = baseline();
    theDocument(document).Content.parameters.Approvers.default = [];
    expect(rulesFrom(document)).toContain('approval-without-approvers');
  });

  it('reports an approval request nobody is told about', () => {
    const document = baseline();
    delete stepNamed(document, 'approve').inputs.NotificationArn;
    expect(rulesFrom(document)).toContain('approval-without-notification');
  });
});

/* ── The fault ────────────────────────────────────────────────────────────── */

describe('the fault', () => {
  it('reports a reboot dressed as a failover', () => {
    const document = baseline();
    delete stepNamed(document, 'injectFailover').inputs.ForceFailover;
    expect(rulesFrom(document)).toContain('failover-without-force-failover');
  });

  it('reports a failover with no Multi-AZ assertion in front of it', () => {
    const document = baseline();
    theDocument(document).Content.mainSteps = steps(document).filter(
      (step) => step.name !== 'assertMultiAz',
    );
    expect(rulesFrom(document)).toContain('failover-without-multi-az-assert');
  });

  it('reports a status wait placed before the settle period', () => {
    // For a few seconds after the reboot call the instance still reads
    // `available`, so this wait returns immediately and the measurement runs
    // over a window in which nothing has happened.
    const document = baseline();
    const reordered = steps(document).filter((step) => step.name !== 'waitForAvailable');
    const wait = stepNamed(document, 'waitForAvailable');
    reordered.splice(
      reordered.findIndex((step) => step.name === 'settle'),
      0,
      wait,
    );
    theDocument(document).Content.mainSteps = reordered;
    expect(rulesFrom(document)).toContain('wait-before-settle');
  });
});

/* ── The record ───────────────────────────────────────────────────────────── */

describe('the record', () => {
  it('reports a step whose failure ends the exercise silently', () => {
    const document = baseline();
    delete stepNamed(document, 'injectFailover').onFailure;
    expect(rulesFrom(document)).toContain('step-without-abort-path');
  });

  it('reports a step routing failure to something that is not a step', () => {
    const document = baseline();
    stepNamed(document, 'settle').onFailure = 'step:recordSomethingElse';
    expect(rulesFrom(document)).toContain('step-without-abort-path');
  });

  it('reports a document where nothing records an abort', () => {
    const document = baseline();
    for (const step of steps(document)) delete step.onFailure;
    expect(rulesFrom(document)).toContain('abort-step-missing');
  });
});

/* ── The probe ────────────────────────────────────────────────────────────── */

describe('the probe', () => {
  it('reports a probe outside the VPC', () => {
    const document = baseline();
    delete probe(document).VpcConfig;
    expect(rulesFrom(document)).toContain('probe-not-in-vpc');
  });

  it('reports standard-resolution metrics, which undo the sampling entirely', () => {
    const document = baseline();
    probe(document).Environment.Variables.STORAGE_RESOLUTION = '60';
    expect(rulesFrom(document)).toContain('probe-resolution-too-coarse');
  });

  it('reports a probe that has gone back to one sample an invocation', () => {
    const document = baseline();
    probe(document).Environment.Variables.SAMPLES_PER_INVOCATION = '1';
    expect(rulesFrom(document)).toContain('probe-resolution-too-coarse');
  });

  it('reports a sample interval the objectives were not validated against', () => {
    const document = baseline();
    probe(document).Environment.Variables.SAMPLE_INTERVAL_MS = '30000';
    expect(rulesFrom(document)).toContain('probe-resolution-too-coarse');
  });

  it('reports a missing outage alarm and a missing silence alarm', () => {
    const document = baseline();
    for (const name of ['production-db-connect-failing', 'production-game-day-probe-silent']) {
      const key = Object.keys(document.Resources).find(
        (candidate) =>
          (document.Resources as any)[candidate].Type === 'AWS::CloudWatch::Alarm' &&
          (document.Resources as any)[candidate].Properties.AlarmName === name,
      )!;
      delete (document.Resources as Record<string, any>)[key];
    }
    const found = rulesFrom(document).filter((rule) => rule === 'probe-silence-not-alarmed');
    expect(found).toHaveLength(2);
  });

  it('reports a silence alarm that ignores the absence it is about', () => {
    const document = baseline();
    alarmNamed(document, 'production-game-day-probe-silent').TreatMissingData = 'notBreaching';
    expect(rulesFrom(document)).toContain('freshness-alarm-not-breaching');
  });
});

/* ── The freshness signals ────────────────────────────────────────────────── */

describe('the freshness signals', () => {
  it('reports a restore-point threshold that is red in normal operation', () => {
    const objective = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
    const document = baseline();
    alarmNamed(document, 'production-restore-point-stale').Threshold = objective.rpoSeconds;
    expect(rulesFrom(document)).toContain('restore-point-threshold-wrong');
  });

  it('reports a restore-point alarm that reads no backups as a small lag', () => {
    const document = baseline();
    alarmNamed(document, 'production-restore-point-stale').TreatMissingData = 'notBreaching';
    expect(rulesFrom(document)).toContain('freshness-alarm-not-breaching');
  });

  it('reports a missing restore-point alarm', () => {
    const document = baseline();
    const key = Object.keys(document.Resources).find(
      (candidate) =>
        (document.Resources as any)[candidate].Properties?.AlarmName ===
        'production-restore-point-stale',
    )!;
    delete (document.Resources as Record<string, any>)[key];
    expect(rulesFrom(document)).toContain('rehearsal-alarm-missing');
  });

  it('reports an overdue alarm enforcing an interval nobody declared', () => {
    const document = baseline();
    alarmNamed(document, 'production-rehearsal-overdue-rds-multi-az-promotion').Threshold = 24 * 365;
    expect(rulesFrom(document)).toContain('restore-point-threshold-wrong');
  });

  it('reports an overdue alarm that cannot fire for an objective never measured', () => {
    const document = baseline();
    alarmNamed(
      document,
      'production-rehearsal-overdue-rds-multi-az-promotion',
    ).TreatMissingData = 'notBreaching';
    expect(rulesFrom(document)).toContain('freshness-alarm-not-breaching');
  });
});

/* ── The one write ────────────────────────────────────────────────────────── */

describe('the one write', () => {
  const automationPolicy = (document: Record<string, any>) =>
    find(
      document,
      'AWS::IAM::Policy',
      (properties) =>
        JSON.stringify(properties.PolicyDocument).includes('ForceTheFailover'),
    );

  it('reports rds:RebootDBInstance granted on every database in the account', () => {
    // Reads in a diff exactly like the scoped version, and the exercise works
    // identically either way.
    const document = baseline();
    const statement = automationPolicy(document).PolicyDocument.Statement.find(
      (entry: any) => entry.Sid === 'ForceTheFailover',
    );
    statement.Resource = '*';
    expect(rulesFrom(document)).toContain('failover-write-unscoped');
  });

  it('reports any other write the exercise\'s role picks up', () => {
    const document = baseline();
    automationPolicy(document).PolicyDocument.Statement.push({
      Effect: 'Allow',
      Sid: 'SomethingElse',
      Action: 'rds:DeleteDBInstance',
      Resource: '*',
    });
    expect(rulesFrom(document)).toContain('automation-role-holds-other-writes');
  });

  it('permits the reads, and the two KMS actions publishing to a CMK topic needs', () => {
    // `grantPublish` adds kms:Decrypt and kms:GenerateDataKey* without saying
    // so. Writing the permitted list without them reported the approval request
    // as an unexplained write, which is how this rule was first tried.
    const document = baseline();
    automationPolicy(document).PolicyDocument.Statement.push({
      Effect: 'Allow',
      Sid: 'MoreReads',
      Action: ['rds:DescribeDBSnapshots', 'kms:Decrypt'],
      Resource: '*',
    });
    expect(rulesFrom(document)).not.toContain('automation-role-holds-other-writes');
  });
});

/* ── The catalogue, through the gate ──────────────────────────────────────── */

describe('the catalogue', () => {
  it('surfaces every library finding as a catalogue violation', () => {
    const result = auditGameDays({
      templates: [{ path: 'x.template.json', document: baseline() }],
      gameDayDoc: DOC,
      objectives: [{ ...RECOVERY_OBJECTIVES[0], rpoSeconds: 42 }],
    });
    const catalogue = result.violations.filter((violation) => violation.rule === 'catalogue');
    expect(catalogue.length).toBeGreaterThan(0);
    expect(catalogue[0].message).toContain('rpo-nonzero-on-synchronous-basis');
    expect(catalogue[0].file).toBe('lib/game-days.ts');
  });
});

/* ── Every rule fires, and every rule is documented ──────────────────────── */

describe('the rule list', () => {
  /**
   * Each rule, and the one mutation that trips it.
   *
   * The table is the coverage assertion: a rule added to
   * `GAME_DAY_AUDIT_RULES` with no entry here fails the last test in this file,
   * which is the only thing standing between "a rule exists" and "a rule
   * fires". `catalogue` is the exception — it comes from the library and is
   * exercised above.
   */
  const MUTATIONS: Partial<Record<GameDayAuditRule, () => GameDayAuditRule[]>> = {
    'objective-anchor-missing': () => rulesFrom(baseline(), '## 2. Something else'),
    'doc-anchor-missing': () =>
      rulesFrom(baseline(), DOC.replace('## 6. The alarm that is supposed to fire', '## 6. Pages')),
    'scenario-document-missing': () => {
      const document = baseline();
      const key = Object.keys(document.Resources).find(
        (candidate) => (document.Resources as any)[candidate].Type === 'AWS::SSM::Document',
      )!;
      delete (document.Resources as Record<string, any>)[key];
      return rulesFrom(document);
    },
    'document-in-forbidden-environment': () => {
      const document = baseline();
      theDocument(document).Name = gameDayDocumentName('production', 'something-removed');
      return rulesFrom(document);
    },
    'document-without-approval': () => {
      const document = baseline();
      theDocument(document).Content.mainSteps = steps(document).slice(1);
      return rulesFrom(document);
    },
    'approval-without-approvers': () => {
      const document = baseline();
      theDocument(document).Content.parameters.Approvers.default = [];
      return rulesFrom(document);
    },
    'approval-without-notification': () => {
      const document = baseline();
      delete stepNamed(document, 'approve').inputs.NotificationArn;
      return rulesFrom(document);
    },
    'failover-without-multi-az-assert': () => {
      const document = baseline();
      theDocument(document).Content.mainSteps = steps(document).filter(
        (step) => step.name !== 'assertMultiAz',
      );
      return rulesFrom(document);
    },
    'failover-without-force-failover': () => {
      const document = baseline();
      delete stepNamed(document, 'injectFailover').inputs.ForceFailover;
      return rulesFrom(document);
    },
    'wait-before-settle': () => {
      const document = baseline();
      const reordered = steps(document).filter((step) => step.name !== 'waitForAvailable');
      reordered.splice(
        reordered.findIndex((step) => step.name === 'settle'),
        0,
        stepNamed(document, 'waitForAvailable'),
      );
      theDocument(document).Content.mainSteps = reordered;
      return rulesFrom(document);
    },
    'step-without-abort-path': () => {
      const document = baseline();
      delete stepNamed(document, 'injectFailover').onFailure;
      return rulesFrom(document);
    },
    'abort-step-missing': () => {
      const document = baseline();
      for (const step of steps(document)) delete step.onFailure;
      return rulesFrom(document);
    },
    'probe-not-in-vpc': () => {
      const document = baseline();
      delete probe(document).VpcConfig;
      return rulesFrom(document);
    },
    'probe-resolution-too-coarse': () => {
      const document = baseline();
      probe(document).Environment.Variables.STORAGE_RESOLUTION = '60';
      return rulesFrom(document);
    },
    'probe-silence-not-alarmed': () => {
      const document = baseline();
      const key = Object.keys(document.Resources).find(
        (candidate) =>
          (document.Resources as any)[candidate].Properties?.AlarmName ===
          'production-game-day-probe-silent',
      )!;
      delete (document.Resources as Record<string, any>)[key];
      return rulesFrom(document);
    },
    'restore-point-threshold-wrong': () => {
      const document = baseline();
      alarmNamed(document, 'production-restore-point-stale').Threshold = 1;
      return rulesFrom(document);
    },
    'freshness-alarm-not-breaching': () => {
      const document = baseline();
      alarmNamed(document, 'production-restore-point-stale').TreatMissingData = 'notBreaching';
      return rulesFrom(document);
    },
    'rehearsal-alarm-missing': () => {
      const document = baseline();
      const key = Object.keys(document.Resources).find(
        (candidate) =>
          (document.Resources as any)[candidate].Properties?.AlarmName ===
          'production-rehearsal-overdue-rds-multi-az-promotion',
      )!;
      delete (document.Resources as Record<string, any>)[key];
      return rulesFrom(document);
    },
    'failover-write-unscoped': () => {
      const document = baseline();
      const policy = find(document, 'AWS::IAM::Policy', (properties) =>
        JSON.stringify(properties.PolicyDocument).includes('ForceTheFailover'),
      );
      policy.PolicyDocument.Statement.find(
        (entry: any) => entry.Sid === 'ForceTheFailover',
      ).Resource = '*';
      return rulesFrom(document);
    },
    'automation-role-holds-other-writes': () => {
      const document = baseline();
      find(document, 'AWS::IAM::Policy', (properties) =>
        JSON.stringify(properties.PolicyDocument).includes('ForceTheFailover'),
      ).PolicyDocument.Statement.push({
        Effect: 'Allow',
        Sid: 'SomethingElse',
        Action: 'rds:DeleteDBInstance',
        Resource: '*',
      });
      return rulesFrom(document);
    },
    'catalogue': () =>
      auditGameDays({
        templates: [{ path: 'x.template.json', document: baseline() }],
        gameDayDoc: DOC,
        objectives: [{ ...RECOVERY_OBJECTIVES[0], rpoSeconds: 42 }],
      }).violations.map((violation) => violation.rule),

    /* ── The drill ───────────────────────────────────────────────────────── */

    'drill-document-with-approval': () => {
      // An approve step in a scheduled drill is an execution that starts on
      // time, asks a question into an empty room, and times out an hour later.
      const document = drillBaseline();
      theDrillDocument(document).Content.mainSteps = [
        {
          name: 'approve',
          action: 'aws:approve',
          onFailure: 'step:recordAbort',
          inputs: { NotificationArn: 'arn:aws:sns:us-east-1:123456789012:t', Approvers: ['x'] },
        },
        ...drillSteps(document),
      ];
      return rulesFromDrill(document);
    },
    'drill-schedule-missing': () => {
      const document = drillBaseline();
      const key = logicalIdOf(document, 'AWS::Events::Rule', (properties) =>
        typeof properties.Name === 'string' && properties.Name.endsWith('-rds-pitr-drill-schedule'),
      );
      delete (document.Resources as Record<string, any>)[key];
      return rulesFromDrill(document);
    },
    'drill-schedule-interval-wrong': () => {
      const document = drillBaseline();
      find(document, 'AWS::Events::Rule', (properties) =>
        typeof properties.Name === 'string' && properties.Name.endsWith('-rds-pitr-drill-schedule'),
      ).ScheduleExpression = 'rate(90 days)';
      return rulesFromDrill(document);
    },
    'drill-restore-not-point-in-time': () => {
      const document = drillBaseline();
      delete drillStepNamed(document, 'restore').inputs.UseLatestRestorableTime;
      return rulesFromDrill(document);
    },
    'drill-restore-publicly-accessible': () => {
      const document = drillBaseline();
      delete drillStepNamed(document, 'restore').inputs.PubliclyAccessible;
      return rulesFromDrill(document);
    },
    'drill-restore-deletion-protected': () => {
      const document = drillBaseline();
      drillStepNamed(document, 'restore').inputs.DeletionProtection = true;
      return rulesFromDrill(document);
    },
    'drill-verification-missing': () => {
      const document = drillBaseline();
      theDrillDocument(document).Content.mainSteps = drillSteps(document).filter(
        (step) => step.name !== 'verify',
      );
      return rulesFromDrill(document);
    },
    'drill-teardown-missing': () => {
      const document = drillBaseline();
      theDrillDocument(document).Content.mainSteps = drillSteps(document).filter(
        (step) => step.name !== 'teardown',
      );
      return rulesFromDrill(document);
    },
    'drill-delete-not-scoped-to-the-copy': () => {
      const document = drillBaseline();
      // The widening that reads in a diff exactly like the scoped version.
      for (const resource of Object.values(document.Resources as Record<string, any>)) {
        const statements = (resource as any).Properties?.PolicyDocument?.Statement;
        if (!Array.isArray(statements)) continue;
        for (const statement of statements) {
          const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
          if (actions.includes('rds:DeleteDBInstance')) statement.Resource = '*';
        }
      }
      return rulesFromDrill(document);
    },
    'drill-role-can-write-the-source': () => {
      const document = drillBaseline();
      for (const resource of Object.values(document.Resources as Record<string, any>)) {
        const statements = (resource as any).Properties?.PolicyDocument?.Statement;
        if (!Array.isArray(statements)) continue;
        for (const statement of statements) {
          const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
          if (!actions.includes('rds:RestoreDBInstanceToPointInTime')) continue;
          // One extra verb on the statement that already names the source, which
          // is the whole of the "it cannot change anything live" argument.
          statement.Action = [...actions, 'rds:ModifyDBInstance'];
        }
      }
      return rulesFromDrill(document);
    },
    'restore-unverified-not-alarmed': () => {
      const document = drillBaseline();
      const key = logicalIdOf(
        document,
        'AWS::CloudWatch::Alarm',
        (properties) => properties.AlarmName === 'production-restore-unverified',
      );
      delete (document.Resources as Record<string, any>)[key];
      return rulesFromDrill(document);
    },
    'drill-orphan-not-alarmed': () => {
      const document = drillBaseline();
      const key = logicalIdOf(
        document,
        'AWS::CloudWatch::Alarm',
        (properties) => properties.AlarmName === 'production-restore-drill-instance-orphaned',
      );
      delete (document.Resources as Record<string, any>)[key];
      return rulesFromDrill(document);
    },
    'drill-sweeper-missing': () => {
      const document = drillBaseline();
      const key = logicalIdOf(
        document,
        'AWS::Lambda::Function',
        (properties) => properties.FunctionName === 'production-restore-drill-sweeper',
      );
      delete (document.Resources as Record<string, any>)[key];
      return rulesFromDrill(document);
    },
  };

  it('has a mutation for every rule, so no rule is a green check over nothing', () => {
    expect(Object.keys(MUTATIONS).sort()).toEqual([...GAME_DAY_AUDIT_RULES].sort());
  });

  it.each([...GAME_DAY_AUDIT_RULES])('fires %s', (rule) => {
    expect(MUTATIONS[rule]!()).toContain(rule);
  });

  it('documents every rule in its own header', () => {
    // A rule a reviewer cannot find in the header is a rule nobody knows this
    // gate enforces, which is how a finding gets argued with rather than fixed.
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'tools', 'audit-game-days.ts'),
      'utf8',
    );
    const header = source.slice(0, source.indexOf('import '));
    const rules = header.slice(header.indexOf('## The rules'));
    for (const rule of GAME_DAY_AUDIT_RULES) {
      if (rule === 'catalogue') continue;
      expect(rules).toContain(rule);
    }
  });
});
