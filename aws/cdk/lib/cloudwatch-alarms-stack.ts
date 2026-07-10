import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface CloudWatchAlarmsStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** ECS cluster name — use EcsStack.cluster.clusterName */
  readonly clusterName: string;
  /** ECS service name — use EcsStack.service.serviceName */
  readonly serviceName: string;
  /**
   * ALB full name (the load balancer dimension for AWS/ApplicationELB).
   * Obtain from EcsStack.alb.loadBalancerFullName — resolves to "app/<name>/<id>".
   */
  readonly albFullName: string;
  /** RDS instance identifier — use RdsStack.instance.instanceIdentifier */
  readonly rdsInstanceId: string;
  /**
   * PagerDuty Events API v2 HTTPS endpoint for this service integration.
   * Format: https://events.pagerduty.com/integration/<serviceKey>/enqueue
   * Leave undefined to create the topic without an HTTPS subscription.
   */
  readonly pagerDutyIntegrationUrl?: string;
  /** ECS CPU utilization alarm threshold in percent (default: 80) */
  readonly ecsCpuThreshold?: number;
  /** ECS memory utilization alarm threshold in percent (default: 80) */
  readonly ecsMemoryThreshold?: number;
  /** ALB 5XX count alarm threshold per evaluation period (default: 10) */
  readonly alb5xxThreshold?: number;
  /** RDS database connections alarm threshold (default: 100) */
  readonly rdsConnectionsThreshold?: number;
  /** Metric evaluation period in minutes (default: 5) */
  readonly periodMinutes?: number;
  /** Number of consecutive breaching periods before alarm fires (default: 2) */
  readonly evaluationPeriods?: number;
}

/**
 * CloudWatch Alarms wired to an SNS topic → PagerDuty for incident management.
 *
 * Alarms created:
 *   - ECS CPU Utilization    (default: Average > 80 % for 2 × 5 min)
 *   - ECS Memory Utilization (default: Average > 80 % for 2 × 5 min)
 *   - ALB 5XX Errors ELB     (default: Sum > 10 per 5 min for 2 periods)
 *   - ALB 5XX Errors Target  (default: Sum > 10 per 5 min for 2 periods)
 *   - RDS Database Connections (default: Average > 100 for 2 × 5 min)
 *
 * Every alarm sends both ALARM and OK actions to the SNS topic so that
 * PagerDuty can auto-resolve incidents when metrics recover.
 *
 * If pagerDutyIntegrationUrl is provided, an HTTPS subscription is added to
 * the topic so alarms flow to PagerDuty automatically. Otherwise wire the
 * subscription manually after deployment.
 */
export class CloudWatchAlarmsStack extends cdk.Stack {
  public readonly alarmTopic: sns.Topic;

  public readonly alarms: {
    readonly ecsCpu: cloudwatch.Alarm;
    readonly ecsMemory: cloudwatch.Alarm;
    readonly alb5xxElb: cloudwatch.Alarm;
    readonly alb5xxTarget: cloudwatch.Alarm;
    readonly rdsConnections: cloudwatch.Alarm;
  };

  constructor(scope: Construct, id: string, props: CloudWatchAlarmsStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const period = cdk.Duration.minutes(props.periodMinutes ?? 5);
    const evaluationPeriods = props.evaluationPeriods ?? 2;

    const ecsCpuThreshold = props.ecsCpuThreshold ?? 80;
    const ecsMemoryThreshold = props.ecsMemoryThreshold ?? 80;
    const alb5xxThreshold = props.alb5xxThreshold ?? 10;
    const rdsConnectionsThreshold = props.rdsConnectionsThreshold ?? 100;

    // ── Dimension maps ───────────────────────────────────────────────────────
    const ecsDimensions = {
      ClusterName: props.clusterName,
      ServiceName: props.serviceName,
    };
    const albDimensions = { LoadBalancer: props.albFullName };
    const rdsDimensions = { DBInstanceIdentifier: props.rdsInstanceId };

    // ── SNS Topic ────────────────────────────────────────────────────────────
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${envName}-cloudwatch-alarms`,
      displayName: `${envName} CloudWatch Alarms → PagerDuty`,
    });

    if (props.pagerDutyIntegrationUrl !== undefined) {
      this.alarmTopic.addSubscription(
        new sns_sub.UrlSubscription(props.pagerDutyIntegrationUrl, {
          protocol: sns.SubscriptionProtocol.HTTPS,
        }),
      );
    }

    const snsAction = new cw_actions.SnsAction(this.alarmTopic);

    // ── Helper ───────────────────────────────────────────────────────────────
    const makeAlarm = (
      metricId: string,
      metric: cloudwatch.Metric,
      threshold: number,
      comparisonOperator: cloudwatch.ComparisonOperator,
      alarmDescription: string,
    ): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, metricId, {
        metric,
        threshold,
        evaluationPeriods,
        comparisonOperator,
        alarmDescription,
        alarmName: `${envName}-${metricId}`,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        actionsEnabled: true,
      });
      alarm.addAlarmAction(snsAction);
      alarm.addOkAction(snsAction);
      return alarm;
    };

    // ── ECS alarms ───────────────────────────────────────────────────────────
    const ecsCpuAlarm = makeAlarm(
      'ecs-cpu-high',
      new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'CPUUtilization',
        dimensionsMap: ecsDimensions,
        period,
        statistic: 'Average',
        label: 'ECS CPU Utilization (%)',
      }),
      ecsCpuThreshold,
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      `ECS CPU utilization exceeded ${ecsCpuThreshold}% on ${envName}`,
    );

    const ecsMemoryAlarm = makeAlarm(
      'ecs-memory-high',
      new cloudwatch.Metric({
        namespace: 'AWS/ECS',
        metricName: 'MemoryUtilization',
        dimensionsMap: ecsDimensions,
        period,
        statistic: 'Average',
        label: 'ECS Memory Utilization (%)',
      }),
      ecsMemoryThreshold,
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      `ECS memory utilization exceeded ${ecsMemoryThreshold}% on ${envName}`,
    );

    // ── ALB alarms ───────────────────────────────────────────────────────────
    const alb5xxElbAlarm = makeAlarm(
      'alb-5xx-elb',
      new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_ELB_5XX_Count',
        dimensionsMap: albDimensions,
        period,
        statistic: 'Sum',
        label: 'ALB 5XX (ELB-generated)',
      }),
      alb5xxThreshold,
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      `ALB (ELB-generated) 5XX count exceeded ${alb5xxThreshold} on ${envName}`,
    );

    const alb5xxTargetAlarm = makeAlarm(
      'alb-5xx-target',
      new cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: albDimensions,
        period,
        statistic: 'Sum',
        label: 'ALB 5XX (target-returned)',
      }),
      alb5xxThreshold,
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      `ALB (target-returned) 5XX count exceeded ${alb5xxThreshold} on ${envName}`,
    );

    // ── RDS alarm ────────────────────────────────────────────────────────────
    const rdsConnectionsAlarm = makeAlarm(
      'rds-connections-high',
      new cloudwatch.Metric({
        namespace: 'AWS/RDS',
        metricName: 'DatabaseConnections',
        dimensionsMap: rdsDimensions,
        period,
        statistic: 'Average',
        label: 'RDS Database Connections',
      }),
      rdsConnectionsThreshold,
      cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      `RDS connection count exceeded ${rdsConnectionsThreshold} on ${envName}`,
    );

    this.alarms = {
      ecsCpu: ecsCpuAlarm,
      ecsMemory: ecsMemoryAlarm,
      alb5xxElb: alb5xxElbAlarm,
      alb5xxTarget: alb5xxTargetAlarm,
      rdsConnections: rdsConnectionsAlarm,
    };

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic ARN for CloudWatch alarm notifications',
      exportName: `${envName}-alarm-topic-arn`,
    });

    new cdk.CfnOutput(this, 'AlarmTopicName', {
      value: this.alarmTopic.topicName,
      description: 'SNS topic name for CloudWatch alarm notifications',
      exportName: `${envName}-alarm-topic-name`,
    });

    new cdk.CfnOutput(this, 'EcsCpuAlarmArn', {
      value: ecsCpuAlarm.alarmArn,
      description: 'ARN of the ECS CPU high alarm',
      exportName: `${envName}-ecs-cpu-alarm-arn`,
    });

    new cdk.CfnOutput(this, 'EcsMemoryAlarmArn', {
      value: ecsMemoryAlarm.alarmArn,
      description: 'ARN of the ECS memory high alarm',
      exportName: `${envName}-ecs-memory-alarm-arn`,
    });
  }
}
