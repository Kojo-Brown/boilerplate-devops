import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DbMigrationStackProps extends cdk.StackProps {
  /** VPC to deploy into (from VpcStack) */
  readonly vpc: ec2.IVpc;
  /** Environment name used for resource naming */
  readonly envName?: string;
  /** Full ECR image URI (with tag) for the migration container */
  readonly migrationImageUri: string;
  /** Secrets Manager ARN holding DB credentials the migration container reads */
  readonly dbSecretArn: string;
  /** RDS security group — ingress rule for port 5432 is added for migration tasks */
  readonly dbSecurityGroup: ec2.ISecurityGroup;
  /**
   * Command to run inside the migration container.
   * Defaults to ['npm', 'run', 'migrate'].
   */
  readonly migrationCommand?: string[];
  /** Fargate CPU units for the migration task (default: 256) */
  readonly cpu?: number;
  /** Fargate memory in MiB for the migration task (default: 512) */
  readonly memoryLimitMiB?: number;
  /**
   * Max minutes the lifecycle hook Lambda waits for the migration task.
   * Must be less than the Lambda timeout (default: 14 minutes, Lambda timeout: 15).
   */
  readonly migrationTimeoutMinutes?: number;
}

/**
 * Database migration safety for blue/green CodeDeploy deployments.
 *
 * Architecture:
 *   CodeDeploy BeforeAllowTraffic lifecycle event
 *     → Lambda (this stack)
 *     → ECS Fargate migration task (runs db migrations)
 *     → Lambda reports Succeeded / Failed to CodeDeploy
 *
 * Safety guarantee:
 *   CodeDeploy shifts traffic from Blue → Green ONLY after the Lambda reports
 *   Succeeded.  If the migration task exits non-zero or times out, the Lambda
 *   reports Failed and CodeDeploy rolls back automatically — the Blue environment
 *   keeps serving traffic, the database schema is NOT partially migrated to
 *   callers running the old code.
 *
 * Integration with BlueGreenDeployStack:
 *   After deploying this stack, register the MigrationHookLambdaArn output as
 *   the BeforeAllowTraffic lifecycle hook in the CodeDeploy deployment group:
 *
 *     aws deploy update-deployment-group \
 *       --application-name <CodeDeployApplicationName> \
 *       --current-deployment-group-name <DeploymentGroupName> \
 *       --load-balancer-info targetGroupPairInfoList=[...] \
 *       --on-premises-tag-filters \
 *       --deployment-style deploymentType=BLUE_GREEN,deploymentOption=WITH_TRAFFIC_CONTROL \
 *       --blue-green-deployment-configuration ...
 *       # OR via console: Deployment Group → Edit → Lifecycle event hooks → BeforeAllowTraffic
 *
 *   Alternatively, pass `lifecycleHooks` to the CDK EcsDeploymentGroup construct.
 */
export class DbMigrationStack extends cdk.Stack {
  public readonly migrationTaskDefinition: ecs.FargateTaskDefinition;
  public readonly migrationCluster: ecs.Cluster;
  public readonly lifecycleHookLambda: lambda.Function;
  public readonly migrationSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DbMigrationStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const cpu = props.cpu ?? 256;
    const memoryLimitMiB = props.memoryLimitMiB ?? 512;
    const migrationTimeoutMinutes = props.migrationTimeoutMinutes ?? 14;
    const migrationCommand = props.migrationCommand ?? ['npm', 'run', 'migrate'];

    // ── Security Group — migration tasks need outbound to RDS only ─────────────
    this.migrationSecurityGroup = new ec2.SecurityGroup(this, 'MigrationTaskSg', {
      securityGroupName: `${envName}-migration-task-sg`,
      vpc: props.vpc,
      description: `Security group for ${envName} database migration ECS tasks`,
      allowAllOutbound: true,
    });

    // Open port 5432 on the RDS security group so migration tasks can connect
    props.dbSecurityGroup.addIngressRule(
      this.migrationSecurityGroup,
      ec2.Port.tcp(5432),
      `PostgreSQL access for ${envName} migration tasks`,
    );

    // ── Dedicated ECS Cluster for migration tasks ───────────────────────────────
    this.migrationCluster = new ecs.Cluster(this, 'MigrationCluster', {
      clusterName: `${envName}-migration-cluster`,
      vpc: props.vpc,
      containerInsights: true,
    });

    // ── CloudWatch Log Group ────────────────────────────────────────────────────
    const migrationLogGroup = new logs.LogGroup(this, 'MigrationLogGroup', {
      logGroupName: `/ecs/${envName}/migration`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Task Execution Role (pull image + write logs) ───────────────────────────
    const executionRole = new iam.Role(this, 'MigrationExecutionRole', {
      roleName: `${envName}-migration-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: `ECS task execution role for ${envName} migration tasks`,
    });

    // Allow execution role to fetch DB credentials from Secrets Manager
    // so they can be injected as environment variables via ECS secrets
    executionRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.dbSecretArn],
        sid: 'ReadDbSecret',
      }),
    );

    // ── Task Role (runtime permissions inside the container) ────────────────────
    const taskRole = new iam.Role(this, 'MigrationTaskRole', {
      roleName: `${envName}-migration-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Runtime permissions for ${envName} migration container`,
    });

    // ── Migration Task Definition ───────────────────────────────────────────────
    this.migrationTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      'MigrationTaskDef',
      {
        family: `${envName}-migration-task`,
        cpu,
        memoryLimitMiB,
        executionRole,
        taskRole,
      },
    );

    this.migrationTaskDefinition.addContainer('MigrationContainer', {
      containerName: 'MigrationContainer',
      image: ecs.ContainerImage.fromRegistry(props.migrationImageUri),
      command: migrationCommand,
      logging: ecs.LogDrivers.awsLogs({
        logGroup: migrationLogGroup,
        streamPrefix: 'migration',
      }),
      secrets: {
        // Injects username/password/host/port from the Secrets Manager JSON blob
        DB_SECRET_JSON: ecs.Secret.fromSecretsManager(
          secretsmanager.Secret.fromSecretCompleteArn(this, 'DbSecretRef', props.dbSecretArn),
        ),
      },
      environment: {
        NODE_ENV: envName,
        DB_SECRET_ARN: props.dbSecretArn,
      },
      essential: true,
    });

    // ── Lambda Execution Role ───────────────────────────────────────────────────
    const lambdaRole = new iam.Role(this, 'MigrationHookLambdaRole', {
      roleName: `${envName}-migration-hook-lambda-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Lambda execution role for ${envName} CodeDeploy migration lifecycle hook`,
    });

    // Lambda needs VPC access for logging (CloudWatch Logs via VPC endpoint or NAT)
    lambdaRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'service-role/AWSLambdaVPCAccessExecutionRole',
      ),
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunMigrationTask',
        actions: ['ecs:RunTask'],
        resources: [
          this.migrationTaskDefinition.taskDefinitionArn,
          // Allow all revisions of the same family
          cdk.Stack.of(this).formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: `${envName}-migration-task:*`,
          }),
        ],
        conditions: {
          ArnLike: {
            'ecs:cluster': this.migrationCluster.clusterArn,
          },
        },
      }),
    );

    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ObserveMigrationTask',
        actions: ['ecs:DescribeTasks', 'ecs:StopTask'],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'ecs:cluster': this.migrationCluster.clusterArn,
          },
        },
      }),
    );

    // Lambda must pass the task and execution roles to ECS
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassEcsRoles',
        actions: ['iam:PassRole'],
        resources: [executionRole.roleArn, taskRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'ecs-tasks.amazonaws.com',
          },
        },
      }),
    );

    // Report migration result back to CodeDeploy
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReportLifecycleHookStatus',
        actions: ['codedeploy:PutLifecycleEventHookExecutionStatus'],
        resources: ['*'],
      }),
    );

    // ── Lambda CloudWatch Log Group ─────────────────────────────────────────────
    const lambdaLogGroup = new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName: `/aws/lambda/${envName}-migration-hook`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Subnet IDs passed to ECS RunTask so migration task starts in private subnets
    const privateSubnetIds = props.vpc
      .selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS })
      .subnetIds.join(',');

    // ── Lifecycle Hook Lambda ───────────────────────────────────────────────────
    // Invoked by CodeDeploy as the BeforeAllowTraffic lifecycle event.
    // Launches the migration ECS task, polls until completion, then reports
    // Succeeded or Failed back to CodeDeploy via PutLifecycleEventHookExecutionStatus.
    this.lifecycleHookLambda = new lambda.Function(this, 'MigrationHookLambda', {
      functionName: `${envName}-migration-hook`,
      description: `Runs DB migrations before traffic shifts to the green ECS tasks (${envName})`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      // Must complete before CodeDeploy's hook timeout (default 1 hour).
      // We set 15 minutes; migrationTimeoutMinutes controls the inner ECS wait.
      timeout: cdk.Duration.minutes(15),
      logGroup: lambdaLogGroup,
      environment: {
        CLUSTER_ARN: this.migrationCluster.clusterArn,
        TASK_DEFINITION_ARN: this.migrationTaskDefinition.taskDefinitionArn,
        SUBNETS: privateSubnetIds,
        SECURITY_GROUP_ID: this.migrationSecurityGroup.securityGroupId,
        MIGRATION_TIMEOUT_MS: String(migrationTimeoutMinutes * 60 * 1000),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      // Inline code — kept minimal so the Lambda package size stays tiny.
      // Production teams should consider a separate Lambda layer or zip for
      // more complex migration orchestration (e.g. Flyway, Liquibase wrappers).
      code: lambda.Code.fromInline(`
'use strict';
const { ECSClient, RunTaskCommand, DescribeTasksCommand, StopTaskCommand } = require('@aws-sdk/client-ecs');
const { CodeDeployClient, PutLifecycleEventHookExecutionStatusCommand } = require('@aws-sdk/client-codedeploy');

const region = process.env.AWS_REGION;
const ecs = new ECSClient({ region });
const codedeploy = new CodeDeployClient({ region });

const POLL_INTERVAL_MS = 10_000;
const TIMEOUT_MS = parseInt(process.env.MIGRATION_TIMEOUT_MS, 10);

async function runMigrationTask() {
  const subnets = process.env.SUBNETS.split(',').filter(Boolean);
  const { tasks, failures } = await ecs.send(new RunTaskCommand({
    cluster: process.env.CLUSTER_ARN,
    taskDefinition: process.env.TASK_DEFINITION_ARN,
    launchType: 'FARGATE',
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets,
        securityGroups: [process.env.SECURITY_GROUP_ID],
        assignPublicIp: 'DISABLED',
      },
    },
  }));

  if (failures && failures.length > 0) {
    throw new Error('ECS RunTask failures: ' + JSON.stringify(failures));
  }

  const taskArn = tasks && tasks[0] && tasks[0].taskArn;
  if (!taskArn) throw new Error('No taskArn returned from ECS RunTask');
  return taskArn;
}

async function waitForTask(taskArn) {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    const { tasks } = await ecs.send(new DescribeTasksCommand({
      cluster: process.env.CLUSTER_ARN,
      tasks: [taskArn],
    }));

    const task = tasks && tasks[0];
    if (!task) throw new Error('Migration task disappeared from ECS: ' + taskArn);

    const containers = (task.containers || []).map(c => ({
      name: c.name,
      status: c.lastStatus,
      exitCode: c.exitCode,
    }));
    console.log(JSON.stringify({ lastStatus: task.lastStatus, containers }));

    if (task.lastStatus === 'STOPPED') {
      const failed = (task.containers || []).some(c => typeof c.exitCode === 'number' && c.exitCode !== 0);
      if (failed) {
        const reason = task.stoppedReason || 'container exited non-zero';
        throw new Error('Migration task failed: ' + reason);
      }
      console.log('Migration task completed successfully');
      return;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Timeout reached — stop the task and fail the hook so CodeDeploy rolls back
  console.error('Migration timed out, stopping task:', taskArn);
  await ecs.send(new StopTaskCommand({
    cluster: process.env.CLUSTER_ARN,
    task: taskArn,
    reason: 'Lambda lifecycle hook timeout',
  })).catch(err => console.error('StopTask error (non-fatal):', err));

  throw new Error('Migration timed out after ' + (TIMEOUT_MS / 60000) + ' minutes');
}

exports.handler = async (event) => {
  console.log('CodeDeploy lifecycle event:', JSON.stringify(event));

  const deploymentId = event.DeploymentId;
  const lifecycleEventHookExecutionId = event.LifecycleEventHookExecutionId;

  let status = 'Succeeded';
  let taskArn;

  try {
    taskArn = await runMigrationTask();
    console.log('Migration ECS task started:', taskArn);
    await waitForTask(taskArn);
  } catch (err) {
    console.error('Migration lifecycle hook error:', err instanceof Error ? err.message : err);
    status = 'Failed';
  }

  try {
    await codedeploy.send(new PutLifecycleEventHookExecutionStatusCommand({
      deploymentId,
      lifecycleEventHookExecutionId,
      status,
    }));
    console.log('Reported lifecycle hook status to CodeDeploy:', status);
  } catch (reportErr) {
    // Log but do not rethrow — CodeDeploy will time out the hook and roll back
    console.error('Failed to report hook status:', reportErr instanceof Error ? reportErr.message : reportErr);
  }

  return { status, taskArn };
};
      `),
    });

    // Allow CodeDeploy to invoke the lifecycle hook Lambda
    this.lifecycleHookLambda.addPermission('AllowCodeDeployInvoke', {
      principal: new iam.ServicePrincipal('codedeploy.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    // ── Tags ────────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── CloudFormation Outputs ──────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'MigrationHookLambdaArn', {
      value: this.lifecycleHookLambda.functionArn,
      description:
        'ARN of the BeforeAllowTraffic lifecycle hook Lambda — ' +
        'register this in the CodeDeploy deployment group lifecycle hooks',
      exportName: `${envName}-migration-hook-lambda-arn`,
    });

    new cdk.CfnOutput(this, 'MigrationClusterArn', {
      value: this.migrationCluster.clusterArn,
      description: 'ECS cluster ARN for migration tasks',
      exportName: `${envName}-migration-cluster-arn`,
    });

    new cdk.CfnOutput(this, 'MigrationTaskDefinitionArn', {
      value: this.migrationTaskDefinition.taskDefinitionArn,
      description:
        'ECS task definition ARN for migration runs — ' +
        'pass to workflow-templates/db-migration-deploy.yml as task-definition',
      exportName: `${envName}-migration-task-def-arn`,
    });

    new cdk.CfnOutput(this, 'MigrationClusterName', {
      value: this.migrationCluster.clusterName,
      description: 'ECS cluster name for migration tasks',
      exportName: `${envName}-migration-cluster-name`,
    });

    new cdk.CfnOutput(this, 'MigrationSecurityGroupId', {
      value: this.migrationSecurityGroup.securityGroupId,
      description: 'Security group ID for migration ECS tasks',
      exportName: `${envName}-migration-sg-id`,
    });
  }
}
