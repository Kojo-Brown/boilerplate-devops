import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  GAME_DAY_NAMESPACE,
  GAME_DAY_SCENARIOS,
  MAX_DRILL_INSTANCE_AGE_SECONDS,
  RECOVERY_OBJECTIVES,
  RESTORE_TLS_CHAIN_UNVERIFIED,
  RESTORE_VERIFICATION_CHECKS,
  drillInstanceIdentifier,
  gameDayDocumentName,
  rehearsalParameterName,
  restorePointStaleAfterSeconds,
} from '../lib/game-days';
import {
  BackupRestoreDrillStack,
  BackupRestoreDrillStackProps,
  SWEEPER_INTERVAL_SECONDS,
  conductorFunctionName,
  sweeperFunctionName,
  verifierFunctionName,
} from '../lib/backup-restore-drill-stack';
import { FailoverGameDayStack } from '../lib/failover-game-day-stack';
import { auditGameDays } from '../tools/audit-game-days';
import { flattenIntrinsic, resourceProps } from './support/cfn';

/**
 * Tests for the restore drill.
 *
 * The load-bearing one is the last: the whole synthesised template goes through
 * `tools/audit-game-days.ts`, so a rule that stops matching what this stack
 * produces fails here rather than passing everything in CI. The rest are the
 * properties whose absence deploys cleanly and leaves either a copy of
 * production on a public endpoint, a copy nothing can delete, or a drill that
 * reports a success it did not establish.
 */

const VPC_CONTEXT = {
  'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

const DRILL = GAME_DAY_SCENARIOS.find(
  (scenario) => scenario.fault === 'rds-point-in-time-restore',
)!;
const OBJECTIVE = RECOVERY_OBJECTIVES.find((entry) => entry.id === DRILL.objectiveId)!;
const DOCUMENT_NAME = gameDayDocumentName('production', DRILL.id);
const COPY = drillInstanceIdentifier('production');

/*
 * The headings the objectives' anchors and the alarm descriptions resolve
 * against, restated rather than read off disk. Both stacks' alarms are audited
 * together below, so this carries the failover's headings too.
 */
const DOC_HEADINGS = [
  '## 2. The database loses its writer',
  '## 3. The data is wrong and has to be rolled back',
  '## 5. The RPO nobody watches',
  '## 6. The alarm that is supposed to fire',
  '## 14. What the drill verifies',
  '## 15. The copy that outlives the drill',
].join('\n\n');

const synthWith = (props: Partial<BackupRestoreDrillStackProps> = {}) => {
  const app = new cdk.App({ context: VPC_CONTEXT });
  const networkStack = new cdk.Stack(app, 'Network', {
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });
  const stack = new BackupRestoreDrillStack(app, 'BackupRestoreDrillStack-Test', {
    envName: 'production',
    vpc,
    sourceInstanceIdentifier: 'production-postgres',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { stack, template: Template.fromStack(stack) };
};

const synth = (props: Partial<BackupRestoreDrillStackProps> = {}) => synthWith(props).template;

const documentContent = (template: Template, name: string): Record<string, any> => {
  const documents = template.findResources('AWS::SSM::Document');
  const match = Object.values(documents).find((document) => document.Properties?.Name === name);
  if (match === undefined) throw new Error(`no SSM document named ${name}`);
  return match.Properties.Content;
};

const steps = (template: Template): Record<string, any>[] =>
  documentContent(template, DOCUMENT_NAME).mainSteps;

const step = (template: Template, name: string): Record<string, any> => {
  const found = steps(template).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no step named ${name}`);
  return found;
};

const policyDocuments = (template: Template): string[] =>
  Object.values(template.findResources('AWS::IAM::Policy')).map((policy) =>
    JSON.stringify(policy.Properties.PolicyDocument),
  );

const functionNamed = (template: Template, name: string): Record<string, any> => {
  const found = resourceProps(template, 'AWS::Lambda::Function').find(
    (candidate) => candidate.FunctionName === name,
  );
  if (found === undefined) throw new Error(`no ${name} function`);
  return found;
};

const alarm = (template: Template, name: string): Record<string, any> => {
  const found = resourceProps(template, 'AWS::CloudWatch::Alarm').find(
    (candidate) => candidate.AlarmName === name,
  );
  if (found === undefined) throw new Error(`no alarm named ${name}`);
  return found;
};

/* ── What the stack refuses to build ──────────────────────────────────────── */

describe('what the stack refuses to build', () => {
  it('refuses an invalid catalogue, so a bad objective never reaches an account', () => {
    expect(() =>
      synth({
        objectives: [{ ...RECOVERY_OBJECTIVES[0], rpoSeconds: 42 }],
        scenarios: [],
      }),
    ).toThrow(/rpo-nonzero-on-synchronous-basis/);
  });

  it('builds the drill only where the scenario sanctions the environment', () => {
    // Not "refuses at run time": there is nothing to run. A runtime check's
    // failure mode is a document that exists in production and declines, which
    // is one parameter override away from not declining.
    const template = synth({
      scenarios: GAME_DAY_SCENARIOS.map((scenario) =>
        scenario.fault === 'rds-point-in-time-restore'
          ? { ...scenario, allowedEnvironments: ['staging'] }
          : scenario,
      ),
    });
    template.resourceCountIs('AWS::SSM::Document', 0);
    template.resourceCountIs('AWS::Events::Rule', 1); // the sweeper's, which is not an exercise
  });

  it('builds no failover document, because that is the other stack', () => {
    // Without the fault filter every drill in the catalogue would also be
    // emitted here, and every failover emitted there: a forced failover
    // carrying a restore drill's name, cadence and approval message.
    const template = synth();
    template.resourceCountIs('AWS::SSM::Document', 1);
    expect(documentContent(template, DOCUMENT_NAME)).toBeDefined();
    for (const candidate of steps(template)) {
      expect(candidate.inputs?.Api).not.toBe('RebootDBInstance');
    }
  });
});

/* ── The trigger ──────────────────────────────────────────────────────────── */

describe('the trigger', () => {
  const template = synth();

  it('starts from a schedule and not from a human', () => {
    // The inverse of FailoverGameDayStack, and the reason is in
    // docs/game-days.md#13: a drill behind an approval is a drill that runs
    // once, in the week it shipped.
    for (const candidate of steps(template)) {
      expect(candidate.action).not.toBe('aws:approve');
    }
    const rules = resourceProps(template, 'AWS::Events::Rule').filter(
      (candidate) => candidate.Name === `production-${DRILL.id}-schedule`,
    );
    expect(rules).toHaveLength(1);
    expect(rules[0].ScheduleExpression).toBe(`rate(${DRILL.scheduleIntervalDays} days)`);
    expect(rules[0].State).toBe('ENABLED');
  });

  it('targets the automation document by its own name', () => {
    const rule = resourceProps(template, 'AWS::Events::Rule').find(
      (candidate) => candidate.Name === `production-${DRILL.id}-schedule`,
    )!;
    const target = (rule.Targets as Record<string, any>[])[0];
    expect(flattenIntrinsic(target.Arn)).toContain(
      `automation-definition/${DOCUMENT_NAME}:$DEFAULT`,
    );
    expect(target.RoleArn).toBeDefined();
  });

  it('runs at least as often as the objective it keeps fresh', () => {
    // Enforced in the catalogue; asserted here because this is the number the
    // EventBridge rule is built from, and a rule slower than the shelf life
    // means the overdue alarm is red on a cycle somebody chose.
    expect(DRILL.scheduleIntervalDays!).toBeLessThanOrEqual(OBJECTIVE.rehearsalIntervalDays);
  });

  it('hands the automation role over only to SSM', () => {
    const scheduler = policyDocuments(template).find((policy) =>
      policy.includes('PassTheAutomationRole'),
    );
    expect(scheduler).toBeDefined();
    expect(scheduler).toContain('iam:PassRole');
    expect(scheduler).toContain('ssm.amazonaws.com');
    expect(scheduler).toContain('ssm:StartAutomationExecution');
  });
});

/* ── The restore ──────────────────────────────────────────────────────────── */

describe('the restore', () => {
  const template = synth();
  const restore = () => step(template, 'restore');

  it('restores to a point in time, from the automated backups', () => {
    expect(restore().inputs.Api).toBe('RestoreDBInstanceToPointInTime');
    expect(restore().inputs.UseLatestRestorableTime).toBe(true);
  });

  it('keeps the copy off the internet', () => {
    // RestoreDBInstanceToPointInTime takes this from the request and defaults
    // it from the subnet group, so an absent flag is a full copy of the
    // database on a public endpoint once a month.
    expect(restore().inputs.PubliclyAccessible).toBe(false);
  });

  it('keeps the copy deletable', () => {
    expect(restore().inputs.DeletionProtection).toBe(false);
    expect(restore().inputs.MultiAZ).toBe(false);
  });

  it('reproduces the source\'s instance class and parameter group', () => {
    // A cheaper class measures a recovery nobody would perform: the volume
    // hydrates at a rate the instance's own throughput caps.
    expect(restore().inputs.DBInstanceClass).toBe('{{ preflight.instanceClass }}');
    expect(restore().inputs.DBParameterGroupName).toBe('{{ preflight.parameterGroup }}');
  });

  it('places the copy in its own subnet group and security group', () => {
    expect(restore().inputs.DBSubnetGroupName).toBe('production-dr-drill-subnets');
    template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
      DBSubnetGroupName: 'production-dr-drill-subnets',
    });
    const drillGroup = resourceProps(template, 'AWS::EC2::SecurityGroup').find(
      (candidate) => candidate.GroupName === 'production-dr-drill-sg',
    )!;
    expect(drillGroup).toBeDefined();
    // No egress: the copy initiates nothing. CDK writes a dummy deny-all rule
    // when a group has no egress rules, which is what this asserts.
    expect(JSON.stringify(drillGroup.SecurityGroupEgress ?? [])).toContain('255.255.255.255/32');
  });

  it('lets only the verifier reach the copy', () => {
    const verifierGroup = resourceProps(template, 'AWS::EC2::SecurityGroup').find(
      (candidate) => candidate.GroupName === 'production-restore-drill-verifier-sg',
    )!;
    expect(verifierGroup).toBeDefined();
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    });
  });

  it('waits for the copy without sleeping first, unlike the failover', () => {
    // A forced failover leaves the instance reading `available` for a few
    // seconds, so its document needs a settle period before the status wait. A
    // restore has the opposite shape: the instance does not exist until the API
    // returns, so a sleep would be latency added to the number being measured.
    for (const candidate of steps(template)) {
      expect(candidate.action).not.toBe('aws:sleep');
    }
    const wait = step(template, 'waitForAvailable');
    expect(wait.inputs.PropertySelector).toBe('$.DBInstances[0].DBInstanceStatus');
    expect(wait.inputs.DesiredValues).toEqual(['available']);
    expect(wait.timeoutSeconds).toBe(Math.max(1800, OBJECTIVE.rtoSeconds * 3));
  });
});

/* ── The procedure ────────────────────────────────────────────────────────── */

describe('the procedure', () => {
  const template = synth();

  it('verifies before it measures, and measures before it tears down', () => {
    // Each inversion is a drill that looks like it worked: a measurement taken
    // before the verification resets the rehearsal clock on an unverified copy,
    // and a teardown before the measurement reads InstanceCreateTime off an
    // instance that is being deleted.
    const order = steps(template).map((candidate) => candidate.name);
    expect(order).toEqual([
      'preflight',
      'restore',
      'waitForAvailable',
      'verify',
      'measure',
      'teardown',
      'recordAbort',
    ]);
  });

  it('routes every step\'s failure to the abort, which is the step that deletes the copy', () => {
    for (const candidate of steps(template)) {
      if (candidate.name === 'recordAbort') {
        expect(candidate.isEnd).toBe(true);
        expect(candidate.inputs.InputPayload.operation).toBe('abort');
        continue;
      }
      expect(candidate.onFailure).toBe('step:recordAbort');
    }
    // And the happy path reaches the teardown rather than ending at the
    // measurement, which is the one step whose `nextStep` matters.
    expect(step(template, 'measure').nextStep).toBe('teardown');
    expect(step(template, 'teardown').isEnd).toBe(true);
  });

  it('passes the preflight\'s restore point and the objective\'s ceiling to the verifier', () => {
    const verify = step(template, 'verify');
    expect(verify.inputs.FunctionName).toBe(verifierFunctionName('production'));
    expect(verify.inputs.InputPayload.restorePoint).toBe('{{ preflight.restorePoint }}');
    expect(verify.inputs.InputPayload.maxRestorePointStaleSeconds).toBe(
      restorePointStaleAfterSeconds(OBJECTIVE),
    );
  });

  it('carries the verdict into the measurement rather than letting the step status decide', () => {
    const measure = step(template, 'measure');
    expect(measure.inputs.FunctionName).toBe(conductorFunctionName('production'));
    expect(measure.inputs.InputPayload.verdict).toBe('{{ verify.verdict }}');
    expect(measure.inputs.InputPayload.verifiedAt).toBe('{{ verify.verifiedAt }}');
    expect(measure.inputs.InputPayload.checksFailed).toBe('{{ verify.checksFailed }}');
  });

  it('types the check lists as strings, not StringList', () => {
    // An `aws:invokeLambdaFunction` output typed StringList over an empty array
    // is a case the schema does not document, and on a verified drill
    // `checksFailed` is empty every single time — so the one code path that
    // always runs would be the one relying on undocumented behaviour.
    const outputs = step(template, 'verify').outputs as Record<string, any>[];
    for (const output of outputs) {
      expect(output.Type).toBe('String');
    }
  });
});

/* ── The grants ───────────────────────────────────────────────────────────── */

describe('the grants', () => {
  const template = synth();

  it('scopes every delete to the one copy, by name and not by prefix', () => {
    const deletes = policyDocuments(template).filter((policy) =>
      policy.includes('rds:DeleteDBInstance'),
    );
    // Two: the conductor's teardown and the sweeper's.
    expect(deletes).toHaveLength(2);
    for (const policy of deletes) {
      expect(policy).toContain(`:db:${COPY}`);
      expect(policy).not.toContain(`${COPY}-`);
      expect(policy).not.toContain(`${COPY}*`);
    }
  });

  it('gives the automation role no delete at all', () => {
    // It is the identity an EventBridge schedule hands to SSM unattended, which
    // makes it the last place in this repository that should be able to delete
    // a database.
    const automation = policyDocuments(template).find((policy) =>
      policy.includes('RestoreIntoTheCopy'),
    )!;
    expect(automation).toBeDefined();
    expect(automation).not.toContain('rds:DeleteDBInstance');
    expect(automation).toContain('rds:RestoreDBInstanceToPointInTime');
    expect(automation).toContain('rds:AddTagsToResource');
  });

  it('names the source instance under exactly one write', () => {
    // The whole safety argument for running this unattended is that it cannot
    // change anything live, and that argument is an IAM policy rather than an
    // intention.
    const naming = policyDocuments(template).filter((policy) =>
      policy.includes(':db:production-postgres'),
    );
    expect(naming).toHaveLength(1);
    expect(naming[0]).toContain('rds:RestoreDBInstanceToPointInTime');
  });

  it('scopes every PutMetricData to the game-day namespace', () => {
    // PutMetricData takes no resource, so the namespace condition is the only
    // scope available — without it these roles can write to AWS/RDS.
    for (const policy of policyDocuments(template)) {
      if (!policy.includes('cloudwatch:PutMetricData')) continue;
      expect(policy).toContain(GAME_DAY_NAMESPACE);
    }
  });

  it('writes the rehearsal record only under the objectives\' own parameter paths', () => {
    const conductor = policyDocuments(template).find((policy) =>
      policy.includes('WriteTheRehearsalLog'),
    )!;
    expect(conductor).toContain(rehearsalParameterName('production', OBJECTIVE.id));
    expect(conductor).toContain('ssm:PutParameter');
  });
});

/* ── The verifier ─────────────────────────────────────────────────────────── */

describe('the verifier', () => {
  const template = synth();

  it('runs inside the VPC, which is the only place the copy is reachable from', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: verifierFunctionName('production'),
      VpcConfig: { SubnetIds: Match.anyValue() },
    });
  });

  it('is handed every check, so a check added to the catalogue is a check it runs', () => {
    const variables = functionNamed(template, verifierFunctionName('production')).Environment
      .Variables;
    expect(JSON.parse(variables.CHECKS)).toEqual([...RESTORE_VERIFICATION_CHECKS]);
  });

  it('carries the reason the TLS chain is unvalidated, so the result says so', () => {
    const variables = functionNamed(template, verifierFunctionName('production')).Environment
      .Variables;
    expect(variables.TLS_CHAIN_NOTE).toBe(RESTORE_TLS_CHAIN_UNVERIFIED);
  });

  it('has long enough to wait for a FreeStorageSpace datapoint', () => {
    // The only check that can see an empty restore reads a metric RDS publishes
    // a minute or two after the instance reports available, so the verifier
    // polls rather than treating a missing datapoint as a pass.
    const properties = functionNamed(template, verifierFunctionName('production'));
    const variables = properties.Environment.Variables;
    const polling =
      (Number(variables.STORAGE_POLL_ATTEMPTS) * Number(variables.STORAGE_POLL_INTERVAL_MS)) /
      1000;
    expect(Number(properties.Timeout)).toBeGreaterThan(polling);
  });
});

/* ── The sweeper ──────────────────────────────────────────────────────────── */

describe('the sweeper', () => {
  const template = synth();

  it('runs hourly, against a drill that takes under an hour', () => {
    expect(SWEEPER_INTERVAL_SECONDS).toBe(3600);
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'production-restore-drill-sweeper-schedule',
      ScheduleExpression: 'rate(1 hour)',
    });
  });

  it('will not delete a copy while a drill is running', () => {
    // The one thing worse than an orphaned copy of production is a copy deleted
    // out from under a verification that was still running, reported as a
    // restore that could not be verified.
    const sweeper = policyDocuments(template).find((policy) =>
      policy.includes('ReadDrillExecutions'),
    )!;
    expect(sweeper).toContain('ssm:DescribeAutomationExecutions');
    const variables = functionNamed(template, sweeperFunctionName('production')).Environment
      .Variables;
    expect(JSON.parse(variables.DOCUMENT_NAMES)).toEqual([DOCUMENT_NAME]);
    expect(Number(variables.MAX_AGE_SECONDS)).toBe(MAX_DRILL_INSTANCE_AGE_SECONDS);
  });
});

/* ── The signals ──────────────────────────────────────────────────────────── */

describe('the signals', () => {
  const template = synth();

  it('alarms on a copy that came back wrong, because the execution ends green', () => {
    const unverified = alarm(template, 'production-restore-unverified');
    expect(unverified.MetricName).toBe('RestoreVerified');
    expect(unverified.Threshold).toBe(1);
    expect(unverified.ComparisonOperator).toBe('LessThanThreshold');
    // A drill runs monthly, so most days have no datapoint: absence is the
    // normal state, and "has a drill run recently" has its own alarm.
    expect(unverified.TreatMissingData).toBe('missing');
    expect(unverified.AlarmDescription).toContain('not reset');
  });

  it('alarms on an orphaned copy, and on the sweeper going quiet', () => {
    const orphaned = alarm(template, 'production-restore-drill-instance-orphaned');
    expect(orphaned.Threshold).toBe(MAX_DRILL_INSTANCE_AGE_SECONDS);
    // The sweeper publishes zero when there is no copy, precisely so that
    // missing data means the sweeper has stopped — which is the state in which
    // an orphan runs indefinitely with nothing watching it.
    expect(orphaned.TreatMissingData).toBe('breaching');
    expect(orphaned.AlarmDescription).toContain(COPY);
  });

  it('alarms on each of the three functions failing', () => {
    for (const label of ['verifier', 'conductor', 'sweeper']) {
      expect(alarm(template, `production-restore-drill-${label}-errors`)).toBeDefined();
    }
  });

  it('publishes every alarm to one topic the enricher can subscribe to', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'production-restore-drill',
      KmsMasterKeyId: Match.anyValue(),
    });
    for (const candidate of resourceProps(template, 'AWS::CloudWatch::Alarm')) {
      expect(candidate.AlarmActions).toBeDefined();
    }
  });
});

/* ── The gate, over this stack's own template ─────────────────────────────── */

describe('tools/audit-game-days.ts, over what this stack synthesises', () => {
  const bothTemplates = (props: Partial<BackupRestoreDrillStackProps> = {}) => {
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
      scenarios: props.scenarios,
      objectives: props.objectives,
    });
    const drill = new BackupRestoreDrillStack(app, 'BackupRestoreDrillStack-Test', {
      envName: 'production',
      vpc,
      sourceInstanceIdentifier: 'production-postgres',
      env: { account: '123456789012', region: 'us-east-1' },
      ...props,
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
  });

  it('reports the drill\'s exercises as missing when only the failover stack is read', () => {
    // The direction that proves the rule above is doing something: the
    // catalogue spans two stacks, and a gate reading one of them has to say so
    // rather than passing.
    const [failoverOnly] = bothTemplates();
    const result = auditGameDays({
      templates: [failoverOnly],
      gameDayDoc: DOC_HEADINGS,
    });
    const rules = result.violations.map((violation) => violation.rule);
    expect(rules).toContain('scenario-document-missing');
    expect(rules).toContain('restore-unverified-not-alarmed');
    expect(rules).toContain('drill-sweeper-missing');
  });
});
