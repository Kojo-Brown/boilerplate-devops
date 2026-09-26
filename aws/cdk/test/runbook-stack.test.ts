import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import { RunbookDefinition, firstStepDocumentName } from '../lib/runbooks';
import { ENRICHED_TOPIC_SUFFIX, RunbookStack, RunbookStackProps } from '../lib/runbook-stack';
import { flattenIntrinsic, outputByExportName, resourceProps } from './support/cfn';

/**
 * What the stack actually synthesises.
 *
 * Most of these assert a property whose absence is invisible: a document
 * parameter with no default reads as configured until someone runs it, and a
 * subscription that was never created reads as an alarm that has not fired.
 */

const CATALOGUE: RunbookDefinition[] = [
  {
    id: 'api-5xx',
    title: 'The API is returning 5xx',
    owner: 'platform-team',
    anchor: '#2-the-api-is-returning-5xx',
    alarmNamePatterns: ['*-alb-5xx-*'],
    summary: 'Requests are failing.',
    firstStep: {
      documentKey: 'ecs-service-state',
      summary: 'reads the ECS service',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'platform-tooling',
    title: 'A platform component has stopped reporting',
    owner: 'platform-team',
    anchor: '#9-a-platform-component-has-stopped-reporting',
    alarmNamePatterns: ['*-errors'],
    summary: 'Something that measures the platform has failed.',
    firstStep: {
      documentKey: 'alarm-history',
      summary: 'reads the alarm history',
      alarmFilledParameters: ['AlarmName'],
    },
  },
];

interface Harness {
  readonly stack: RunbookStack;
  readonly template: Template;
}

const synth = (overrides: Partial<RunbookStackProps> = {}): Harness => {
  const app = new cdk.App();
  const producer = new cdk.Stack(app, 'ProducerStack', {
    env: { account: '111122223333', region: 'us-east-1' },
  });
  const alarmTopic = new sns.Topic(producer, 'AlarmTopic', { topicName: 'test-cloudwatch-alarms' });

  const stack = new RunbookStack(app, 'RunbookStack-Test', {
    envName: 'test',
    alarmTopics: [alarmTopic],
    service: { clusterName: 'test-cluster', serviceName: 'test-service' },
    databaseInstanceIdentifier: 'test-postgres',
    logDeliveryStreamName: 'test-log-pipeline',
    catalogue: CATALOGUE,
    env: { account: '111122223333', region: 'us-east-1' },
    ...overrides,
  });

  return { stack, template: Template.fromStack(stack) };
};

describe('first-step documents', () => {
  it('creates one Automation document per key the catalogue needs', () => {
    const { template } = synth();
    const names = resourceProps(template, 'AWS::SSM::Document').map((props) => props.Name);
    expect(names).toEqual(expect.arrayContaining([
      firstStepDocumentName('test', 'ecs-service-state'),
      firstStepDocumentName('test', 'alarm-history'),
    ]));
  });

  it('gives every parameter a default except the ones filled from the alarm', () => {
    const { template } = synth();
    for (const props of resourceProps(template, 'AWS::SSM::Document')) {
      const content = props.Content as { parameters: Record<string, { default?: unknown }> };
      for (const [name, parameter] of Object.entries(content.parameters)) {
        if (name === 'AlarmName') {
          // The one parameter the enricher supplies. A default here would be a
          // lie: whichever alarm it named, every other alarm's first step would
          // read that one's history.
          expect(parameter).not.toHaveProperty('default');
          continue;
        }
        expect(parameter).toHaveProperty('default');
      }
    }
  });

  it('bakes the environment\'s real resource names into those defaults', () => {
    const { template } = synth();
    const byName = new Map(
      resourceProps(template, 'AWS::SSM::Document').map((props) => [props.Name as string, props]),
    );
    const parameters = (key: string) =>
      (byName.get(firstStepDocumentName('test', key))!.Content as {
        parameters: Record<string, { default?: string }>;
      }).parameters;

    expect(parameters('ecs-service-state').ClusterName.default).toBe('test-cluster');
    expect(parameters('ecs-service-state').ServiceName.default).toBe('test-service');
    expect(parameters('rds-instance-state').DBInstanceIdentifier.default).toBe('test-postgres');
    expect(parameters('log-delivery-state').DeliveryStreamName.default).toBe('test-log-pipeline');
    expect(parameters('environment-alarm-state').AlarmNamePrefix.default).toBe('test-');
  });

  it('makes every step a single read-only API call', () => {
    const { template } = synth();
    for (const props of resourceProps(template, 'AWS::SSM::Document')) {
      const content = props.Content as {
        mainSteps: { action: string; inputs: { Api: string } }[];
      };
      expect(content.mainSteps).toHaveLength(1);
      expect(content.mainSteps[0].action).toBe('aws:executeAwsApi');
      expect(content.mainSteps[0].inputs.Api).toMatch(/^(Describe|Get|List)/);
    }
  });

  it('assumes a role that can only read', () => {
    const { template } = synth();
    const policies = resourceProps(template, 'AWS::IAM::Policy').filter((props) =>
      JSON.stringify(props.PolicyDocument).includes('ReadEcsServiceState'),
    );
    expect(policies).toHaveLength(1);

    const statements = (policies[0].PolicyDocument as { Statement: { Action: unknown }[] })
      .Statement;
    const actions = statements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(String(action)).toMatch(/:(Describe|Get|List)/);
    }
  });

  it('publishes a new document version rather than leaving the old one default', () => {
    const { template } = synth();
    for (const props of resourceProps(template, 'AWS::SSM::Document')) {
      expect(props.UpdateMethod).toBe('NewVersion');
    }
  });
});

describe('the enricher', () => {
  it('subscribes to every alarm topic it was given', () => {
    const { template } = synth();
    template.resourceCountIs('AWS::SNS::Subscription', 1);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
    });
  });

  it('has a dead-letter queue, because a lost notification is a lost alert', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'test-runbook-enricher',
      DeadLetterConfig: { TargetArn: Match.anyValue() },
    });
  });

  it('bounds its own concurrency so an alarm storm cannot take the account\'s pool', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'test-runbook-enricher',
      ReservedConcurrentExecutions: 10,
    });
  });

  it('can start only the documents this stack owns', () => {
    const { template } = synth();
    const statements = resourceProps(template, 'AWS::IAM::Policy')
      .flatMap(
        (props) => (props.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
      )
      .filter((statement) => JSON.stringify(statement.Action).includes('StartAutomationExecution'));

    expect(statements).toHaveLength(1);
    const resources = (statements[0].Resource as unknown[]).map(flattenIntrinsic);
    expect(resources).toHaveLength(5);
    for (const resource of resources) {
      expect(resource).toContain(':automation-definition/test-rb-');
      // The version qualifier. `UpdateMethod: NewVersion` moves it on every
      // change, and a grant without it stops matching the first time a document
      // is edited — which surfaces as an alert with no automation on it.
      expect(resource.endsWith(':*')).toBe(true);
    }
  });

  it('can pass the automation role to SSM and to nothing else', () => {
    const { template } = synth();
    const statement = resourceProps(template, 'AWS::IAM::Policy')
      .flatMap(
        (props) => (props.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement,
      )
      .find((entry) => JSON.stringify(entry.Action).includes('iam:PassRole'));

    expect(statement?.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' },
    });
  });

  it('carries the whole catalogue, so matching needs no lookup at alarm time', () => {
    const { template } = synth();
    const properties = template.findResources('AWS::Lambda::Function');
    const environment = Object.values(properties)[0].Properties.Environment.Variables;
    const runbooks = JSON.parse(environment.RUNBOOKS);

    expect(runbooks).toHaveLength(CATALOGUE.length);
    expect(runbooks[0].firstStep.documentName).toBe(
      firstStepDocumentName('test', 'ecs-service-state'),
    );
    expect(runbooks[0].url).toContain('docs/runbooks.md#2-the-api-is-returning-5xx');
    expect(runbooks[1].firstStep.alarmFilledParameters).toEqual(['AlarmName']);
    expect(environment.ALERT_TOPIC_ARN).toBeDefined();
  });

  it('uses the docBaseUrl it was given, for a consumer with a docs site', () => {
    const { template } = synth({ docBaseUrl: 'https://docs.invalid/handbook' });
    const properties = template.findResources('AWS::Lambda::Function');
    const environment = Object.values(properties)[0].Properties.Environment.Variables;
    expect(JSON.parse(environment.RUNBOOKS)[0].url).toBe(
      'https://docs.invalid/handbook/docs/runbooks.md#2-the-api-is-returning-5xx',
    );
  });
});

describe('the enriched topic', () => {
  it('is where enriched alerts land, and is exported for the rota', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: `test-${ENRICHED_TOPIC_SUFFIX}`,
    });
    expect(outputByExportName(template, 'test-runbook-alert-topic-arn')).toBeDefined();
  });

  it('takes the enricher\'s own failure alarm directly, unenriched', () => {
    const { template } = synth();
    const alarms = resourceProps(template, 'AWS::CloudWatch::Alarm');
    expect(alarms).toHaveLength(1);
    expect(alarms[0].AlarmName).toBe('test-runbook-enricher-errors');
    // Publishing straight to the enriched topic is the point: the component that
    // would enrich this alarm is the one that has failed, so an unenriched
    // message arriving there is itself the signal.
    expect(flattenIntrinsic((alarms[0].AlarmActions as unknown[])[0])).toContain('<token>');
    expect(alarms[0].TreatMissingData).toBe('notBreaching');
  });

  it('carries the runbook link in the one alarm description this stack owns', () => {
    const { template } = synth();
    const [alarm] = resourceProps(template, 'AWS::CloudWatch::Alarm');
    expect(alarm.AlarmDescription).toContain(
      'docs/runbooks.md#9-a-platform-component-has-stopped-reporting',
    );
  });

  it('lets CloudWatch use the key, which an AWS-managed one would not need', () => {
    const { template } = synth();
    const [key] = resourceProps(template, 'AWS::KMS::Key');
    const statements = (key.KeyPolicy as { Statement: Record<string, any>[] }).Statement;
    const forCloudWatch = statements.find((statement) => statement.Sid === 'AllowCloudWatchAlarmsToPublish');
    expect(forCloudWatch?.Principal).toEqual({ Service: 'cloudwatch.amazonaws.com' });
    expect(forCloudWatch?.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': '111122223333' },
    });
  });
});

describe('tags', () => {
  it('tags every resource, which policy/cloudformation/required-tags.rego enforces', () => {
    const { template } = synth();
    // The roles, the key and the queue are the ones the `tags` stack prop does
    // not reach, and an untagged resource is unattributable in an account sweep.
    for (const type of [
      'AWS::IAM::Role',
      'AWS::KMS::Key',
      'AWS::SQS::Queue',
      'AWS::SNS::Topic',
      'AWS::Lambda::Function',
      'AWS::Logs::LogGroup',
    ]) {
      for (const props of resourceProps(template, type)) {
        const tags = (props.Tags as { Key: string; Value: string }[]) ?? [];
        expect(tags.map((tag) => tag.Key)).toEqual(
          expect.arrayContaining(['Environment', 'ManagedBy', 'Stack']),
        );
      }
    }
  });
});

describe('what the stack refuses to build', () => {
  it('rejects a catalogue whose first step names a document it does not create', () => {
    expect(() =>
      synth({
        catalogue: [
          {
            ...CATALOGUE[0],
            firstStep: { ...CATALOGUE[0].firstStep, documentKey: 'restart-everything' },
          },
        ],
      }),
    ).toThrow(/restart-everything/);
  });

  it('rejects an invalid catalogue rather than synthesising around it', () => {
    expect(() => synth({ catalogue: [{ ...CATALOGUE[0], owner: 'alex@example.com' }] })).toThrow(
      /owner-is-an-individual/,
    );
  });

  it('rejects an empty topic list, which would pass every rule and reach nobody', () => {
    expect(() => synth({ alarmTopics: [] })).toThrow(/alarmTopics is empty/);
  });
});
