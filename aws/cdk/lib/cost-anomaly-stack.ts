import * as cdk from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ce from 'aws-cdk-lib/aws-ce';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface CostAnomalyStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** Monthly budget limit in USD — triggers ACTUAL and FORECASTED alerts */
  readonly monthlyBudgetUsd: number;
  /** % of actual spend at which to fire the budget alarm (default: 80) */
  readonly actualThresholdPercent?: number;
  /** % of forecasted spend at which to fire the budget alarm (default: 100) */
  readonly forecastedThresholdPercent?: number;
  /**
   * Absolute USD amount above which a detected cost anomaly triggers a
   * notification (default: 100).  Uses ANOMALY_TOTAL_IMPACT_ABSOLUTE.
   */
  readonly anomalyThresholdUsd?: number;
  /**
   * How often anomaly alert digests are sent.
   * IMMEDIATE — one alert per anomaly (latency ~6 h after anomaly detection).
   * DAILY / WEEKLY — batch digest.
   * Default: DAILY
   */
  readonly anomalyFrequency?: 'DAILY' | 'IMMEDIATE' | 'WEEKLY';
  /**
   * Email addresses to subscribe directly to the alert SNS topic
   * AND as direct-email anomaly subscribers (Cost Explorer sends
   * formatted anomaly summary emails to this list independently of SNS).
   */
  readonly notificationEmails?: string[];
}

/**
 * AWS Cost Anomaly Detection + AWS Budgets alerts.
 *
 * Resources created:
 *   - SNS Topic                   — receives budget and anomaly alerts
 *   - CE AnomalyMonitor           — DIMENSIONAL; watches all AWS services
 *   - CE AnomalySubscription      — fires when anomaly exceeds threshold USD
 *   - Budgets CfnBudget           — monthly cost budget with actual + forecast alerts
 *
 * Both `costalerts.amazonaws.com` and `budgets.amazonaws.com` are granted
 * SNS:Publish on the alert topic via a topic resource policy so that neither
 * service requires a separate IAM role in your account.
 *
 * NOTE: Cost Anomaly Detection resources are global and must be deployed in
 * us-east-1 for the anomaly monitor to work correctly.
 */
export class CostAnomalyStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;
  public readonly anomalyMonitor: ce.CfnAnomalyMonitor;
  public readonly anomalySubscription: ce.CfnAnomalySubscription;
  public readonly monthlyBudget: budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: CostAnomalyStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const actualThresholdPercent = props.actualThresholdPercent ?? 80;
    const forecastedThresholdPercent = props.forecastedThresholdPercent ?? 100;
    const anomalyThresholdUsd = props.anomalyThresholdUsd ?? 100;
    const anomalyFrequency = props.anomalyFrequency ?? 'DAILY';
    const notificationEmails = props.notificationEmails ?? [];

    // ── SNS Topic ────────────────────────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'CostAlertTopic', {
      topicName: `${envName}-cost-alerts`,
      displayName: `${envName} AWS Cost Alerts`,
    });

    // Cost Anomaly Detection needs permission to publish anomaly events.
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCostAnomalyPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('costalerts.amazonaws.com')],
        actions: ['SNS:Publish'],
        resources: [this.alertTopic.topicArn],
      }),
    );

    // AWS Budgets needs permission to publish budget breach events.
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowBudgetsPublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
        actions: ['SNS:Publish'],
        resources: [this.alertTopic.topicArn],
      }),
    );

    for (const email of notificationEmails) {
      this.alertTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── Cost Anomaly Monitor ─────────────────────────────────────────────────
    // DIMENSIONAL type monitors every AWS service in the account automatically.
    // No additional configuration is needed; new services are picked up as spend appears.
    this.anomalyMonitor = new ce.CfnAnomalyMonitor(this, 'AnomalyMonitor', {
      monitorName: `${envName}-all-services-monitor`,
      monitorType: 'DIMENSIONAL',
    });

    // ── Cost Anomaly Subscription ────────────────────────────────────────────
    // Fires when the detected anomaly exceeds anomalyThresholdUsd in absolute USD.
    // Uses ThresholdExpression (the non-deprecated path) over the legacy Threshold number.
    const anomalySubscribers: ce.CfnAnomalySubscription.SubscriberProperty[] = [
      { address: this.alertTopic.topicArn, type: 'SNS' },
      ...notificationEmails.map(
        (email): ce.CfnAnomalySubscription.SubscriberProperty => ({
          address: email,
          type: 'EMAIL',
        }),
      ),
    ];

    this.anomalySubscription = new ce.CfnAnomalySubscription(
      this,
      'AnomalySubscription',
      {
        subscriptionName: `${envName}-cost-anomaly-alerts`,
        frequency: anomalyFrequency,
        monitorArnList: [this.anomalyMonitor.attrMonitorArn],
        subscribers: anomalySubscribers,
        thresholdExpression: JSON.stringify({
          Dimensions: {
            Key: 'ANOMALY_TOTAL_IMPACT_ABSOLUTE',
            MatchOptions: ['GREATER_THAN_OR_EQUAL'],
            Values: [`${anomalyThresholdUsd}`],
          },
        }),
      },
    );

    // ── Monthly Budget ───────────────────────────────────────────────────────
    // Two notifications: one for actual spend crossing actualThresholdPercent,
    // one for forecasted spend crossing forecastedThresholdPercent.
    const budgetSubscribers: budgets.CfnBudget.SubscriberProperty[] = [
      { address: this.alertTopic.topicArn, subscriptionType: 'SNS' },
      ...notificationEmails.map(
        (email): budgets.CfnBudget.SubscriberProperty => ({
          address: email,
          subscriptionType: 'EMAIL',
        }),
      ),
    ];

    this.monthlyBudget = new budgets.CfnBudget(this, 'MonthlyBudget', {
      budget: {
        budgetName: `${envName}-monthly-budget`,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: {
          amount: props.monthlyBudgetUsd,
          unit: 'USD',
        },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: 'ACTUAL',
            comparisonOperator: 'GREATER_THAN',
            threshold: actualThresholdPercent,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: budgetSubscribers,
        },
        {
          notification: {
            notificationType: 'FORECASTED',
            comparisonOperator: 'GREATER_THAN',
            threshold: forecastedThresholdPercent,
            thresholdType: 'PERCENTAGE',
          },
          subscribers: budgetSubscribers,
        },
      ],
    });

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'CostAlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for cost anomaly and budget alerts',
      exportName: `${envName}-cost-alert-topic-arn`,
    });

    new cdk.CfnOutput(this, 'AnomalyMonitorArn', {
      value: this.anomalyMonitor.attrMonitorArn,
      description: 'ARN of the Cost Anomaly Monitor (all AWS services)',
      exportName: `${envName}-anomaly-monitor-arn`,
    });

    new cdk.CfnOutput(this, 'AnomalySubscriptionArn', {
      value: this.anomalySubscription.attrSubscriptionArn,
      description: 'ARN of the Cost Anomaly Subscription',
      exportName: `${envName}-anomaly-subscription-arn`,
    });

    new cdk.CfnOutput(this, 'MonthlyBudgetName', {
      value: `${envName}-monthly-budget`,
      description: 'Name of the monthly AWS Budget',
      exportName: `${envName}-monthly-budget-name`,
    });
  }
}
