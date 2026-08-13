import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  PREVIEW_PR_NUMBER_TAG_KEY,
  PREVIEW_TAG_KEY,
  previewDatabaseName,
  previewStackNamePrefix,
} from './preview-environment-stack';

/** First listener-rule priority a preview may claim. */
export const DEFAULT_RULE_PRIORITY_BASE = 1000;

/** Number of priorities previews may claim, starting at the base. */
export const DEFAULT_RULE_PRIORITY_RANGE = 40000;

/** Name of the application container in a preview task definition. */
export const PREVIEW_CONTAINER_NAME = 'AppContainer';

export interface PreviewPrStackProps extends cdk.StackProps {
  /** Pull request number this environment belongs to. Must be a positive integer. */
  readonly prNumber: number;
  /** `owner/name` of the repository, recorded as a tag for the reaper's reports. */
  readonly repository: string;
  /** Full image URI, including tag or digest, built from the pull request head. */
  readonly imageUri: string;
  /** VPC the preview tasks run in — the same one the shared stack uses. */
  readonly vpc: ec2.IVpc;
  /** Cluster from `PreviewEnvironmentStack`. */
  readonly cluster: ecs.ICluster;
  /** HTTPS listener from `PreviewEnvironmentStack`. */
  readonly httpsListener: elbv2.IApplicationListener;
  /** Shared task security group from `PreviewEnvironmentStack`. */
  readonly taskSecurityGroup: ec2.ISecurityGroup;
  /** Shared preview log group from `PreviewEnvironmentStack`. */
  readonly logGroup: logs.ILogGroup;
  /** Hostname of the shared preview database. */
  readonly databaseHost: string;
  /** Port of the shared preview database. */
  readonly databasePort: string;
  /** Secret holding the shared preview database's `username` and `password`. */
  readonly databaseSecret: secretsmanager.ISecret;
  /** Domain previews are served under, e.g. `preview.example.com`. */
  readonly previewDomain: string;
  /** Environment name, matching the shared stack (default: `preview`). */
  readonly envName?: string;
  /** Port the container listens on (default: 3000). */
  readonly containerPort?: number;
  /**
   * Tasks the service declares (default: 0 — see the class documentation).
   * Raising this defeats the seed ordering; the deploy workflow scales up.
   */
  readonly desiredCount?: number;
  /** Fargate CPU units (default: 512). */
  readonly cpu?: number;
  /** Fargate memory in MiB (default: 1024). */
  readonly memoryLimitMiB?: number;
  /** ALB health-check path (default: `/health`). */
  readonly healthCheckPath?: string;
  /**
   * Command the seed task runs, as a container override on this same task
   * definition (default: `['npm', 'run', 'seed:preview']`).
   */
  readonly seedCommand?: string[];
  /** Extra environment variables for the application container. */
  readonly environment?: Record<string, string>;
  /** First listener-rule priority previews may claim (default: 1000). */
  readonly rulePriorityBase?: number;
  /** Number of priorities previews may claim (default: 40000). */
  readonly rulePriorityRange?: number;
}

/**
 * Everything a single pull request's preview environment needs that cannot be
 * shared: a task definition, a service, a target group, and the listener rule
 * that routes its hostname.
 *
 * Deployed as `{envName}-pr-{n}` so the reaper's `cloudformation:DeleteStack`
 * policy — scoped to that prefix — can reach it and nothing else.
 *
 * **The seed task is this stack's task definition, run with a command
 * override.** Seeding from a separate definition means the fixtures are loaded
 * by whatever image that definition points at, which is the image from the last
 * time somebody edited the infrastructure, not the one under review. Overriding
 * the command guarantees the schema, the migrations, and the fixtures all come
 * from the commit being previewed.
 *
 * **Seeding is not wired into the service.** A container that seeds on start
 * re-seeds on every task replacement and races itself when the service runs
 * more than one task. The deploy workflow runs the seed task once, waits for it
 * to exit zero, and only then updates the service.
 *
 * **The service is declared with zero tasks.** A preview's database has no
 * schema until the seed task has run, and the seed task cannot run until the
 * task definition exists — which is the same CloudFormation operation that
 * creates the service. Declaring one task would start the application against
 * an empty database inside that operation: it crash-loops, the deployment
 * circuit breaker trips or CloudFormation waits for a service that will never
 * reach steady state, and the stack fails on exactly the deploy that matters,
 * the first one. So the stack converges with nothing running, the workflow
 * seeds, and then it scales the service to one and waits for it to stabilise.
 * That also makes redeploys deterministic: every push goes down to zero, gets
 * fresh fixtures, and comes back up, rather than serving two schemas at once.
 */
export class PreviewPrStack extends cdk.Stack {
  public readonly service: ecs.FargateService;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;
  public readonly listenerRule: elbv2.ApplicationListenerRule;
  /** Hostname this preview is served at. */
  public readonly hostname: string;
  /** Database this preview owns inside the shared instance. */
  public readonly databaseName: string;
  /** Listener-rule priority derived from the pull request number. */
  public readonly rulePriority: number;

  constructor(scope: Construct, id: string, props: PreviewPrStackProps) {
    // Validated inside the `super` argument rather than after it. The stack
    // name is derived from `prNumber`, so a bad one reaches CloudFormation's
    // own name validation first and reports itself as a malformed stack name —
    // which is true, but says nothing about where the bad value came from.
    super(scope, id, withPreviewStackName(props));

    const envName = props.envName ?? 'preview';
    const containerPort = props.containerPort ?? 3000;
    const cpu = props.cpu ?? 512;
    const memoryLimitMiB = props.memoryLimitMiB ?? 1024;
    const healthCheckPath = props.healthCheckPath ?? '/health';
    const seedCommand = props.seedCommand ?? ['npm', 'run', 'seed:preview'];
    const rulePriorityBase = props.rulePriorityBase ?? DEFAULT_RULE_PRIORITY_BASE;
    const rulePriorityRange = props.rulePriorityRange ?? DEFAULT_RULE_PRIORITY_RANGE;

    this.hostname = `pr-${props.prNumber}.${props.previewDomain}`;
    this.databaseName = previewDatabaseName(props.prNumber);
    this.rulePriority = previewRulePriority(props.prNumber, rulePriorityBase, rulePriorityRange);

    // ── Task definition ───────────────────────────────────────────────────────
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: `Pulls the preview image and injects credentials for PR #${props.prNumber}`,
    });
    props.databaseSecret.grantRead(executionRole);

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Runtime role for the PR #${props.prNumber} preview`,
    });

    // Roles are unnamed on purpose. A named role is a hard uniqueness
    // constraint across the account, and a preview stack that fails to delete
    // holds the name until somebody clears it by hand — which turns a failed
    // teardown into a pull request that can never be previewed again.

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${envName}-pr-${props.prNumber}`,
      cpu,
      memoryLimitMiB,
      executionRole,
      taskRole,
    });

    this.taskDefinition.addContainer(PREVIEW_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromRegistry(props.imageUri),
      portMappings: [{ containerPort, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: props.logGroup,
        streamPrefix: `pr-${props.prNumber}`,
      }),
      environment: {
        NODE_ENV: 'preview',
        PORT: String(containerPort),
        // libpq's own variable names, which most Postgres drivers read without
        // being asked. Composing a DATABASE_URL here instead would mean putting
        // the password in the task definition, where `ecs describe-task-definition`
        // hands it to anyone with read access to the cluster.
        PGHOST: props.databaseHost,
        PGPORT: props.databasePort,
        PGDATABASE: this.databaseName,
        PREVIEW_PR_NUMBER: String(props.prNumber),
        PREVIEW_URL: `https://${this.hostname}`,
        ...props.environment,
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(props.databaseSecret, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(props.databaseSecret, 'password'),
      },
      readonlyRootFilesystem: false,
      essential: true,
    });

    // ── Target group ──────────────────────────────────────────────────────────
    // Named after the pull request so a leaked target group is traceable to
    // one. The 32-character limit is enforced by the ALB API, and a name that
    // is one character too long fails at deploy time rather than at synth.
    const targetGroupName = truncateTargetGroupName(`${envName}-pr-${props.prNumber}`);

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      targetGroupName,
      vpc: props.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: healthCheckPath,
        interval: cdk.Duration.seconds(15),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        // Two failed checks rather than production's three. A preview that is
        // broken should say so in half a minute, because the person waiting for
        // it is watching the pull request.
        unhealthyThresholdCount: 2,
        healthyHttpCodes: '200',
      },
      // Nothing is draining to: the previous tasks are being replaced by a
      // deploy nobody is depending on for uptime.
      deregistrationDelay: cdk.Duration.seconds(5),
    });

    // ── Service ───────────────────────────────────────────────────────────────
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `${envName}-pr-${props.prNumber}`,
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount ?? 0,
      assignPublicIp: false,
      securityGroups: [props.taskSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // A single task, replaced rather than doubled: `minHealthyPercent: 0`
      // stops the deployment waiting for capacity it will not get at
      // desiredCount 1, at the cost of a few seconds of downtime nobody is
      // paying for. maxHealthyPercent 100 keeps a preview to one task's spend.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      healthCheckGracePeriod: cdk.Duration.seconds(60),
    });

    // ECS Exec is the reason a preview is worth having when it breaks — it is
    // the only way into a Fargate task that has no public address.
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcsExec',
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }),
    );

    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // ── Listener rule ─────────────────────────────────────────────────────────
    this.listenerRule = new elbv2.ApplicationListenerRule(this, 'ListenerRule', {
      listener: props.httpsListener,
      priority: this.rulePriority,
      conditions: [elbv2.ListenerCondition.hostHeaders([this.hostname])],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    // These are the reaper's input. `PreviewEnvironment` marks the stack
    // disposable and `PreviewPrNumber` names what it belongs to; a stack
    // missing either is skipped rather than guessed at.
    cdk.Tags.of(this).add(PREVIEW_TAG_KEY, 'true');
    cdk.Tags.of(this).add(PREVIEW_PR_NUMBER_TAG_KEY, String(props.prNumber));
    cdk.Tags.of(this).add('PreviewRepository', props.repository);
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');

    // ── Outputs ───────────────────────────────────────────────────────────────
    // No `exportName` on any of these. An export is a cross-stack lock, and
    // these stacks exist to be deleted.
    new cdk.CfnOutput(this, 'PreviewUrl', {
      value: `https://${this.hostname}`,
      description: 'URL to post on the pull request',
    });

    new cdk.CfnOutput(this, 'PreviewServiceName', {
      value: this.service.serviceName,
      description: 'ECS service backing this preview',
    });

    new cdk.CfnOutput(this, 'PreviewTaskDefinitionArn', {
      value: this.taskDefinition.taskDefinitionArn,
      description: 'Task definition to run the seed command against',
    });

    new cdk.CfnOutput(this, 'PreviewSeedCommand', {
      value: JSON.stringify(seedCommand),
      description: 'Command the deploy workflow overrides the container with to seed fixtures',
    });

    new cdk.CfnOutput(this, 'PreviewDatabaseName', {
      value: this.databaseName,
      description: 'Database this preview owns inside the shared instance',
    });
  }
}

/** Stack name for a pull request's preview, matching the reaper's delete scope. */
export const previewStackName = (envName: string, prNumber: number): string =>
  `${previewStackNamePrefix(envName)}${prNumber}`;

/**
 * Validate `prNumber` and fill in the derived stack name.
 *
 * A caller-supplied `stackName` is honoured but does not excuse the check: the
 * hostname, the database, and the listener-rule priority are derived from
 * `prNumber` too, and only the stack name would have been overridden.
 */
const withPreviewStackName = (props: PreviewPrStackProps): PreviewPrStackProps => {
  if (!Number.isInteger(props.prNumber) || props.prNumber <= 0) {
    throw new Error(
      `prNumber must be a positive integer, got ${JSON.stringify(props.prNumber)}. ` +
        'It is the only thing distinguishing one preview from another — its stack name, ' +
        'hostname, database, and listener-rule priority are all derived from it.',
    );
  }

  return {
    ...props,
    stackName: props.stackName ?? previewStackName(props.envName ?? 'preview', props.prNumber),
  };
};

/**
 * Listener-rule priority for a pull request.
 *
 * Derived rather than allocated. Allocation needs somewhere to record which
 * priorities are taken, and two pull requests deploying at the same moment
 * would race for the same free slot; deriving it means the answer is the same
 * every time and two deploys can never disagree.
 *
 * The wrap is why this is not simply `base + prNumber`: a repository that
 * reaches pull request 50000 would otherwise start synthesising priorities the
 * ALB rejects. Wrapping trades that for a collision between two pull requests
 * exactly `range` apart, which is not silent — CloudFormation refuses the
 * second rule with `PriorityInUse`, and the fix is to widen the range or bump
 * the base.
 */
export const previewRulePriority = (
  prNumber: number,
  base = DEFAULT_RULE_PRIORITY_BASE,
  range = DEFAULT_RULE_PRIORITY_RANGE,
): number => {
  // Checked against the configuration rather than the priority this call
  // produces. A base and range that do not fit are wrong for every pull
  // request, and validating the result instead would let the mistake ship and
  // surface years later on the first pull request numbered high enough to
  // reach the top of the window.
  if (base < 1 || range < 1 || base + range - 1 > 50000) {
    throw new Error(
      `listener-rule priorities ${base}–${base + range - 1} fall outside the ALB's ` +
        '1–50000 range. Lower the base or narrow the range.',
    );
  }

  return base + (prNumber % range);
};

/**
 * Target-group name, trimmed to the ALB's 32-character limit.
 *
 * The pull request number is what makes the name unique, so it is the part that
 * survives: the environment prefix is trimmed from the left rather than the
 * whole name from the right.
 */
export const truncateTargetGroupName = (name: string): string =>
  name.length <= 32 ? name : name.slice(name.length - 32);
