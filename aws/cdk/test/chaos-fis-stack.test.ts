import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ChaosFisStack, type ChaosFisStackProps } from '../lib/chaos-fis-stack';
import {
  ALB_5XX_STOP_CONDITION,
  CHAOS_EXPERIMENTS,
  LOG_SCHEMA_VERSION,
  PROBE_CONNECT_STOP_CONDITION,
  STOP_CONDITION_SOURCE_ALARM,
  experimentLogGroupName,
  experimentTemplateName,
} from '../lib/fis-experiments';
import { resourceProps } from './support/cfn';

/**
 * Tests for the FIS experiment templates.
 *
 * The properties here are the ones whose absence deploys cleanly: a template
 * that runs to completion with no guardrail, a role that can stop any task in
 * the account, a latency action missing the one parameter without which it
 * cannot run on Fargate, and an AZ target that is either a sixth of the VPC or
 * all of it. None of those fails a deploy, a health check or a synth.
 */

const VPC_CONTEXT = {
  'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};

const ENV = { account: '123456789012', region: 'us-east-1' };

const synthWith = (props: Partial<ChaosFisStackProps> = {}) => {
  const app = new cdk.App({ context: VPC_CONTEXT });
  const networkStack = new cdk.Stack(app, 'Network', { env: ENV });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2, natGateways: 2 });

  const alarmStack = new cdk.Stack(app, 'Alarms', { env: ENV });
  const alarmFor = (name: string, periodSeconds: number): cloudwatch.Alarm =>
    new cloudwatch.Alarm(alarmStack, name, {
      alarmName: `staging-${name}`,
      metric: new cloudwatch.Metric({
        namespace: 'Test',
        metricName: name,
        period: cdk.Duration.seconds(periodSeconds),
      }),
      threshold: 1,
      evaluationPeriods: 2,
    });

  const stack = new ChaosFisStack(app, 'ChaosFisStack-Test', {
    envName: 'staging',
    vpc,
    service: { clusterName: 'staging-cluster', serviceName: 'staging-service' },
    stopConditionAlarms: {
      [PROBE_CONNECT_STOP_CONDITION.alarmName]: alarmFor('db-connect-failing', 60),
      [ALB_5XX_STOP_CONDITION.alarmName]: alarmFor('alb-5xx-elb', 300),
    },
    env: ENV,
    ...props,
  });
  return { stack, vpc, template: Template.fromStack(stack) };
};

const synth = (props: Partial<ChaosFisStackProps> = {}) => synthWith(props).template;

const experiments = (template: Template): Record<string, any>[] =>
  resourceProps(template, 'AWS::FIS::ExperimentTemplate');

const experimentNamed = (template: Template, name: string): Record<string, any> => {
  const found = experiments(template).find((candidate) => candidate.Tags?.Name === name);
  if (found === undefined) throw new Error(`no experiment template tagged Name=${name}`);
  return found;
};

const onlyAction = (experiment: Record<string, any>): Record<string, any> => {
  const actions = Object.values(experiment.Actions) as Record<string, any>[];
  expect(actions).toHaveLength(1);
  return actions[0];
};

const policyDocuments = (template: Template): string[] =>
  Object.values(template.findResources('AWS::IAM::Policy')).map((policy) =>
    JSON.stringify(policy.Properties.PolicyDocument),
  );

describe('coverage', () => {
  it('builds every experiment the catalogue allows in this environment', () => {
    const template = synth();
    expect(experiments(template)).toHaveLength(CHAOS_EXPERIMENTS.length);
    for (const experiment of CHAOS_EXPERIMENTS) {
      expect(() =>
        experimentNamed(template, experimentTemplateName('staging', experiment.id)),
      ).not.toThrow();
    }
  });

  it('leaves out an experiment the catalogue does not allow here', () => {
    const template = synth({ envName: 'production' });
    // The AZ partition is staging-only; the other two are not.
    expect(experiments(template)).toHaveLength(CHAOS_EXPERIMENTS.length - 1);
    expect(
      experiments(template).every((e) => e.Tags?.Experiment !== 'availability-zone-partition'),
    ).toBe(true);
  });

  it('fails synth on an invalid catalogue rather than deploying it', () => {
    expect(() =>
      synth({
        experiments: [{ ...CHAOS_EXPERIMENTS[0], selectionMode: 'ALL' }],
      }),
    ).toThrow(/selection-takes-every-target/);
  });

  it('fails synth when a declared guardrail was not supplied', () => {
    // A missing alarm must not deploy a template with one fewer stop condition
    // than the catalogue says it has — in the console the two look identical.
    expect(() => synth({ stopConditionAlarms: {} })).toThrow(/was not given/);
  });

  it('tags every template with a name, because FIS has no name property', () => {
    for (const experiment of experiments(synth())) {
      expect(typeof experiment.Tags.Name).toBe('string');
      expect(experiment.Tags.Name).toMatch(/^staging-chaos-/);
      expect(experiment.Tags.ManagedBy).toBe('CDK');
      expect(experiment.Tags.Environment).toBe('staging');
    }
  });
});

describe('guardrails', () => {
  it('stops every experiment on CloudWatch alarms, never on FIS none', () => {
    for (const experiment of experiments(synth())) {
      expect(experiment.StopConditions).toHaveLength(2);
      for (const condition of experiment.StopConditions) {
        expect(condition.Source).toBe(STOP_CONDITION_SOURCE_ALARM);
        expect(condition.Value).toBeDefined();
      }
      expect(JSON.stringify(experiment.StopConditions)).not.toContain('"none"');
    }
  });

  it('records which targets resolved, which is the only thing a run cannot reconstruct', () => {
    for (const experiment of experiments(synth())) {
      expect(experiment.LogConfiguration.LogSchemaVersion).toBe(LOG_SCHEMA_VERSION);
      expect(experiment.LogConfiguration.CloudWatchLogsConfiguration).toBeDefined();
    }
  });

  it('encrypts the experiment log group, since new log groups are held to that here', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: experimentLogGroupName('staging'),
      KmsKeyId: Match.anyValue(),
      RetentionInDays: Match.anyValue(),
    });
    // Without this grant the log group fails to create at deploy time with
    // InvalidParameterException — CloudWatch Logs has to be able to use the key.
    const keys = resourceProps(template, 'AWS::KMS::Key');
    expect(JSON.stringify(keys)).toContain('logs.us-east-1.amazonaws.com');
  });

  it('schedules nothing', () => {
    // A `aws:ecs:stop-task` experiment on a cron is an outage nobody chose,
    // arriving at the traffic peak because that is when the cron fired.
    const template = synth();
    expect(Object.keys(template.findResources('AWS::Events::Rule'))).toHaveLength(0);
    expect(Object.keys(template.findResources('AWS::Scheduler::Schedule'))).toHaveLength(0);
  });
});

describe('actions and targets', () => {
  it('points each action at its target under the key that action defines', () => {
    const template = synth();

    const instance = onlyAction(experimentNamed(template, 'staging-chaos-ecs-task-loss'));
    expect(instance.ActionId).toBe('aws:ecs:stop-task');
    expect(Object.keys(instance.Targets)).toEqual(['Tasks']);

    const latency = onlyAction(
      experimentNamed(template, 'staging-chaos-ecs-task-network-latency'),
    );
    expect(latency.ActionId).toBe('aws:ecs:task-network-latency');
    expect(Object.keys(latency.Targets)).toEqual(['Tasks']);

    const az = onlyAction(
      experimentNamed(template, 'staging-chaos-availability-zone-partition'),
    );
    expect(az.ActionId).toBe('aws:network:disrupt-connectivity');
    expect(Object.keys(az.Targets)).toEqual(['Subnets']);
  });

  it('omits parameters for an action that takes none', () => {
    const instance = onlyAction(
      experimentNamed(synth(), 'staging-chaos-ecs-task-loss'),
    );
    expect(instance.Parameters).toBeUndefined();
  });

  it('sets the one parameter without which the latency fault cannot run on Fargate', () => {
    const latency = onlyAction(
      experimentNamed(synth(), 'staging-chaos-ecs-task-network-latency'),
    );
    expect(latency.Parameters).toMatchObject({
      useEcsFaultInjectionEndpoints: 'true',
      delayMilliseconds: '200',
      duration: 'PT5M',
    });
  });

  it('partitions one AZ from the others rather than isolating its subnet', () => {
    const az = onlyAction(
      experimentNamed(synth(), 'staging-chaos-availability-zone-partition'),
    );
    // `all` denies everything to and from the subnet, which takes the game-day
    // probe down with the application and makes the result unreadable.
    expect(az.Parameters.scope).toBe('availability-zone');
  });

  it('selects ECS tasks by cluster and service rather than by tag', () => {
    const experiment = experimentNamed(synth(), 'staging-chaos-ecs-task-loss');
    const target = experiment.Targets['Tasks-Target-1'];
    expect(target.ResourceType).toBe('aws:ecs:task');
    expect(target.SelectionMode).toBe('COUNT(1)');
    expect(target.Parameters).toEqual({
      cluster: 'staging-cluster',
      service: 'staging-service',
    });
    // Tag selection would resolve against whatever carries the tag when the
    // experiment starts, and task tags come from the task definition — so a
    // second service sharing one would join the target set silently.
    expect(target.ResourceTags).toBeUndefined();
  });

  it('targets every subnet of exactly one AZ, named explicitly', () => {
    const { template, vpc } = synthWith();
    const experiment = experimentNamed(template, 'staging-chaos-availability-zone-partition');
    const target = experiment.Targets['Subnets-Target-1'];

    expect(target.ResourceType).toBe('aws:ec2:subnet');
    // `ALL` of a listed set, not COUNT(1) of a tag match: FIS counts resources,
    // and the resource type is a subnet, so COUNT(1) would partition one subnet
    // and the template would still read as "one Availability Zone".
    expect(target.SelectionMode).toBe('ALL');

    const targetAz = vpc.availabilityZones[0];
    const subnetsInTargetAz = [...vpc.publicSubnets, ...vpc.privateSubnets].filter(
      (subnet) => subnet.availabilityZone === targetAz,
    );
    expect(subnetsInTargetAz.length).toBeGreaterThan(1);
    expect(target.ResourceArns).toHaveLength(subnetsInTargetAz.length);
    expect(target.ResourceTags).toBeUndefined();
  });
});

describe('the role, which is the blast radius', () => {
  it('is assumable only by FIS', () => {
    synth().hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'staging-chaos-experiment',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'fis.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  it('attaches no AWS managed FIS policy, which would be account-wide', () => {
    // `AWSFaultInjectionSimulatorECSAccess` permits ecs:StopTask on every task
    // in the account, which makes target selection — editable in the console —
    // the only thing between this role and another team's cluster.
    const roles = resourceProps(synth(), 'AWS::IAM::Role');
    expect(JSON.stringify(roles)).not.toContain('AWSFaultInjectionSimulator');
  });

  it('scopes ecs:StopTask to this cluster rather than to every task', () => {
    const documents = policyDocuments(synth());
    const stopTask = documents.find((document) => document.includes('ecs:StopTask'));
    expect(stopTask).toBeDefined();
    expect(stopTask).toContain('task/staging-cluster/*');
    // The failing shape: `"Action":"ecs:StopTask"` next to `"Resource":"*"`.
    expect(stopTask).not.toMatch(/"ecs:StopTask"[^}]*"Resource":"\*"/);
  });

  it('conditions the network-ACL calls that cannot name a resource', () => {
    const documents = policyDocuments(synth()).join('\n');

    // The ACL does not exist yet, so the create cannot be scoped by ARN alone.
    expect(documents).toContain('ec2:CreateNetworkAcl');
    expect(documents).toContain('aws:RequestTag/managedByFIS');
    // Tags decide what other policies apply, so an unconditioned CreateTags is
    // this repository's own IAM audit finding.
    expect(documents).toContain('ec2:CreateAction');
    // Writing rules into FIS's own ACL and deleting it afterwards are scoped by
    // the tag FIS put on it — neither has a rollback direction to break.
    expect(documents).toContain('ec2:ResourceTag/managedByFIS');
  });

  it('leaves the call that ends the AZ fault unconditioned, on purpose', () => {
    // ReplaceNetworkAclAssociation runs in both directions, and the rollback
    // re-associates the VPC's *original* ACL, which carries no managedByFIS tag.
    // A tag condition here can fail the rollback, and a failed rollback leaves an
    // AZ behind a deny-all ACL until somebody fixes it by hand — the worst thing
    // this stack can produce. Pinned so a future tightening is a test failure.
    const statements = Object.values(synth().findResources('AWS::IAM::Policy'))
      .flatMap((policy) => policy.Properties.PolicyDocument.Statement as any[])
      .filter((statement) =>
        JSON.stringify(statement.Action).includes('ec2:ReplaceNetworkAclAssociation'),
      );

    expect(statements).toHaveLength(1);
    expect(statements[0].Condition).toBeUndefined();
    // Still scoped by ARN: this account and region's ACLs and subnets, not `*`.
    expect(JSON.stringify(statements[0].Resource)).not.toContain('"*"');
  });

  it('writes experiment logs only to the group this stack owns', () => {
    const documents = policyDocuments(synth());
    const writes = documents.find((document) => document.includes('logs:PutLogEvents'));
    expect(writes).toBeDefined();
    expect(writes).not.toMatch(/"logs:PutLogEvents"[^}]*"Resource":"\*"/);
  });

  it('grants no Allow with a wildcard action', () => {
    for (const document of policyDocuments(synth())) {
      expect(document).not.toContain('"Action":"*"');
      expect(document).not.toContain('"ecs:*"');
      expect(document).not.toContain('"ec2:*"');
      expect(document).not.toContain('"iam:PassRole"');
    }
  });
});

describe('outputs', () => {
  it('exports every template id, so starting one does not mean reading the console', () => {
    const template = synth();
    for (const experiment of CHAOS_EXPERIMENTS) {
      template.hasOutput('*', {
        Export: { Name: `staging-chaos-${experiment.id}-template-id` },
      });
    }
    template.hasOutput('*', { Export: { Name: 'staging-chaos-experiment-logs' } });
  });
});
