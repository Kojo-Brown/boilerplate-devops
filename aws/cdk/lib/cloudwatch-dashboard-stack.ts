import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';

export interface CloudWatchDashboardStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** ECS cluster name — use EcsStack.cluster.clusterName */
  readonly clusterName: string;
  /** ECS service name — use EcsStack.service.serviceName */
  readonly serviceName: string;
  /**
   * ALB full name (the load balancer dimension value for AWS/ApplicationELB).
   * Obtain from EcsStack.alb.loadBalancerFullName — resolves to "app/<name>/<id>".
   */
  readonly albFullName: string;
  /** RDS instance identifier — use RdsStack.instance.instanceIdentifier */
  readonly rdsInstanceId: string;
  /** Override the CloudWatch Dashboard name (default: {envName}-dashboard) */
  readonly dashboardName?: string;
  /** Metric evaluation period in minutes (default: 5) */
  readonly periodMinutes?: number;
}

/**
 * CloudWatch Dashboard with widgets for ECS, ALB, and RDS health signals.
 *
 * Layout (3 rows × 2 columns, each widget 12 units wide):
 *   Row 1  — ECS CPU Utilization | ECS Memory Utilization
 *   Row 2  — ALB 5XX Errors      | ALB Request Count
 *   Row 3  — RDS Connections     | RDS CPU Utilization
 *
 * All metrics use a configurable period (default 5 min) with sensible
 * statistics (Average for utilisation, Sum for counts).
 */
export class CloudWatchDashboardStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: CloudWatchDashboardStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const period = cdk.Duration.minutes(props.periodMinutes ?? 5);
    const dashboardName = props.dashboardName ?? `${envName}-dashboard`;

    // ── Dimension maps ───────────────────────────────────────────────────────
    const ecsDimensions = {
      ClusterName: props.clusterName,
      ServiceName: props.serviceName,
    };
    const albDimensions = { LoadBalancer: props.albFullName };
    const rdsDimensions = { DBInstanceIdentifier: props.rdsInstanceId };

    // ── ECS metrics ──────────────────────────────────────────────────────────
    const ecsCpu = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'CPUUtilization',
      dimensionsMap: ecsDimensions,
      period,
      statistic: 'Average',
      label: 'CPU Utilization (%)',
    });

    const ecsMemory = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'MemoryUtilization',
      dimensionsMap: ecsDimensions,
      period,
      statistic: 'Average',
      label: 'Memory Utilization (%)',
    });

    // ── ALB metrics ──────────────────────────────────────────────────────────
    const alb5xxElb = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_ELB_5XX_Count',
      dimensionsMap: albDimensions,
      period,
      statistic: 'Sum',
      label: 'ALB 5XX (ELB-generated)',
    });

    const alb5xxTarget = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'HTTPCode_Target_5XX_Count',
      dimensionsMap: albDimensions,
      period,
      statistic: 'Sum',
      label: 'ALB 5XX (target-returned)',
    });

    const albRequests = new cloudwatch.Metric({
      namespace: 'AWS/ApplicationELB',
      metricName: 'RequestCount',
      dimensionsMap: albDimensions,
      period,
      statistic: 'Sum',
      label: 'Request Count',
    });

    // ── RDS metrics ──────────────────────────────────────────────────────────
    const rdsConnections = new cloudwatch.Metric({
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnections',
      dimensionsMap: rdsDimensions,
      period,
      statistic: 'Average',
      label: 'Database Connections',
    });

    const rdsCpu = new cloudwatch.Metric({
      namespace: 'AWS/RDS',
      metricName: 'CPUUtilization',
      dimensionsMap: rdsDimensions,
      period,
      statistic: 'Average',
      label: 'CPU Utilization (%)',
    });

    // ── Widgets ──────────────────────────────────────────────────────────────
    const ecsCpuWidget = new cloudwatch.GraphWidget({
      title: `ECS CPU Utilization — ${envName}`,
      left: [ecsCpu],
      leftYAxis: { min: 0, max: 100, label: 'Percent', showUnits: false },
      width: 12,
      height: 6,
    });

    const ecsMemoryWidget = new cloudwatch.GraphWidget({
      title: `ECS Memory Utilization — ${envName}`,
      left: [ecsMemory],
      leftYAxis: { min: 0, max: 100, label: 'Percent', showUnits: false },
      width: 12,
      height: 6,
    });

    const alb5xxWidget = new cloudwatch.GraphWidget({
      title: `ALB 5XX Errors — ${envName}`,
      left: [alb5xxElb, alb5xxTarget],
      leftYAxis: { min: 0, label: 'Count', showUnits: false },
      width: 12,
      height: 6,
      view: cloudwatch.GraphWidgetView.BAR,
    });

    const albRequestWidget = new cloudwatch.GraphWidget({
      title: `ALB Request Count — ${envName}`,
      left: [albRequests],
      leftYAxis: { min: 0, label: 'Count', showUnits: false },
      width: 12,
      height: 6,
    });

    const rdsConnectionsWidget = new cloudwatch.GraphWidget({
      title: `RDS Database Connections — ${envName}`,
      left: [rdsConnections],
      leftYAxis: { min: 0, label: 'Count', showUnits: false },
      width: 12,
      height: 6,
    });

    const rdsCpuWidget = new cloudwatch.GraphWidget({
      title: `RDS CPU Utilization — ${envName}`,
      left: [rdsCpu],
      leftYAxis: { min: 0, max: 100, label: 'Percent', showUnits: false },
      width: 12,
      height: 6,
    });

    // ── Dashboard ────────────────────────────────────────────────────────────
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName,
      widgets: [
        [ecsCpuWidget, ecsMemoryWidget],
        [alb5xxWidget, albRequestWidget],
        [rdsConnectionsWidget, rdsCpuWidget],
      ],
    });

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'DashboardName', {
      value: dashboardName,
      description: 'CloudWatch Dashboard name',
      exportName: `${envName}-cloudwatch-dashboard-name`,
    });

    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${dashboardName}`,
      description: 'Direct link to the CloudWatch Dashboard in the AWS Console',
      exportName: `${envName}-cloudwatch-dashboard-url`,
    });
  }
}
