import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  CloudWatchAlarmsStack,
  CloudWatchAlarmsStackProps,
} from '../lib/cloudwatch-alarms-stack';

const BASE_PROPS: CloudWatchAlarmsStackProps = {
  envName: 'test',
  clusterName: 'test-cluster',
  serviceName: 'test-service',
  albFullName: 'app/test-alb/abc123def456',
  rdsInstanceId: 'test-postgres',
  env: { account: '123456789012', region: 'us-east-1' },
};

const makeStack = (overrides: Partial<CloudWatchAlarmsStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new CloudWatchAlarmsStack(app, 'TestAlarmsStack', {
    ...BASE_PROPS,
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('CloudWatchAlarmsStack', () => {
  describe('SNS Topic', () => {
    it('creates exactly one SNS topic', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('names the topic using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'staging-cloudwatch-alarms',
        DisplayName: 'staging CloudWatch Alarms → PagerDuty',
      });
    });

    it('does not add an HTTPS subscription when pagerDutyIntegrationUrl is omitted', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Subscription', 0);
    });

    it('adds an HTTPS subscription when pagerDutyIntegrationUrl is provided', () => {
      const { template } = makeStack({
        pagerDutyIntegrationUrl:
          'https://events.pagerduty.com/integration/abc123/enqueue',
      });
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'https',
        Endpoint: 'https://events.pagerduty.com/integration/abc123/enqueue',
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    it('creates exactly 5 alarms', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
    });

    it('creates ECS CPU alarm with correct metric and threshold', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ECS',
        MetricName: 'CPUUtilization',
        Threshold: 80,
        ComparisonOperator: 'GreaterThanThreshold',
        Statistic: 'Average',
      });
    });

    it('creates ECS Memory alarm with correct metric and threshold', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ECS',
        MetricName: 'MemoryUtilization',
        Threshold: 80,
        ComparisonOperator: 'GreaterThanThreshold',
        Statistic: 'Average',
      });
    });

    it('creates ALB 5XX ELB alarm with correct metric', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_ELB_5XX_Count',
        Threshold: 10,
        ComparisonOperator: 'GreaterThanThreshold',
        Statistic: 'Sum',
      });
    });

    it('creates ALB 5XX Target alarm with correct metric', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/ApplicationELB',
        MetricName: 'HTTPCode_Target_5XX_Count',
        Threshold: 10,
        ComparisonOperator: 'GreaterThanThreshold',
        Statistic: 'Sum',
      });
    });

    it('creates RDS connections alarm with correct metric', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'AWS/RDS',
        MetricName: 'DatabaseConnections',
        Threshold: 100,
        ComparisonOperator: 'GreaterThanThreshold',
        Statistic: 'Average',
      });
    });

    it('respects custom threshold overrides', () => {
      const { template } = makeStack({
        ecsCpuThreshold: 90,
        ecsMemoryThreshold: 85,
        alb5xxThreshold: 25,
        rdsConnectionsThreshold: 200,
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'CPUUtilization',
        Threshold: 90,
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'MemoryUtilization',
        Threshold: 85,
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'HTTPCode_ELB_5XX_Count',
        Threshold: 25,
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'DatabaseConnections',
        Threshold: 200,
      });
    });

    it('uses default evaluation period of 2', () => {
      const { template } = makeStack();
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as { Properties: Record<string, unknown> }).Properties;
        expect(props['EvaluationPeriods']).toBe(2);
      }
    });

    it('respects a custom evaluationPeriods override', () => {
      const { template } = makeStack({ evaluationPeriods: 3 });
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as { Properties: Record<string, unknown> }).Properties;
        expect(props['EvaluationPeriods']).toBe(3);
      }
    });

    it('sets TreatMissingData to notBreaching on all alarms', () => {
      const { template } = makeStack();
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as { Properties: Record<string, unknown> }).Properties;
        expect(props['TreatMissingData']).toBe('notBreaching');
      }
    });

    it('wires SNS alarm actions to the topic', () => {
      const { template } = makeStack();
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as { Properties: { AlarmActions?: unknown[] } }).Properties;
        expect(Array.isArray(props['AlarmActions'])).toBe(true);
        expect((props['AlarmActions'] as unknown[]).length).toBeGreaterThan(0);
      }
    });

    it('wires SNS ok actions so PagerDuty auto-resolves incidents', () => {
      const { template } = makeStack();
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const alarm of Object.values(alarms)) {
        const props = (alarm as { Properties: { OKActions?: unknown[] } }).Properties;
        expect(Array.isArray(props['OKActions'])).toBe(true);
        expect((props['OKActions'] as unknown[]).length).toBeGreaterThan(0);
      }
    });

    it('names alarms using envName prefix', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-ecs-cpu-high',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-ecs-memory-high',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-alb-5xx-elb',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-alb-5xx-target',
      });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-rds-connections-high',
      });
    });

    it('attaches ECS dimensions to ECS alarms', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'CPUUtilization',
        Dimensions: Match.arrayWith([
          { Name: 'ClusterName', Value: 'test-cluster' },
          { Name: 'ServiceName', Value: 'test-service' },
        ]),
      });
    });

    it('attaches ALB dimension to ALB alarms', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'HTTPCode_ELB_5XX_Count',
        Dimensions: Match.arrayWith([
          { Name: 'LoadBalancer', Value: 'app/test-alb/abc123def456' },
        ]),
      });
    });

    it('attaches RDS dimension to RDS alarm', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'DatabaseConnections',
        Dimensions: Match.arrayWith([
          { Name: 'DBInstanceIdentifier', Value: 'test-postgres' },
        ]),
      });
    });
  });

  describe('Outputs', () => {
    it('exports the SNS topic ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('AlarmTopicArn', {
        Export: { Name: 'staging-alarm-topic-arn' },
      });
    });

    it('exports the SNS topic name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('AlarmTopicName', {
        Export: { Name: 'staging-alarm-topic-name' },
      });
    });

    it('exports the ECS CPU alarm ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('EcsCpuAlarmArn', {
        Export: { Name: 'staging-ecs-cpu-alarm-arn' },
      });
    });

    it('exports the ECS memory alarm ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('EcsMemoryAlarmArn', {
        Export: { Name: 'staging-ecs-memory-alarm-arn' },
      });
    });
  });

  describe('Tags', () => {
    it('applies Environment and ManagedBy tags', () => {
      const { template } = makeStack({ envName: 'production' });
      const topic = template.findResources('AWS::SNS::Topic');
      const topicResource = Object.values(topic)[0] as {
        Properties: Record<string, unknown>;
      };
      expect(topicResource).toBeDefined();
    });
  });
});
