import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

/**
 * A single ECS service to consider for rollback.
 *
 * Two rollback modes are supported:
 *
 *   Rolling-update mode (codeDeployApplication is absent):
 *     The Lambda calls UpdateService with the previous task-definition revision.
 *     Works for services whose deployment controller is ECS (rolling updates).
 *
 *   CodeDeploy mode (codeDeployApplication is present):
 *     The Lambda stops any in-progress CodeDeploy deployment for this group,
 *     which triggers the deployment group's autoRollback policy and restores
 *     Blue traffic.  The ECS service task-definition is NOT touched directly.
 */
export interface RollbackTarget {
  /** ECS cluster name (from EcsStack or BlueGreenDeployStack) */
  readonly clusterName: string;
  /** ECS service name */
  readonly serviceName: string;
  /**
   * CodeDeploy application name.
   * Provide to use CodeDeploy-managed rollback instead of direct task-def rollback.
   */
  readonly codeDeployApplication?: string;
  /**
   * CodeDeploy deployment group name.
   * Required when codeDeployApplication is provided.
   */
  readonly codeDeployDeploymentGroup?: string;
}

export interface RollbackAutomationStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging (default: production) */
  readonly envName?: string;
  /**
   * ARNs of CloudWatch alarms that trigger automatic rollback when they enter ALARM state.
   * Tip: pass CloudWatchAlarmsStack.alarms.alb5xxElb.alarmArn etc.
   */
  readonly triggerAlarmArns: string[];
  /**
   * ECS services to rollback when any trigger alarm breaches.
   * Supports rolling-update and CodeDeploy-controlled services.
   */
  readonly rollbackTargets: RollbackTarget[];
  /**
   * Email addresses to receive rollback event notifications.
   * Each address receives a subscription confirmation email from SNS before
   * messages are delivered.
   */
  readonly notificationEmails?: string[];
  /**
   * Lambda execution timeout in seconds (default: 60).
   * Increase if you have many rollback targets or slow CodeDeploy list calls.
   */
  readonly lambdaTimeoutSeconds?: number;
}

/**
 * Automatic rollback when a CloudWatch alarm breaches.
 *
 * Architecture:
 *   CloudWatch Alarm → ALARM
 *     → EventBridge rule (alarm-state-change)
 *       → Lambda
 *         ├─ Rolling-update ECS: UpdateService(previousTaskDefRevision)
 *         ├─ CodeDeploy ECS: StopDeployment (CodeDeploy autoRollback restores Blue)
 *         └─ SNS notification (alarm name, targets rolled back, timestamp)
 *
 * Why EventBridge instead of SNS → Lambda:
 *   SNS alarm actions fire once per state transition, but EventBridge lets us
 *   filter on specific alarm names without modifying each alarm's action list.
 *   Both approaches are valid; EventBridge keeps rollback wiring centralised here.
 *
 * Integration points:
 *   - Pass RollbackAutomationStack.notificationTopic.topicArn to the ops team
 *     or wire a Slack/PagerDuty subscription alongside email.
 *   - Export RollbackAutomationStack.rollbackLambda.functionArn and attach it
 *     as an additional CodeDeploy lifecycle hook if you need pre-shift rollbacks.
 *   - For rolling ECS services the Lambda rolls back to revision N-1; make sure
 *     you keep at least two task-definition revisions active in your account.
 */
export class RollbackAutomationStack extends cdk.Stack {
  public readonly notificationTopic: sns.Topic;
  public readonly rollbackLambda: lambda.Function;
  public readonly eventRule: events.Rule;

  constructor(scope: Construct, id: string, props: RollbackAutomationStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const lambdaTimeoutSeconds = props.lambdaTimeoutSeconds ?? 60;

    if (props.triggerAlarmArns.length === 0) {
      throw new Error('RollbackAutomationStack: triggerAlarmArns must contain at least one ARN');
    }
    if (props.rollbackTargets.length === 0) {
      throw new Error('RollbackAutomationStack: rollbackTargets must contain at least one target');
    }

    // ── SNS Notification Topic ─────────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'RollbackNotificationTopic', {
      topicName: `${envName}-rollback-notifications`,
      displayName: `${envName} Rollback Automation Notifications`,
    });

    for (const email of props.notificationEmails ?? []) {
      this.notificationTopic.addSubscription(
        new sns_sub.EmailSubscription(email),
      );
    }

    // ── Lambda CloudWatch Log Group ────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName: `/aws/lambda/${envName}-rollback-automation`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── IAM Role for the rollback Lambda ──────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'RollbackLambdaRole', {
      roleName: `${envName}-rollback-automation-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Lambda execution role for ${envName} alarm-triggered rollback automation`,
    });

    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    // Describe ECS services to find the current task definition ARN
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeEcsServices',
        actions: ['ecs:DescribeServices'],
        resources: ['*'],
      }),
    );

    // Update ECS services (rolling rollback — set previous task-def revision)
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'UpdateEcsService',
        actions: ['ecs:UpdateService'],
        resources: props.rollbackTargets.map((t) =>
          cdk.Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'service',
            resourceName: `${t.clusterName}/${t.serviceName}`,
          }),
        ),
      }),
    );

    // Describe and stop CodeDeploy deployments (CodeDeploy mode rollback)
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CodeDeployRollback',
        actions: [
          'codedeploy:ListDeployments',
          'codedeploy:GetDeployment',
          'codedeploy:StopDeployment',
        ],
        resources: ['*'],
      }),
    );

    // Publish to the SNS notification topic
    this.notificationTopic.grantPublish(lambdaRole);

    // ── Rollback Lambda ────────────────────────────────────────────────────────
    // Receives an EventBridge alarm-state-change event, rolls back each target,
    // and publishes a notification summary to SNS.
    this.rollbackLambda = new lambda.Function(this, 'RollbackLambda', {
      functionName: `${envName}-rollback-automation`,
      description: `Rolls back ECS services when a CloudWatch alarm breaches (${envName})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.seconds(lambdaTimeoutSeconds),
      logGroup,
      environment: {
        SNS_TOPIC_ARN: this.notificationTopic.topicArn,
        ROLLBACK_TARGETS: JSON.stringify(props.rollbackTargets),
        ENV_NAME: envName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(`
'use strict';
const { ECSClient, DescribeServicesCommand, UpdateServiceCommand } = require('@aws-sdk/client-ecs');
const { CodeDeployClient, ListDeploymentsCommand, StopDeploymentCommand } = require('@aws-sdk/client-codedeploy');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const region = process.env.AWS_REGION;
const ecs = new ECSClient({ region });
const codedeploy = new CodeDeployClient({ region });
const snsClient = new SNSClient({ region });

const TARGETS = JSON.parse(process.env.ROLLBACK_TARGETS);
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const ENV_NAME = process.env.ENV_NAME;

// Derive the previous task-definition ARN by decrementing the revision number.
// Returns null when already at revision 1 (nothing to roll back to).
function previousTaskDefArn(currentArn) {
  // ARN format: arn:aws:ecs:<region>:<account>:task-definition/<family>:<revision>
  const match = currentArn.match(/^(.+):(\d+)$/);
  if (!match) return null;
  const revision = parseInt(match[2], 10);
  if (revision <= 1) return null;
  return match[1] + ':' + (revision - 1);
}

async function rollbackRollingService(target) {
  const { data: services } = await ecs.send(new DescribeServicesCommand({
    cluster: target.clusterName,
    services: [target.serviceName],
  })).then(r => ({ data: r.services || [] }));

  const service = services[0];
  if (!service) {
    return { target: target.serviceName, status: 'NOT_FOUND', skipped: true };
  }

  const currentArn = service.taskDefinition;
  const prevArn = previousTaskDefArn(currentArn);
  if (!prevArn) {
    return { target: target.serviceName, status: 'ALREADY_AT_FIRST_REVISION', skipped: true };
  }

  await ecs.send(new UpdateServiceCommand({
    cluster: target.clusterName,
    service: target.serviceName,
    taskDefinition: prevArn,
    forceNewDeployment: true,
  }));

  return {
    target: target.serviceName,
    status: 'ROLLED_BACK',
    from: currentArn,
    to: prevArn,
  };
}

async function rollbackCodeDeployService(target) {
  // Find an in-progress deployment for this group and stop it.
  // CodeDeploy's autoRollback policy (configured in BlueGreenDeployStack)
  // will restore the Blue environment when a deployment is stopped.
  const { deploymentIds } = await codedeploy.send(new ListDeploymentsCommand({
    applicationName: target.codeDeployApplication,
    deploymentGroupName: target.codeDeployDeploymentGroup,
    includeOnlyStatuses: ['InProgress'],
  }));

  if (!deploymentIds || deploymentIds.length === 0) {
    return { target: target.serviceName, status: 'NO_IN_PROGRESS_DEPLOYMENT', skipped: true };
  }

  // Stop all in-progress deployments (usually just one)
  const stopped = [];
  for (const deploymentId of deploymentIds) {
    await codedeploy.send(new StopDeploymentCommand({
      deploymentId,
      autoRollbackEnabled: true,
    }));
    stopped.push(deploymentId);
  }

  return {
    target: target.serviceName,
    status: 'DEPLOYMENT_STOPPED',
    stoppedDeployments: stopped,
  };
}

exports.handler = async (event) => {
  console.log('Alarm rollback event:', JSON.stringify(event));

  const alarmName = event.detail && event.detail.alarmName
    ? event.detail.alarmName
    : (event['detail-type'] || 'unknown alarm');
  const newState = event.detail && event.detail.state && event.detail.state.value
    ? event.detail.state.value
    : 'ALARM';

  const results = [];
  const errors = [];

  for (const target of TARGETS) {
    try {
      let result;
      if (target.codeDeployApplication && target.codeDeployDeploymentGroup) {
        result = await rollbackCodeDeployService(target);
      } else {
        result = await rollbackRollingService(target);
      }
      results.push(result);
      console.log('Rollback result:', JSON.stringify(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ target: target.serviceName, error: msg });
      console.error('Rollback error for', target.serviceName, ':', msg);
    }
  }

  const rolledBack = results.filter(r => !r.skipped).map(r => r.target);
  const skipped    = results.filter(r => r.skipped).map(r => r.target + ' (' + r.status + ')');
  const failed     = errors.map(e => e.target + ': ' + e.error);

  const lines = [
    'Rollback automation triggered by alarm: ' + alarmName,
    'Alarm state: ' + newState,
    'Environment: ' + ENV_NAME,
    '',
    'Rolled back: ' + (rolledBack.length > 0 ? rolledBack.join(', ') : 'none'),
    'Skipped:     ' + (skipped.length > 0 ? skipped.join('; ') : 'none'),
    'Errors:      ' + (failed.length > 0 ? failed.join('; ') : 'none'),
    '',
    'Details: ' + JSON.stringify(results, null, 2),
  ];

  try {
    await snsClient.send(new PublishCommand({
      TopicArn: SNS_TOPIC_ARN,
      Subject: '[' + ENV_NAME.toUpperCase() + '] Rollback triggered by alarm: ' + alarmName,
      Message: lines.join('\\n'),
    }));
  } catch (snsErr) {
    console.error('SNS publish error (non-fatal):', snsErr instanceof Error ? snsErr.message : snsErr);
  }

  if (errors.length > 0) {
    throw new Error('Rollback errors: ' + failed.join('; '));
  }

  return { alarmName, rolledBack, skipped, errors: failed };
};
      `),
    });

    // ── EventBridge Rule — alarm state transitions to ALARM ────────────────────
    // Filters on the specific alarm names so unrelated alarm transitions do not
    // trigger the rollback Lambda.
    const alarmNames = props.triggerAlarmArns.map((arn) => {
      // Extract alarm name from ARN: arn:aws:cloudwatch:<region>:<account>:alarm:<name>
      const parts = arn.split(':');
      return parts[parts.length - 1];
    });

    this.eventRule = new events.Rule(this, 'AlarmBreachRule', {
      ruleName: `${envName}-rollback-on-alarm-breach`,
      description: `Triggers rollback Lambda when monitored alarms enter ALARM state (${envName})`,
      eventPattern: {
        source: ['aws.cloudwatch'],
        detailType: ['CloudWatch Alarm State Change'],
        detail: {
          state: { value: ['ALARM'] },
          alarmName: alarmNames,
        },
      },
    });

    this.eventRule.addTarget(
      new events_targets.LambdaFunction(this.rollbackLambda, {
        retryAttempts: 2,
        // Capture failed invocations in CloudWatch logs via dead-letter queue omitted
        // for simplicity; add a DLQ here for production hardening.
      }),
    );

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── CloudFormation Outputs ─────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RollbackLambdaArn', {
      value: this.rollbackLambda.functionArn,
      description: 'ARN of the rollback automation Lambda function',
      exportName: `${envName}-rollback-lambda-arn`,
    });

    new cdk.CfnOutput(this, 'NotificationTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'SNS topic ARN for rollback event notifications',
      exportName: `${envName}-rollback-notification-topic-arn`,
    });

    new cdk.CfnOutput(this, 'EventRuleName', {
      value: this.eventRule.ruleName,
      description: 'EventBridge rule name watching for alarm breach events',
      exportName: `${envName}-rollback-event-rule-name`,
    });
  }
}
