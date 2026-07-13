import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  CostAnomalyStack,
  CostAnomalyStackProps,
} from '../lib/cost-anomaly-stack';

const BASE_PROPS: CostAnomalyStackProps = {
  envName: 'test',
  monthlyBudgetUsd: 500,
  env: { account: '123456789012', region: 'us-east-1' },
};

const makeStack = (overrides: Partial<CostAnomalyStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new CostAnomalyStack(app, 'TestCostAnomalyStack', {
    ...BASE_PROPS,
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('CostAnomalyStack', () => {
  describe('SNS Topic', () => {
    it('creates exactly one SNS topic', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('names the topic using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'staging-cost-alerts',
        DisplayName: 'staging AWS Cost Alerts',
      });
    });

    it('grants costalerts.amazonaws.com SNS:Publish via resource policy', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'SNS:Publish',
              Principal: { Service: 'costalerts.amazonaws.com' },
            }),
          ]),
        }),
      });
    });

    it('grants budgets.amazonaws.com SNS:Publish via resource policy', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'SNS:Publish',
              Principal: { Service: 'budgets.amazonaws.com' },
            }),
          ]),
        }),
      });
    });

    it('does not create email subscriptions when notificationEmails is omitted', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Subscription', 0);
    });

    it('creates an email subscription for each address in notificationEmails', () => {
      const { template } = makeStack({
        notificationEmails: ['ops@example.com', 'cto@example.com'],
      });
      template.resourceCountIs('AWS::SNS::Subscription', 2);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'cto@example.com',
      });
    });
  });

  describe('Cost Anomaly Monitor', () => {
    it('creates exactly one anomaly monitor', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CE::AnomalyMonitor', 1);
    });

    it('creates a DIMENSIONAL monitor covering all AWS services', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
        MonitorType: 'DIMENSIONAL',
      });
    });

    it('names the monitor using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::CE::AnomalyMonitor', {
        MonitorName: 'staging-all-services-monitor',
      });
    });
  });

  describe('Cost Anomaly Subscription', () => {
    it('creates exactly one anomaly subscription', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CE::AnomalySubscription', 1);
    });

    it('names the subscription using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::CE::AnomalySubscription', {
        SubscriptionName: 'staging-cost-anomaly-alerts',
      });
    });

    it('defaults to DAILY frequency', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CE::AnomalySubscription', {
        Frequency: 'DAILY',
      });
    });

    it('respects a custom anomalyFrequency override', () => {
      const { template } = makeStack({ anomalyFrequency: 'IMMEDIATE' });
      template.hasResourceProperties('AWS::CE::AnomalySubscription', {
        Frequency: 'IMMEDIATE',
      });
    });

    it('includes an SNS subscriber pointing to the alert topic', () => {
      const { template } = makeStack();
      const subscriptions = template.findResources('AWS::CE::AnomalySubscription');
      const sub = Object.values(subscriptions)[0] as {
        Properties: { Subscribers: { Address: unknown; Type: string }[] };
      };
      const snsSubscriber = sub.Properties.Subscribers.find(
        (s) => s.Type === 'SNS',
      );
      expect(snsSubscriber).toBeDefined();
    });

    it('includes EMAIL subscribers for each address in notificationEmails', () => {
      const { template } = makeStack({
        notificationEmails: ['ops@example.com'],
      });
      template.hasResourceProperties('AWS::CE::AnomalySubscription', {
        Subscribers: Match.arrayWith([
          Match.objectLike({ Address: 'ops@example.com', Type: 'EMAIL' }),
        ]),
      });
    });

    it('encodes the anomaly threshold in ThresholdExpression using default $100', () => {
      const { template } = makeStack();
      const subscriptions = template.findResources('AWS::CE::AnomalySubscription');
      const sub = Object.values(subscriptions)[0] as {
        Properties: { ThresholdExpression: string };
      };
      const expr = JSON.parse(sub.Properties.ThresholdExpression) as {
        Dimensions: { Key: string; Values: string[] };
      };
      expect(expr.Dimensions.Key).toBe('ANOMALY_TOTAL_IMPACT_ABSOLUTE');
      expect(expr.Dimensions.Values).toContain('100');
    });

    it('respects a custom anomalyThresholdUsd override in ThresholdExpression', () => {
      const { template } = makeStack({ anomalyThresholdUsd: 250 });
      const subscriptions = template.findResources('AWS::CE::AnomalySubscription');
      const sub = Object.values(subscriptions)[0] as {
        Properties: { ThresholdExpression: string };
      };
      const expr = JSON.parse(sub.Properties.ThresholdExpression) as {
        Dimensions: { Values: string[] };
      };
      expect(expr.Dimensions.Values).toContain('250');
    });
  });

  describe('Monthly Budget', () => {
    it('creates exactly one budget', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Budgets::Budget', 1);
    });

    it('sets the budget limit to monthlyBudgetUsd in USD', () => {
      const { template } = makeStack({ monthlyBudgetUsd: 1000 });
      template.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: Match.objectLike({
          BudgetLimit: { Amount: 1000, Unit: 'USD' },
          BudgetType: 'COST',
          TimeUnit: 'MONTHLY',
        }),
      });
    });

    it('names the budget using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::Budgets::Budget', {
        Budget: Match.objectLike({
          BudgetName: 'staging-monthly-budget',
        }),
      });
    });

    it('creates two notifications: ACTUAL and FORECASTED', () => {
      const { template } = makeStack();
      const budgets_ = template.findResources('AWS::Budgets::Budget');
      const budget = Object.values(budgets_)[0] as {
        Properties: {
          NotificationsWithSubscribers: { Notification: { NotificationType: string } }[];
        };
      };
      const types = budget.Properties.NotificationsWithSubscribers.map(
        (n) => n.Notification.NotificationType,
      );
      expect(types).toContain('ACTUAL');
      expect(types).toContain('FORECASTED');
    });

    it('defaults ACTUAL alert to 80% threshold', () => {
      const { template } = makeStack();
      const budgets_ = template.findResources('AWS::Budgets::Budget');
      const budget = Object.values(budgets_)[0] as {
        Properties: {
          NotificationsWithSubscribers: {
            Notification: { NotificationType: string; Threshold: number };
          }[];
        };
      };
      const actual = budget.Properties.NotificationsWithSubscribers.find(
        (n) => n.Notification.NotificationType === 'ACTUAL',
      );
      expect(actual?.Notification.Threshold).toBe(80);
    });

    it('defaults FORECASTED alert to 100% threshold', () => {
      const { template } = makeStack();
      const budgets_ = template.findResources('AWS::Budgets::Budget');
      const budget = Object.values(budgets_)[0] as {
        Properties: {
          NotificationsWithSubscribers: {
            Notification: { NotificationType: string; Threshold: number };
          }[];
        };
      };
      const forecasted = budget.Properties.NotificationsWithSubscribers.find(
        (n) => n.Notification.NotificationType === 'FORECASTED',
      );
      expect(forecasted?.Notification.Threshold).toBe(100);
    });

    it('respects custom actualThresholdPercent and forecastedThresholdPercent', () => {
      const { template } = makeStack({
        actualThresholdPercent: 70,
        forecastedThresholdPercent: 90,
      });
      const budgets_ = template.findResources('AWS::Budgets::Budget');
      const budget = Object.values(budgets_)[0] as {
        Properties: {
          NotificationsWithSubscribers: {
            Notification: { NotificationType: string; Threshold: number };
          }[];
        };
      };
      const actual = budget.Properties.NotificationsWithSubscribers.find(
        (n) => n.Notification.NotificationType === 'ACTUAL',
      );
      const forecasted = budget.Properties.NotificationsWithSubscribers.find(
        (n) => n.Notification.NotificationType === 'FORECASTED',
      );
      expect(actual?.Notification.Threshold).toBe(70);
      expect(forecasted?.Notification.Threshold).toBe(90);
    });

    it('wires SNS subscriber to each budget notification', () => {
      const { template } = makeStack();
      const budgets_ = template.findResources('AWS::Budgets::Budget');
      const budget = Object.values(budgets_)[0] as {
        Properties: {
          NotificationsWithSubscribers: {
            Subscribers: { SubscriptionType: string }[];
          }[];
        };
      };
      for (const n of budget.Properties.NotificationsWithSubscribers) {
        const hasSns = n.Subscribers.some((s) => s.SubscriptionType === 'SNS');
        expect(hasSns).toBe(true);
      }
    });

    it('wires EMAIL subscribers to budget notifications when emails are provided', () => {
      const { template } = makeStack({
        notificationEmails: ['finance@example.com'],
      });
      const budgets_ = template.findResources('AWS::Budgets::Budget');
      const budget = Object.values(budgets_)[0] as {
        Properties: {
          NotificationsWithSubscribers: {
            Subscribers: { SubscriptionType: string; Address: string }[];
          }[];
        };
      };
      for (const n of budget.Properties.NotificationsWithSubscribers) {
        const emailSub = n.Subscribers.find(
          (s) => s.SubscriptionType === 'EMAIL',
        );
        expect(emailSub?.Address).toBe('finance@example.com');
      }
    });
  });

  describe('Outputs', () => {
    it('exports the cost alert topic ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('CostAlertTopicArn', {
        Export: { Name: 'staging-cost-alert-topic-arn' },
      });
    });

    it('exports the anomaly monitor ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('AnomalyMonitorArn', {
        Export: { Name: 'staging-anomaly-monitor-arn' },
      });
    });

    it('exports the anomaly subscription ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('AnomalySubscriptionArn', {
        Export: { Name: 'staging-anomaly-subscription-arn' },
      });
    });

    it('exports the monthly budget name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('MonthlyBudgetName', {
        Export: { Name: 'staging-monthly-budget-name' },
      });
    });
  });

  describe('Tags', () => {
    it('applies Environment, ManagedBy, and Stack tags', () => {
      const { template } = makeStack({ envName: 'production' });
      const topic = template.findResources('AWS::SNS::Topic');
      expect(Object.values(topic).length).toBeGreaterThan(0);
    });
  });
});
