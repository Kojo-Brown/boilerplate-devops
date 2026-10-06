import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  GAME_DAY_NAMESPACE,
  GAME_DAY_SCENARIOS,
  PROBE_SAMPLES_PER_INVOCATION,
  PROBE_SAMPLE_INTERVAL_SECONDS,
  RECOVERY_OBJECTIVES,
  restorePointAlarmThresholdSeconds,
} from '../lib/game-days';
import {
  FailoverGameDayStack,
  FailoverGameDayStackProps,
  endpointAddressParameterName,
} from '../lib/failover-game-day-stack';
import { BackupRestoreDrillStack } from '../lib/backup-restore-drill-stack';
import { auditGameDays } from '../tools/audit-game-days';
import { flattenIntrinsic, resourceProps } from './support/cfn';

/** The failover scenario, narrowed, with the restore drill left alone. */
const failoverIn = (allowedEnvironments: string[]) =>
  GAME_DAY_SCENARIOS.map((scenario) =>
    scenario.fault === 'rds-force-failover' ? { ...scenario, allowedEnvironments } : scenario,
  );

/** The one Lambda whose environment and shape the measurement depends on. */
const probeProps = (template: Template): Record<string, any> => {
  const found = resourceProps(template, 'AWS::Lambda::Function').find(
    (candidate) => candidate.FunctionName === 'production-game-day-probe',
  );
  if (found === undefined) throw new Error('no production-game-day-probe function');
  return found;
};

/** A step by name, with a message rather than an undefined dereference. */
const step = (steps: Record<string, any>[], name: string): Record<string, any> => {
  const found = steps.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};

/**
 * Tests for the exercise and the signal behind it.
 *
 * The load-bearing one is the last: the whole synthesised template goes through
 * `tools/audit-game-days.ts`, so a rule that stops matching what this stack
 * produces fails here rather than passing everything in CI. The rest are the
 * properties whose absence deploys cleanly and measures the wrong thing — a
 * probe outside the VPC, a reboot without `ForceFailover`, a status wait ahead
 * of the settle period, a step with no abort path.
 */

const VPC_CONTEXT = {
  'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

const synthWith = (props: Partial<FailoverGameDayStackProps> = {}) => {
  const app = new cdk.App({ context: VPC_CONTEXT });
  const networkStack = new cdk.Stack(app, 'Network', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });
  const stack = new FailoverGameDayStack(app, 'FailoverGameDayStack-Test', {
    envName: 'production',
    vpc,
    databaseSecurityGroupId: 'sg-0123456789abcdef0',
    databaseEndpointAddress: 'production-postgres.example.invalid',
    databaseInstanceIdentifier: 'production-postgres',
    service: { clusterName: 'production-cluster', serviceName: 'production-service' },
    approverArns: ['platform-team-oncall'],
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { stack, template: Template.fromStack(stack) };
};

const synth = (props: Partial<FailoverGameDayStackProps> = {}) => synthWith(props).template;

const documentContent = (template: Template, name: string): Record<string, any> => {
  const documents = template.findResources('AWS::SSM::Document');
  const match = Object.values(documents).find((document) => document.Properties?.Name === name);
  if (match === undefined) throw new Error(`no SSM document named ${name}`);
  return match.Properties.Content as Record<string, any>;
};

const stepsOf = (template: Template, name: string): Record<string, any>[] =>
  documentContent(template, name).mainSteps;

const DOCUMENT_NAME = 'production-gameday-rds-failover';

/**
 * The headings the objectives' anchors and the alarm descriptions resolve
 * against, restated rather than read off disk: this file is about the stack, and
 * whether the real `docs/game-days.md` still carries them is the CI gate's
 * question.
 */
const DOC_HEADINGS = [
  '## 2. The database loses its writer',
  '## 3. The data is wrong and has to be rolled back',
  '## 14. What the drill verifies',
  '## 15. The copy that outlives the drill',
  '## 4. How the RTO is measured',
  '## 5. The RPO nobody watches',
  '## 6. The alarm that is supposed to fire',
].join('\n\n');

/* ── Refusals at synth time ───────────────────────────────────────────────── */

describe('what the stack refuses to build', () => {
  it('refuses an exercise nobody can approve', () => {
    // `aws:approve` with an empty Approvers list synthesises, deploys, and fails
    // at run time — during the exercise somebody put in the calendar.
    expect(() => synth({ approverArns: [] })).toThrow(/approverArns is empty/);
  });

  it('refuses an invalid catalogue, so a bad objective never reaches an account', () => {
    expect(() =>
      synth({
        objectives: [{ ...RECOVERY_OBJECTIVES[0], rpoSeconds: 42 }],
        scenarios: [],
      }),
    ).toThrow(/rpo-nonzero-on-synchronous-basis/);
  });
});

/* ── The blast radius ─────────────────────────────────────────────────────── */

describe('the blast radius', () => {
  it('builds a document only where the scenario sanctions the environment', () => {
    const template = synth();
    template.resourceCountIs('AWS::SSM::Document', 1);
    expect(documentContent(template, DOCUMENT_NAME)).toBeDefined();
  });

  it('builds nothing runnable in an environment the scenario does not name', () => {
    // Not "refuses at run time": there is nothing to run. A runtime check's
    // failure mode is a document that exists in production and declines, which
    // is one parameter override away from not declining.
    const template = synth({ scenarios: failoverIn(['staging']) });
    template.resourceCountIs('AWS::SSM::Document', 0);
  });

  it('still publishes the signal where no exercise is allowed', () => {
    // The probe and the gauges are not part of the exercise: they measure the
    // real event, which happens in every environment whether or not anybody
    // rehearses there.
    const template = synth({ scenarios: failoverIn(['staging']) });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'production-game-day-probe',
    });
  });
});

/* ── The probe ────────────────────────────────────────────────────────────── */

describe('the probe', () => {
  const template = synth();

  it('runs inside the VPC, which is where the caller it stands in for is', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'production-game-day-probe',
      VpcConfig: { SubnetIds: Match.anyValue() },
    });
  });

  it('samples inside one invocation, because EventBridge cannot go faster than a minute', () => {
    const variables = probeProps(template).Environment.Variables;
    expect(Number(variables.SAMPLES_PER_INVOCATION)).toBe(PROBE_SAMPLES_PER_INVOCATION);
    expect(Number(variables.SAMPLE_INTERVAL_MS)).toBe(PROBE_SAMPLE_INTERVAL_SECONDS * 1000);
    // High resolution, or CloudWatch aggregates the six samples into the minute
    // they landed in and the sampling buys nothing.
    expect(Number(variables.STORAGE_RESOLUTION)).toBe(1);
  });

  it('is scheduled every minute', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'production-game-day-probe-schedule',
      ScheduleExpression: 'rate(1 minute)',
    });
  });

  it('opens the database security group to itself, from this stack', () => {
    // Declared here rather than in RdsStack: the probe needs the database's
    // port and the database's endpoint, so a rule on the other side would make
    // each stack depend on the other.
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      GroupId: 'sg-0123456789abcdef0',
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    });
  });

  it('holds only the two things it needs: the metric namespace and one parameter', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy')).map((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument),
    );
    const probePolicy = policies.find((policy) => policy.includes('PublishProbeMetrics'));
    expect(probePolicy).toBeDefined();
    // PutMetricData takes no resource, so the namespace condition is the only
    // scope there is — without it the role can write to AWS/RDS.
    expect(probePolicy).toContain(GAME_DAY_NAMESPACE);
    expect(probePolicy).toContain('ssm:GetParameter');
  });

  it('remembers the resolved address in a parameter and not in /tmp', () => {
    expect(probeProps(template).Environment.Variables.ADDRESS_PARAMETER).toBe(
      endpointAddressParameterName('production'),
    );
  });

  it('allows a slow invocation to overlap the next rather than throttling it away', () => {
    expect(probeProps(template).Timeout).toBeGreaterThan(60);
    expect(probeProps(template).ReservedConcurrentExecutions).toBeGreaterThan(1);
  });
});

/* ── The exercise ─────────────────────────────────────────────────────────── */

describe('the exercise', () => {
  const template = synth();
  const steps = stepsOf(template, DOCUMENT_NAME);
  const names = steps.map((step) => step.name);

  it('starts from a human', () => {
    expect(steps[0].action).toBe('aws:approve');
    expect(steps[0].inputs.MinRequiredApprovals).toBe(1);
  });

  it('tells somebody an approval is wanted, and says what will happen', () => {
    expect(steps[0].inputs.NotificationArn).toBeDefined();
    expect(steps[0].inputs.Message).toContain('ForceFailover');
    // The alert the exercise will cause, named in the request that authorises
    // it: an expected page and a surprising one are different incidents.
    expect(steps[0].inputs.Message).toContain('production-db-connect-failing');
  });

  it('asserts the instance is Multi-AZ before touching it', () => {
    const assertion = step(steps, 'assertMultiAz');
    expect(assertion.action).toBe('aws:assertAwsResourceProperty');
    expect(assertion.inputs.PropertySelector).toBe('$.DBInstances[0].MultiAZ');
    expect(names.indexOf(assertion.name)).toBeLessThan(names.indexOf('injectFailover'));
  });

  it('forces the failover rather than rebooting the primary', () => {
    const inject = step(steps, 'injectFailover');
    expect(inject.inputs.Api).toBe('RebootDBInstance');
    expect(inject.inputs.ForceFailover).toBe(true);
  });

  it('settles before waiting on the instance status', () => {
    // For a few seconds after the reboot call the instance still reads
    // `available`, so a status wait placed first is satisfied immediately and
    // the measurement runs over a window in which nothing has happened.
    expect(names.indexOf('settle')).toBeLessThan(names.indexOf('waitForAvailable'));
    expect(names.indexOf('injectFailover')).toBeLessThan(names.indexOf('settle'));
  });

  it('bounds the measurement by the preflight\'s own timestamp', () => {
    const measure = step(steps, 'measure');
    expect(measure.inputs.InputPayload.windowStart).toBe('{{ preflight.startedAt }}');
  });

  it('routes every step to the abort record, so no exercise ends silently', () => {
    for (const candidate of steps) {
      if (candidate.isEnd === true) continue;
      expect(candidate.onFailure).toBe('step:recordAbort');
    }
    expect(names).toContain('recordAbort');
  });

  it('settles for longer than the objective it is measuring', () => {
    const settle = step(steps, 'settle');
    const objective = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-multi-az-promotion')!;
    const seconds = Number(/PT(\d+)S/.exec(settle.inputs.Duration)![1]);
    expect(seconds).toBeGreaterThan(objective.rtoSeconds);
  });

  it('grants the one write, scoped to one instance', () => {
    const policies = Object.values(template.findResources('AWS::IAM::Policy'));
    const automation = policies.find((policy) =>
      JSON.stringify(policy.Properties.PolicyDocument).includes('ForceTheFailover'),
    );
    expect(automation).toBeDefined();
    const statement = automation!.Properties.PolicyDocument.Statement.find(
      (entry: any) => entry.Sid === 'ForceTheFailover',
    );
    expect(statement.Action).toBe('rds:RebootDBInstance');
    expect(flattenIntrinsic(statement.Resource)).toContain('db:production-postgres');
    expect(statement.Resource).not.toBe('*');
  });
});

/* ── The signals ──────────────────────────────────────────────────────────── */

describe('the signals', () => {
  const template = synth();
  const alarms = () =>
    Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
      (alarm) => alarm.Properties,
    );
  const alarm = (name: string) => {
    const found = alarms().find((candidate) => candidate.AlarmName === name);
    if (found === undefined) throw new Error(`no alarm named ${name}`);
    return found;
  };

  it('reports a caller-side outage, and holds its state when the probe is quiet', () => {
    const connect = alarm('production-db-connect-failing');
    expect(connect.ComparisonOperator).toBe('LessThanThreshold');
    expect(connect.Statistic).toBe('Minimum');
    // Absence is the other alarm's subject; paging twice for one cause is how a
    // responder learns to read one of the two.
    expect(connect.TreatMissingData).toBe('missing');
    expect(connect.AlarmDescription).toContain('docs/game-days.md#6-the-alarm-that-is-supposed-to-fire');
  });

  it('reports the probe\'s own silence, and breaches on the absence of data', () => {
    const silent = alarm('production-game-day-probe-silent');
    expect(silent.Statistic).toBe('SampleCount');
    expect(silent.TreatMissingData).toBe('breaching');
  });

  it('sets the restore-point threshold clear of the sawtooth, not at the objective', () => {
    const objective = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-point-in-time-restore')!;
    const stale = alarm('production-restore-point-stale');
    expect(stale.Threshold).toBe(restorePointAlarmThresholdSeconds(objective));
    expect(stale.Threshold).toBeGreaterThan(objective.rpoSeconds);
    // No reading is not a small lag: an instance with no backup retention has no
    // LatestRestorableTime at all.
    expect(stale.TreatMissingData).toBe('breaching');
  });

  it('arms an overdue alarm for every rehearsed objective, including one exercised elsewhere', () => {
    // Both objectives are rehearsed now, and only one of them is rehearsed by
    // *this* stack. The alarm belongs next to the metric rather than next to the
    // document: `HoursSinceRehearsal` is published from here, for every
    // objective, from the parameter whichever exercise last wrote it.
    const names = alarms().map((candidate) => candidate.AlarmName as string);
    expect(names).toContain('production-rehearsal-overdue-rds-multi-az-promotion');
    expect(names).toContain('production-rehearsal-overdue-rds-point-in-time-restore');
  });

  it('arms no overdue alarm for a declared objective', () => {
    // A `declared` objective has no exercise, so an overdue alarm on it would be
    // red forever and would say nothing its status does not already say.
    const template = synth({
      objectives: RECOVERY_OBJECTIVES.map((objective) =>
        objective.id === 'rds-point-in-time-restore'
          ? { ...objective, status: 'declared' as const }
          : objective,
      ),
      scenarios: GAME_DAY_SCENARIOS.filter((scenario) => scenario.fault === 'rds-force-failover'),
    });
    const names = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
      (candidate) => candidate.Properties.AlarmName as string,
    );
    expect(names).toContain('production-rehearsal-overdue-rds-multi-az-promotion');
    expect(names).not.toContain('production-rehearsal-overdue-rds-point-in-time-restore');
  });

  it('arms the overdue alarm at the interval the objective declares', () => {
    const objective = RECOVERY_OBJECTIVES.find((entry) => entry.id === 'rds-multi-az-promotion')!;
    const overdue = alarm('production-rehearsal-overdue-rds-multi-az-promotion');
    expect(overdue.Threshold).toBe(objective.rehearsalIntervalDays * 24);
    // Never rehearsed means no datapoint, and that is the state it exists for.
    expect(overdue.TreatMissingData).toBe('breaching');
    expect(overdue.AlarmDescription).toContain('production-gameday-rds-failover');
  });

  it('arms no overdue alarm where no exercise for it exists', () => {
    // An alarm whose instruction is "run this document" in an environment with
    // no such document cannot be cleared, and the responder's only options are
    // to widen the interval or mute it. The case is caught by the gate instead —
    // see the audit test below.
    const template = synth({ scenarios: failoverIn(['staging']) });
    const names = Object.values(template.findResources('AWS::CloudWatch::Alarm')).map(
      (candidate) => candidate.Properties.AlarmName as string,
    );
    expect(names).not.toContain('production-rehearsal-overdue-rds-multi-az-promotion');
  });

  it('publishes every alarm to one topic the enricher can subscribe to', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'production-game-day',
      KmsMasterKeyId: Match.anyValue(),
    });
    for (const candidate of alarms()) {
      expect(candidate.AlarmActions).toBeDefined();
    }
  });
});

/* ── The gate, over this stack's own template ─────────────────────────────── */

describe('tools/audit-game-days.ts, over what this stack synthesises', () => {
  /*
   * Both stacks, because the catalogue now spans them: the gate requires a
   * document for every environment a scenario sanctions, and half the scenarios
   * are built in `BackupRestoreDrillStack`. Auditing one template in isolation
   * would report the other stack's exercises as missing, which is the gate
   * working — see the drill stack's own test for that direction.
   */
  const bothTemplates = (props: Partial<FailoverGameDayStackProps> = {}) => {
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
      ...props,
    });
    const drill = new BackupRestoreDrillStack(app, 'BackupRestoreDrillStack-Test', {
      envName: 'production',
      vpc,
      sourceInstanceIdentifier: 'production-postgres',
      env: { account: '123456789012', region: 'us-east-1' },
      scenarios: props.scenarios,
      objectives: props.objectives,
    });
    return [
      {
        path: 'FailoverGameDayStack-Test.template.json',
        document: Template.fromStack(failover).toJSON() as unknown,
      },
      {
        path: 'BackupRestoreDrillStack-Test.template.json',
        document: Template.fromStack(drill).toJSON() as unknown,
      },
    ];
  };

  it('reports nothing', () => {
    const result = auditGameDays({ templates: bothTemplates(), gameDayDoc: DOC_HEADINGS });
    expect(result.violations).toEqual([]);
    expect(result.documentsRead).toBe(2);
    expect(result.environmentsRead).toEqual(['production']);
  });

  it('reports an objective whose number is claimed here and measured somewhere else', () => {
    // The stack arms no unclearable alarm; the gate is what stops the
    // configuration existing. Without both halves, an objective rehearsed only
    // in staging quietly carries a production RTO nobody has measured in
    // production.
    const result = auditGameDays({
      templates: bothTemplates({ scenarios: failoverIn(['staging']) }),
      gameDayDoc: DOC_HEADINGS,
    });
    expect(result.violations.map((violation) => violation.rule)).toContain(
      'rehearsal-alarm-missing',
    );
  });
});
