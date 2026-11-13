import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as sns from 'aws-cdk-lib/aws-sns';
import {
  ACCOUNT_SCOPE,
  ATTRIBUTED_COST_METRIC,
  COST_ALLOCATION_METRIC_NAMESPACE,
  COST_METRIC,
  CostAllocationStack,
  type CostAllocationStackProps,
  DEFAULT_UNATTRIBUTED_SHARE_PERCENT,
  REPORT_SUCCESS_METRIC,
  SCOPE_DIMENSION,
  TAG_ACTIVATED_METRIC,
  TAG_KEY_DIMENSION,
  UNATTRIBUTED_COST_METRIC,
  UNATTRIBUTED_SHARE_METRIC,
} from '../lib/cost-allocation-stack';
import { GOVERNED_TAGS, costAllocationTagKeys } from '../lib/tagging-policy';
import { flattenIntrinsic, outputByExportName, resourceProps } from './support/cfn';

/**
 * Tests for the cost-allocation reporter's infrastructure and its dashboard.
 *
 * The properties asserted here are the ones whose absence deploys cleanly and
 * reads as a working dashboard: a role holding the API that activates a cost
 * allocation tag, which would let the reporter make its own coverage metric go
 * green; a staleness alarm that tolerates missing data, which is green through
 * the outage where the report stopped running; cost series read as SUM, which
 * doubles the bill on the chart whenever a retry succeeds; and a cost widget
 * with no untagged series, which is a chart on which everything is attributed.
 */

const ENV = { account: '123456789012', region: 'us-east-1' };

const synthWith = (props: Partial<CostAllocationStackProps> = {}) => {
  const app = new cdk.App();
  const topicStack = new cdk.Stack(app, 'Topics', { env: ENV });
  const alarmTopic = new sns.Topic(topicStack, 'AlarmTopic', {
    topicName: 'production-cloudwatch-alarms',
  });

  const stack = new CostAllocationStack(app, 'CostAllocationStack-Test', {
    alarmTopic,
    env: ENV,
    ...props,
  });
  return { stack, template: Template.fromStack(stack) };
};

/**
 * The dashboard body as CloudWatch will see it.
 *
 * `DashboardBody` synthesises to an `Fn::Join` around a `Ref` for the region,
 * so the raw property is a nest of intrinsics and every assertion written
 * against the obvious string form silently never matches.
 */
const dashboardBody = (template: Template): string =>
  flattenIntrinsic(resourceProps(template, 'AWS::CloudWatch::Dashboard')[0].DashboardBody);

describe('CostAllocationStack', () => {
  describe('props it refuses', () => {
    it('refuses a catalogue with nothing activated for cost allocation', () => {
      expect(() =>
        synthWith({
          governedTags: GOVERNED_TAGS.map((tag) => ({
            ...tag,
            costAllocation: 'not-activated' as const,
            note: tag.note ?? 'test',
          })),
        }),
      ).toThrow(/no tag in the catalogue is activated/i);
    });

    // A staleness window no longer than the schedule alarms on the gap between
    // two healthy reports, which is a ticket a day for a working integration.
    it('refuses a staleness window no longer than the schedule', () => {
      expect(() => synthWith({ reportScheduleHours: 24, reportStaleHours: 24 })).toThrow(
        /must exceed reportScheduleHours/,
      );
    });

    // Cost Explorer takes a half-open interval, so a zero-day window asks for no
    // days and returns an empty result that reads as zero spend.
    it('refuses a window of less than a day', () => {
      expect(() => synthWith({ lookbackDays: 0 })).toThrow(/at least 1/);
    });

    it('refuses a catalogue that cannot generate a valid policy', () => {
      expect(() =>
        synthWith({
          governedTags: [
            {
              key: 'Environment',
              purpose: 'test',
              enforcement: 'deny-bad-value',
              costAllocation: 'activated',
              allowedValues: undefined,
            },
          ],
        }),
      ).toThrow(/Invalid tagging policy/);
    });
  });

  describe('the reporter', () => {
    const { template } = synthWith();

    it('runs on a supported runtime, on arm64, one at a time', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        ReservedConcurrentExecutions: 1,
      });
    });

    // Two concurrent reports would publish two sets of datapoints for one
    // window.
    it('sends undelivered schedules to a dead-letter queue', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        DeadLetterConfig: { TargetArn: Match.anyValue() },
      });
      template.hasResourceProperties('AWS::SQS::Queue', {
        KmsMasterKeyId: Match.anyValue(),
      });
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({ DeadLetterConfig: { Arn: Match.anyValue() } }),
        ]),
      });
    });

    it('retains its log group rather than keeping logs forever', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        RetentionInDays: 30,
      });
    });

    // A role that could activate a cost allocation tag could make its own
    // coverage metric go green.
    it('holds two Cost Explorer reads and no write', () => {
      const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
        (policy) =>
          (policy.Properties as { PolicyDocument: { Statement: Record<string, unknown>[] } })
            .PolicyDocument.Statement,
      );

      const costExplorer = statements.find((statement) => statement.Sid === 'ReadCostAllocationData');
      expect(costExplorer?.Action).toEqual(['ce:GetCostAndUsage', 'ce:ListCostAllocationTags']);

      const serialised = JSON.stringify(statements);
      expect(serialised).not.toContain('UpdateCostAllocationTagsStatus');
      expect(serialised).not.toContain('ce:Create');
    });

    it('scopes PutMetricData to this stack’s namespace', () => {
      const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
        (policy) =>
          (policy.Properties as { PolicyDocument: { Statement: Record<string, unknown>[] } })
            .PolicyDocument.Statement,
      );
      const publish = statements.find(
        (statement) => statement.Sid === 'PublishCostAllocationMetrics',
      );
      expect(publish?.Condition).toEqual({
        StringEquals: { 'cloudwatch:namespace': COST_ALLOCATION_METRIC_NAMESPACE },
      });
    });

    it('passes only the activated keys to the handler', () => {
      const functions = resourceProps(template, 'AWS::Lambda::Function');
      const environment = functions[0].Environment as { Variables: Record<string, string> };
      const catalogue = JSON.parse(environment.Variables.TAG_CATALOGUE) as { key: string }[];
      expect(catalogue.map((entry) => entry.key)).toEqual(costAllocationTagKeys());
    });
  });

  describe('the alarms', () => {
    const { template } = synthWith();

    it('alarms on every activated key not being activated in Billing', () => {
      for (const key of costAllocationTagKeys()) {
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          AlarmName: `cost-allocation-tag-not-activated-${key.toLowerCase()}`,
          MetricName: TAG_ACTIVATED_METRIC,
          Dimensions: [{ Name: TAG_KEY_DIMENSION, Value: key }],
          ComparisonOperator: 'LessThanThreshold',
          Threshold: 1,
        });
      }
    });

    it('alarms on the untagged share against a non-zero ceiling', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'cost-allocation-unattributed-environment',
        MetricName: UNATTRIBUTED_SHARE_METRIC,
        Threshold: DEFAULT_UNATTRIBUTED_SHARE_PERCENT,
        ComparisonOperator: 'GreaterThanThreshold',
      });
      expect(DEFAULT_UNATTRIBUTED_SHARE_PERCENT).toBeGreaterThan(0);
    });

    it('takes a per-key ceiling', () => {
      const { template: tuned } = synthWith({
        unattributedSharePercent: { Environment: 5 },
      });
      tuned.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'cost-allocation-unattributed-environment',
        Threshold: 5,
      });
      tuned.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'cost-allocation-unattributed-project',
        Threshold: DEFAULT_UNATTRIBUTED_SHARE_PERCENT,
      });
    });

    // Absence has exactly one alarm, so one cause makes one ticket rather than
    // 2n + 1 of them.
    it('treats missing data as breaching on the staleness alarm and nowhere else', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'cost-allocation-report-stale',
        MetricName: REPORT_SUCCESS_METRIC,
        Dimensions: [{ Name: SCOPE_DIMENSION, Value: ACCOUNT_SCOPE }],
        TreatMissingData: 'breaching',
      });

      const breaching = Object.values(template.findResources('AWS::CloudWatch::Alarm')).filter(
        (alarm) =>
          (alarm.Properties as { TreatMissingData?: string }).TreatMissingData === 'breaching',
      );
      expect(breaching).toHaveLength(1);
    });

    it('alarms on the reporter throwing and on an undelivered schedule', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'cost-allocation-reporter-errors',
        MetricName: 'Errors',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'cost-allocation-report-undelivered',
        MetricName: 'ApproximateNumberOfMessagesVisible',
      });
    });

    it('sends every alarm to the shared topic rather than a new one', () => {
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      for (const alarm of alarms) {
        expect((alarm.Properties as { AlarmActions?: unknown[] }).AlarmActions).toHaveLength(1);
      }
      template.resourceCountIs('AWS::SNS::Topic', 0);
    });
  });

  describe('the dashboard', () => {
    const { template } = synthWith();
    const body = dashboardBody(template);

    it('draws one series per declared value of every activated key', () => {
      for (const key of costAllocationTagKeys()) {
        const tag = GOVERNED_TAGS.find((candidate) => candidate.key === key);
        for (const value of tag?.allowedValues ?? []) {
          expect(body).toContain(`"TagValue","${value}"`);
        }
      }
    });

    // The one series on the cost widgets that is supposed to shrink. A widget
    // without it is a chart on which everything is attributed.
    it('draws the untagged slice on every cost widget', () => {
      expect(body).toContain(UNATTRIBUTED_COST_METRIC);
      expect(body).toContain(ATTRIBUTED_COST_METRIC);
    });

    // Each run republishes the same trailing window, so summing two runs in one
    // period doubles the bill on the chart every time a retry succeeds.
    it('reads every cost series as a maximum, never a sum', () => {
      expect(body).toContain('"stat":"Maximum"');
      expect(body).not.toContain('"stat":"Sum"');
    });

    it('leads with the untagged share and the instrument health', () => {
      expect(body).toContain(UNATTRIBUTED_SHARE_METRIC);
      expect(body).toContain(TAG_ACTIVATED_METRIC);
      expect(body).toContain('UnexpectedTagValue');
    });

    // The single fact that makes a correct, empty widget look like a broken one.
    it('says on the dashboard itself that activation is not retroactive', () => {
      expect(body).toContain('not');
      expect(body).toContain('retroactive');
      expect(body).toContain('management account');
    });

    it('names the cost metric it is drawing', () => {
      expect(body).toContain(COST_METRIC);
    });
  });

  describe('tags and outputs', () => {
    const { template } = synthWith();

    // Cost Explorer answers per account, so this stack spans both environments
    // and has no true Environment value — the same exemption the rego pack
    // records for the other account-scoped stacks.
    it('carries ManagedBy and Stack and no Environment', () => {
      const queue = resourceProps(template, 'AWS::SQS::Queue')[0];
      const tags = (queue.Tags ?? []) as { Key: string; Value: string }[];
      const keys = tags.map((entry) => entry.Key);
      expect(keys).toContain('ManagedBy');
      expect(keys).toContain('Stack');
      expect(keys).not.toContain('Environment');
    });

    it('exports the keys the account must have activated', () => {
      const output = outputByExportName(template, 'CostAllocationStack-Test-tag-keys');
      expect(output?.Value).toBe(costAllocationTagKeys().join(','));
      expect(String(output?.Description)).toMatch(/not retroactive/i);
    });

    it('exports the namespace, the dashboard link, and the dead-letter queue', () => {
      expect(outputByExportName(template, 'CostAllocationStack-Test-metric-namespace')?.Value).toBe(
        COST_ALLOCATION_METRIC_NAMESPACE,
      );
      expect(
        outputByExportName(template, 'CostAllocationStack-Test-dashboard-url'),
      ).toBeDefined();
      expect(
        outputByExportName(template, 'CostAllocationStack-Test-reporter-dlq-url'),
      ).toBeDefined();
    });
  });
});
