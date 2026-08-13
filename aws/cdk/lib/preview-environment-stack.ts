import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** Tag key marking a stack as a per-PR preview environment the reaper may delete. */
export const PREVIEW_TAG_KEY = 'PreviewEnvironment';

/** Tag key carrying the pull-request number a preview stack belongs to. */
export const PREVIEW_PR_NUMBER_TAG_KEY = 'PreviewPrNumber';

/** Prefix of every per-PR database. The admin container refuses any other name. */
export const PREVIEW_DATABASE_PREFIX = 'preview_pr_';

/** Name of the container in the database-admin task definition. */
export const DATABASE_ADMIN_CONTAINER_NAME = 'DatabaseAdmin';

export interface PreviewEnvironmentStackProps extends cdk.StackProps {
  /** VPC to place the shared preview infrastructure in (from VpcStack). */
  readonly vpc: ec2.IVpc;
  /** Environment name used for resource naming (default: `preview`). */
  readonly envName?: string;
  /**
   * ACM certificate ARN for the HTTPS listener. Must cover the wildcard
   * `*.{previewDomain}`, because every preview is a subdomain and no
   * certificate is issued per pull request.
   */
  readonly certificateArn: string;
  /**
   * Domain previews live under, e.g. `preview.example.com`. Pull request 123
   * is served at `pr-123.preview.example.com`.
   */
  readonly previewDomain: string;
  /**
   * Hosted zone to create the wildcard alias record in. Omit to manage DNS
   * elsewhere — the record is the only thing this stack needs from Route 53.
   */
  readonly hostedZone?: route53.IHostedZone;
  /** `owner/name` of the repository previews are built from. */
  readonly repository: string;
  /**
   * Secrets Manager ARN of a secret whose `token` field is a GitHub token with
   * `pull_requests: read`. Without it the reaper cannot see whether a pull
   * request is still open and falls back to age alone.
   */
  readonly githubTokenSecretArn?: string;
  /** GitHub API base URL — override for GitHub Enterprise Server. */
  readonly githubApiUrl?: string;
  /**
   * Delete a preview once its stack is this old, even while its pull request is
   * open (default: 168 hours / 7 days).
   */
  readonly maxLifetimeHours?: number;
  /**
   * Delete a preview this old when the pull request's state cannot be
   * determined (default: 72 hours).
   */
  readonly unknownStateTtlHours?: number;
  /** Most stacks the reaper will delete in a single run (default: 10). */
  readonly maxDeletionsPerRun?: number;
  /** How often the reaper sweeps (default: 1 hour). */
  readonly reaperSchedule?: events.Schedule;
  /** Report what the reaper would delete without deleting it (default: false). */
  readonly reaperDryRun?: boolean;
  /** Instance type for the shared preview database (default: `t4g.micro`). */
  readonly databaseInstanceType?: ec2.InstanceType;
  /** Allocated storage for the shared preview database in GiB (default: 20). */
  readonly databaseAllocatedStorageGiB?: number;
  /**
   * Image providing `psql`, used to create and drop per-PR databases.
   * Pin by digest in your own copy — see `docs/preview-environments.md`.
   */
  readonly databaseClientImage?: string;
  /** Port preview containers listen on (default: 3000). */
  readonly containerPort?: number;
  /** Retention for the shared preview log group (default: two weeks). */
  readonly logRetention?: logs.RetentionDays;
  /** Enable ALB deletion protection on the shared load balancer (default: false). */
  readonly albDeletionProtection?: boolean;
}

/**
 * Shared infrastructure every per-PR preview environment plugs into.
 *
 * A preview environment is only worth having if opening a pull request is
 * enough to get one, which rules out standing up a VPC, a load balancer, and a
 * database per pull request: that is fifteen minutes of provisioning and a
 * standing bill per open branch. Everything expensive and slow lives here and
 * is shared; {@link PreviewPrStack} adds only what genuinely cannot be shared —
 * a service, a target group, and a listener rule — which deploys in about a
 * minute and deletes in less.
 *
 * ```
 *   *.preview.example.com  →  shared ALB  ─┬─ rule host=pr-123…  →  TG  →  service (PR stack)
 *                                          ├─ rule host=pr-124…  →  TG  →  service (PR stack)
 *                                          └─ default            →  404
 *
 *   shared Postgres instance  ─┬─ database preview_pr_123
 *                              └─ database preview_pr_124
 * ```
 *
 * Two decisions in here are worth reading before copying:
 *
 * **The default listener action is a 404, not the last preview that happened to
 * be deployed.** The wildcard DNS record resolves for every hostname under the
 * preview domain, including the ones whose environments have been torn down, so
 * without an explicit default a stale link silently lands on somebody else's
 * pull request.
 *
 * **Per-PR stacks create no security-group rules.** They attach to
 * {@link taskSecurityGroup}, which this stack has already granted database
 * access. If each preview added its own ingress rule to the database's security
 * group, the rule would live in the preview stack while the group lived here,
 * and a preview stack that failed to delete cleanly would strand a rule against
 * a group it does not own — on a resource with a hard limit of 60.
 *
 * **Teardown does not depend on the teardown workflow running.** See
 * {@link reaperFunction}.
 */
export class PreviewEnvironmentStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly httpsListener: elbv2.ApplicationListener;
  /** Security group shared by every preview task; already allowed into the database. */
  public readonly taskSecurityGroup: ec2.SecurityGroup;
  /** Log group shared by every preview; each PR gets its own stream prefix. */
  public readonly logGroup: logs.LogGroup;
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: cdk.aws_secretsmanager.ISecret;
  /** Runs `psql` to create or drop a per-PR database. */
  public readonly databaseAdminTaskDefinition: ecs.FargateTaskDefinition;
  /**
   * Deletes preview stacks whose pull request has closed, and preview stacks
   * that have outlived their limit whatever their pull request says.
   *
   * The teardown job on `pull_request: closed` is the fast path, not the
   * guarantee. It does not run when Actions is disabled or degraded, when the
   * run is cancelled, when the workflow file is missing from the branch being
   * closed, or when a pull request is closed while the queue is backed up —
   * and every one of those failures is silent and costs money until somebody
   * notices an ECS console full of dead branches. This sweep is what makes the
   * teardown claim true; the workflow only makes it fast.
   */
  public readonly reaperFunction: lambda.Function;
  public readonly notificationTopic: sns.Topic;
  /** Environment name, exposed so the PR stack derives identical resource names. */
  public readonly envName: string;
  public readonly previewDomain: string;
  public readonly containerPort: number;

  constructor(scope: Construct, id: string, props: PreviewEnvironmentStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'preview';
    const containerPort = props.containerPort ?? 3000;
    const maxLifetimeHours = props.maxLifetimeHours ?? 168;
    const unknownStateTtlHours = props.unknownStateTtlHours ?? 72;
    const maxDeletionsPerRun = props.maxDeletionsPerRun ?? 10;
    const reaperDryRun = props.reaperDryRun ?? false;
    const logRetention = props.logRetention ?? logs.RetentionDays.TWO_WEEKS;
    const databaseClientImage =
      props.databaseClientImage ?? 'public.ecr.aws/docker/library/postgres:16-alpine';

    if (unknownStateTtlHours > maxLifetimeHours) {
      throw new Error(
        `unknownStateTtlHours (${unknownStateTtlHours}) must not exceed maxLifetimeHours ` +
          `(${maxLifetimeHours}): the unknown-state fallback is a tighter bound than the ` +
          'absolute lifetime, never a looser one.',
      );
    }

    this.envName = envName;
    this.previewDomain = props.previewDomain;
    this.containerPort = containerPort;

    // ── Cluster ───────────────────────────────────────────────────────────────
    this.cluster = new ecs.Cluster(this, 'PreviewCluster', {
      clusterName: `${envName}-cluster`,
      vpc: props.vpc,
      containerInsights: true,
    });

    // ── Log group ─────────────────────────────────────────────────────────────
    // One group for every preview rather than one per pull request. A log group
    // is not deleted by the stack that stopped writing to it if that stack fails
    // to delete, and previews are the workload most likely to fail to delete.
    this.logGroup = new logs.LogGroup(this, 'PreviewLogGroup', {
      logGroupName: `/ecs/${envName}`,
      retention: logRetention,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (this.logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'No customer-managed KMS key. CloudWatch Logs is encrypted at rest with an ' +
            'AWS-managed key regardless; a CMK adds a key policy to maintain and a monthly ' +
            'charge, and buys control over decryption that IAM on this log group already ' +
            'provides. What is in here is a preview application writing about fixtures.',
        },
      ],
    });

    // ── Security groups ───────────────────────────────────────────────────────
    const albSecurityGroup = new ec2.SecurityGroup(this, 'PreviewAlbSg', {
      securityGroupName: `${envName}-alb-sg`,
      vpc: props.vpc,
      description: 'Shared preview ALB: HTTP/HTTPS inbound, container port outbound',
      allowAllOutbound: false,
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'HTTP from internet IPv6');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
    albSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv6(),
      ec2.Port.tcp(443),
      'HTTPS from internet IPv6',
    );

    (albSecurityGroup.node.defaultChild as ec2.CfnSecurityGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_260',
          comment:
            'Port 80 is open to the internet and serves exactly one thing: a 301 to HTTPS. ' +
            'Closing it does not stop anyone reaching the preview over plaintext, it stops ' +
            'them being redirected off it.',
        },
      ],
    });

    this.taskSecurityGroup = new ec2.SecurityGroup(this, 'PreviewTaskSg', {
      securityGroupName: `${envName}-task-sg`,
      vpc: props.vpc,
      description: 'Shared by every preview task: inbound from the preview ALB only',
      allowAllOutbound: true,
    });
    this.taskSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(containerPort),
      'From the shared preview ALB',
    );
    albSecurityGroup.addEgressRule(
      this.taskSecurityGroup,
      ec2.Port.tcp(containerPort),
      'To preview tasks',
    );

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'PreviewDbSg', {
      securityGroupName: `${envName}-db-sg`,
      vpc: props.vpc,
      description: 'Shared preview PostgreSQL instance',
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      this.taskSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from preview tasks',
    );

    // ── Load balancer ─────────────────────────────────────────────────────────
    this.alb = new elbv2.ApplicationLoadBalancer(this, 'PreviewAlb', {
      loadBalancerName: `${envName}-alb`,
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: props.albDeletionProtection ?? false,
      idleTimeout: cdk.Duration.seconds(60),
    });

    (this.alb.node.defaultChild as elbv2.CfnLoadBalancer).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_91',
          comment:
            'No access logging. It would need an S3 bucket, a bucket policy, and a lifecycle ' +
            'rule standing permanently alongside a load balancer whose traffic is reviewers ' +
            'clicking on branches. When a preview misbehaves the answer is in the ECS task ' +
            'logs or ECS Exec, not in a request log.',
        },
      ],
    });

    this.alb.addListener('PreviewHttpListener', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: 'HTTPS',
        permanent: true,
      }),
    });

    // `routing.http.drop_invalid_header_fields.enabled` is off by default: the
    // ALB forwards headers whose names contain characters HTTP does not allow,
    // and a backend that normalises them differently to the ALB is how request
    // smuggling starts.
    this.alb.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');

    this.httpsListener = this.alb.addListener('PreviewHttpsListener', {
      port: 443,
      certificates: [
        acm.Certificate.fromCertificateArn(this, 'PreviewCertificate', props.certificateArn),
      ],
      // Not `SslPolicy.RECOMMENDED`, which is still the 2016 policy and
      // negotiates TLS 1.0 and 1.1. This is the current recommendation:
      // TLS 1.3, falling back no further than 1.2.
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      // Every hostname under the wildcard record reaches this listener,
      // including previews that have been deleted. Saying so is the only
      // honest default; anything else serves an unrelated pull request.
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'No preview environment is deployed at this address.',
      }),
    });

    if (props.hostedZone) {
      new route53.ARecord(this, 'PreviewWildcardRecord', {
        zone: props.hostedZone,
        recordName: `*.${props.previewDomain}`,
        target: route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(this.alb),
        ),
        comment: 'Wildcard for every per-PR preview environment',
      });
    }

    // ── Shared database ───────────────────────────────────────────────────────
    // One instance, one database per pull request. Previews are throwaway, so
    // this instance is deliberately not configured like the production one in
    // `rds-stack.ts`: no Multi-AZ, no backups, no Performance Insights. Losing
    // it costs a redeploy of whatever previews are open, and the data in it is
    // seeded fixtures by construction.
    this.databaseSecret = new cdk.aws_secretsmanager.Secret(this, 'PreviewDbSecret', {
      secretName: `/${envName}/rds/master-credentials`,
      description: 'Master credentials for the shared preview PostgreSQL instance',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (this.databaseSecret.node.defaultChild as cdk.aws_secretsmanager.CfnSecret).addMetadata(
      'checkov',
      {
        skip: [
          {
            id: 'CKV_AWS_149',
            comment:
              'AWS-managed key rather than a CMK. This secret is generated by this stack, ' +
              'read by task execution roles in the same account, and destroyed with the ' +
              'preview database it belongs to — there is no cross-account grant or ' +
              'independent rotation schedule for a CMK to express.',
          },
        ],
      },
    );

    this.database = new rds.DatabaseInstance(this, 'PreviewDb', {
      instanceIdentifier: `${envName}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      instanceType:
        props.databaseInstanceType ??
        ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [databaseSecurityGroup],
      multiAz: false,
      allocatedStorage: props.databaseAllocatedStorageGiB ?? 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      // `postgres` stays the maintenance database the admin container connects
      // to; the per-PR databases are created inside the instance at deploy time.
      databaseName: undefined,
      credentials: rds.Credentials.fromSecret(this.databaseSecret),
      backupRetention: cdk.Duration.days(0),
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoMinorVersionUpgrade: true,
      iamAuthentication: true,
      publiclyAccessible: false,
    });

    (this.database.node.defaultChild as rds.CfnDBInstance).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_157',
          comment:
            'Single-AZ on purpose: this instance holds seeded fixtures for open pull ' +
            'requests. A failover buys nothing that redeploying the previews does not, ' +
            'and doubles the standing cost of the whole preview system.',
        },
        {
          id: 'CKV_AWS_293',
          comment:
            'Deletion protection off on purpose: the preview stack has to be destroyable ' +
            'in one command, and nothing in it is worth protecting from deletion.',
        },
        {
          id: 'CKV_AWS_129',
          comment:
            'No CloudWatch log exports: preview query logs are charged per ingested GB and ' +
            'read by nobody. Application logs go to the shared preview log group.',
        },
        {
          id: 'CKV_AWS_353',
          comment:
            'Performance Insights off: it is a production capacity-planning tool, and the ' +
            'load on this instance is whatever a reviewer clicked on.',
        },
        {
          id: 'CKV_AWS_118',
          comment:
            'Enhanced monitoring off: same reasoning as Performance Insights, plus it bills ' +
            'per instance per month for a database that exists to hold fixtures.',
        },
        {
          id: 'CKV_AWS_226',
          comment:
            'No automated backups (retention 0): every byte in here is regenerated by the ' +
            'seed task on the next deploy, so a backup would restore fixtures from fixtures.',
        },
        {
          id: 'CKV_AWS_161',
          comment:
            'IAM database authentication is enabled; this check reads the property from the ' +
            'engine-specific field and does not see it on the instance resource.',
        },
      ],
    });

    // ── Database admin task ───────────────────────────────────────────────────
    // `CREATE DATABASE` cannot run inside a transaction and needs a connection
    // to a *different* database, so it cannot be part of the application's own
    // migration step. Running it as a throwaway Fargate task with the stock
    // Postgres image keeps it out of a Lambda, which would otherwise need a
    // bundled driver and a VPC attachment to reach the instance at all.
    const adminExecutionRole = new iam.Role(this, 'PreviewDbAdminExecutionRole', {
      roleName: `${envName}-db-admin-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
      description: 'Pulls the psql image and injects the preview database password',
    });
    this.databaseSecret.grantRead(adminExecutionRole);

    this.databaseAdminTaskDefinition = new ecs.FargateTaskDefinition(this, 'PreviewDbAdminTask', {
      family: `${envName}-db-admin`,
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: adminExecutionRole,
      taskRole: new iam.Role(this, 'PreviewDbAdminTaskRole', {
        roleName: `${envName}-db-admin-task-role`,
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description: 'Runtime role for the preview database admin task (no AWS API calls)',
      }),
    });

    this.databaseAdminTaskDefinition.addContainer(DATABASE_ADMIN_CONTAINER_NAME, {
      image: ecs.ContainerImage.fromRegistry(databaseClientImage),
      entryPoint: ['/bin/sh', '-c'],
      command: [DATABASE_ADMIN_SCRIPT],
      environment: {
        PGHOST: this.database.instanceEndpoint.hostname,
        PGPORT: cdk.Token.asString(this.database.instanceEndpoint.port),
        PGDATABASE: 'postgres',
        PREVIEW_DATABASE_PREFIX: PREVIEW_DATABASE_PREFIX,
      },
      secrets: {
        PGUSER: ecs.Secret.fromSecretsManager(this.databaseSecret, 'username'),
        PGPASSWORD: ecs.Secret.fromSecretsManager(this.databaseSecret, 'password'),
      },
      logging: ecs.LogDrivers.awsLogs({ logGroup: this.logGroup, streamPrefix: 'db-admin' }),
      readonlyRootFilesystem: true,
      essential: true,
    });

    // ── Reaper ────────────────────────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'PreviewReaperTopic', {
      topicName: `${envName}-reaper-notifications`,
      displayName: 'Preview environment reaper',
      enforceSSL: true,
      // The AWS-managed SNS key rather than a CMK: encryption at rest with no
      // key to rotate, no key policy to maintain, and no monthly charge. A CMK
      // would only add something if these messages had to be readable across
      // accounts under a separate grant, and they are stack names.
      masterKey: kms.Alias.fromAliasName(this, 'PreviewSnsKey', 'alias/aws/sns'),
    });

    const reaperLogGroup = new logs.LogGroup(this, 'PreviewReaperLogGroup', {
      logGroupName: `/aws/lambda/${envName}-reaper`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (reaperLogGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'Same reasoning as the shared preview log group: AWS-managed encryption at rest ' +
            'is already in force, and the contents are the reaper saying which stacks it ' +
            'deleted.',
        },
      ],
    });

    const reaperRole = new iam.Role(this, 'PreviewReaperRole', {
      roleName: `${envName}-reaper-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Deletes closed and expired preview stacks',
    });
    reaperLogGroup.grantWrite(reaperRole);

    // DescribeStacks has no resource-level permissions — the API refuses a
    // scoped policy — so the reaper reads every stack and filters on tags. Only
    // DeleteStack, the call that destroys something, is scoped by name.
    reaperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStacks',
        actions: ['cloudformation:DescribeStacks'],
        resources: ['*'],
      }),
    );
    reaperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DeletePreviewStacks',
        actions: ['cloudformation:DeleteStack'],
        resources: [
          this.formatArn({
            service: 'cloudformation',
            resource: 'stack',
            resourceName: `${previewStackNamePrefix(envName)}*/*`,
          }),
        ],
      }),
    );
    reaperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DropPreviewDatabases',
        actions: ['ecs:RunTask'],
        resources: [
          // Every revision of this family, not the one that happens to be
          // current. RunTask authorises against the revision ARN, and each
          // re-register mints a new one — pinning the revision would leave the
          // reaper unable to drop a database the next time the admin task
          // definition changes, which is exactly the kind of break nobody
          // notices until an environment needs collecting.
          this.formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: `${this.databaseAdminTaskDefinition.family}:*`,
          }),
        ],
        conditions: { ArnEquals: { 'ecs:cluster': this.cluster.clusterArn } },
      }),
    );
    reaperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassAdminTaskRoles',
        actions: ['iam:PassRole'],
        resources: [
          this.databaseAdminTaskDefinition.executionRole!.roleArn,
          this.databaseAdminTaskDefinition.taskRole.roleArn,
        ],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      }),
    );
    this.notificationTopic.grantPublish(reaperRole);
    if (props.githubTokenSecretArn) {
      reaperRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadGitHubToken',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.githubTokenSecretArn],
        }),
      );
    }

    const privateSubnetIds = props.vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
    }).subnetIds;

    this.reaperFunction = new lambda.Function(this, 'PreviewReaperFunction', {
      functionName: `${envName}-reaper`,
      description: 'Deletes preview stacks whose pull request closed, or that outlived their TTL',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: reaperRole,
      logGroup: reaperLogGroup,
      timeout: cdk.Duration.minutes(5),
      reservedConcurrentExecutions: 1,
      environment: {
        STACK_NAME_PREFIX: previewStackNamePrefix(envName),
        SHARED_STACK_NAME: this.stackName,
        PREVIEW_TAG_KEY,
        PREVIEW_PR_NUMBER_TAG_KEY,
        MAX_LIFETIME_HOURS: String(maxLifetimeHours),
        UNKNOWN_STATE_TTL_HOURS: String(unknownStateTtlHours),
        MAX_DELETIONS_PER_RUN: String(maxDeletionsPerRun),
        REPOSITORY: props.repository,
        GITHUB_API_URL: props.githubApiUrl ?? 'https://api.github.com',
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn ?? '',
        SNS_TOPIC_ARN: this.notificationTopic.topicArn,
        DRY_RUN: String(reaperDryRun),
        DATABASE_ADMIN_CLUSTER: this.cluster.clusterArn,
        DATABASE_ADMIN_TASK_DEFINITION: this.databaseAdminTaskDefinition.taskDefinitionArn,
        DATABASE_ADMIN_CONTAINER: DATABASE_ADMIN_CONTAINER_NAME,
        DATABASE_ADMIN_SUBNETS: JSON.stringify(privateSubnetIds),
        DATABASE_ADMIN_SECURITY_GROUPS: JSON.stringify([
          this.taskSecurityGroup.securityGroupId,
        ]),
        PREVIEW_DATABASE_PREFIX,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(PREVIEW_REAPER_SOURCE),
    });

    (this.reaperFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: the invoker is a schedule, so a failed sweep is retried by the next ' +
            'one an hour later rather than replayed from a queue. Nothing in a sweep is ' +
            'worth resuming — it re-reads every stack from scratch each time.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls CloudFormation, ECS, SNS, Secrets Manager, and ' +
            'the GitHub API. Attaching it to the VPC would need a NAT gateway or four ' +
            'interface endpoints and would not bring it closer to anything it talks to.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: they hold stack-name prefixes, ' +
            'timeouts, and ARNs. The GitHub token is read from Secrets Manager at ' +
            'invocation, never placed in the environment.',
        },
      ],
    });

    new events.Rule(this, 'PreviewReaperSchedule', {
      ruleName: `${envName}-reaper-schedule`,
      description: 'Hourly sweep for closed and expired preview environments',
      schedule: props.reaperSchedule ?? events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(this.reaperFunction)],
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    // Deliberately *not* tagged with PREVIEW_TAG_KEY. That tag is what tells the
    // reaper a stack is disposable, and this stack is the one thing in the
    // system that is not. The handler refuses SHARED_STACK_NAME as well, so the
    // guard survives someone adding the tag by hand.
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'PreviewAlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: `Point *.${props.previewDomain} at this name`,
      exportName: `${envName}-alb-dns`,
    });

    new cdk.CfnOutput(this, 'PreviewClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster every preview service runs in',
      exportName: `${envName}-cluster-name`,
    });

    new cdk.CfnOutput(this, 'PreviewDbAdminTaskFamily', {
      value: this.databaseAdminTaskDefinition.family,
      description: 'Task definition that creates and drops per-PR databases',
      exportName: `${envName}-db-admin-task-family`,
    });

    new cdk.CfnOutput(this, 'PreviewTaskSubnets', {
      value: privateSubnetIds.join(','),
      description: 'Subnets to run preview tasks and the database admin task in',
      exportName: `${envName}-task-subnets`,
    });

    new cdk.CfnOutput(this, 'PreviewTaskSecurityGroup', {
      value: this.taskSecurityGroup.securityGroupId,
      description: 'Security group to run preview tasks and the database admin task with',
      exportName: `${envName}-task-security-group`,
    });

    new cdk.CfnOutput(this, 'PreviewReaperTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'SNS topic the reaper reports deletions and failures to',
      exportName: `${envName}-reaper-topic-arn`,
    });
  }
}

/** Stack-name prefix shared by every per-PR stack, and the reaper's delete scope. */
export const previewStackNamePrefix = (envName: string): string => `${envName}-pr-`;

/** Name of the database belonging to a pull request. */
export const previewDatabaseName = (prNumber: number): string =>
  `${PREVIEW_DATABASE_PREFIX}${prNumber}`;

/**
 * Entry point of the database admin container.
 *
 * Reads `PREVIEW_DB_ACTION` (`create` or `drop`) and `PREVIEW_DB_NAME` from the
 * run-task overrides. The name is matched against the preview prefix before any
 * SQL is built, which is what stops a wrong override — a typo, an empty
 * variable, a reaper bug — from dropping the application's own database. It is
 * also what makes interpolating the name into the statement safe.
 */
export const DATABASE_ADMIN_SCRIPT = `set -eu
: "\${PREVIEW_DB_ACTION:?must be create or drop}"
: "\${PREVIEW_DB_NAME:?must be set}"
: "\${PREVIEW_DATABASE_PREFIX:?must be set}"

case "$PREVIEW_DB_NAME" in
  "$PREVIEW_DATABASE_PREFIX"[0-9]*) ;;
  *)
    echo "refusing to \${PREVIEW_DB_ACTION} '\${PREVIEW_DB_NAME}': not a preview database" >&2
    exit 1
    ;;
esac

case "$PREVIEW_DB_ACTION" in
  create)
    # Idempotent: every push to the pull request runs this again.
    if psql -v ON_ERROR_STOP=1 -tAc \\
        "SELECT 1 FROM pg_database WHERE datname = '\${PREVIEW_DB_NAME}'" | grep -q 1; then
      echo "database \${PREVIEW_DB_NAME} already exists"
    else
      psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \\"\${PREVIEW_DB_NAME}\\""
      echo "created database \${PREVIEW_DB_NAME}"
    fi
    ;;
  drop)
    # FORCE terminates sessions still connected from a service that has not
    # finished draining. Without it the drop fails whenever teardown is quick.
    psql -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \\"\${PREVIEW_DB_NAME}\\" WITH (FORCE)"
    echo "dropped database \${PREVIEW_DB_NAME}"
    ;;
  *)
    echo "unknown PREVIEW_DB_ACTION '\${PREVIEW_DB_ACTION}'" >&2
    exit 1
    ;;
esac
`;

/**
 * The reaper, shipped inline.
 *
 * Exported as a string so `test/preview-reaper-handler.test.ts` can compile and
 * run it: `lambda.Code.fromInline` means nothing else in the build ever parses
 * it, and every mistake available in here is one that fails quietly — a sweep
 * that deletes an environment somebody is still reviewing, or one that deletes
 * nothing and lets the bill grow.
 */
export const PREVIEW_REAPER_SOURCE = `
'use strict';
const {
  CloudFormationClient,
  DescribeStacksCommand,
  DeleteStackCommand,
} = require('@aws-sdk/client-cloudformation');
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION;
const cloudformation = new CloudFormationClient({ region });
const ecs = new ECSClient({ region });
const sns = new SNSClient({ region });
const secretsManager = new SecretsManagerClient({ region });

const STACK_NAME_PREFIX = process.env.STACK_NAME_PREFIX;
const SHARED_STACK_NAME = process.env.SHARED_STACK_NAME;
const PREVIEW_TAG_KEY = process.env.PREVIEW_TAG_KEY;
const PREVIEW_PR_NUMBER_TAG_KEY = process.env.PREVIEW_PR_NUMBER_TAG_KEY;
const MAX_LIFETIME_HOURS = parseFloat(process.env.MAX_LIFETIME_HOURS);
const UNKNOWN_STATE_TTL_HOURS = parseFloat(process.env.UNKNOWN_STATE_TTL_HOURS);
const MAX_DELETIONS_PER_RUN = parseInt(process.env.MAX_DELETIONS_PER_RUN, 10);
const REPOSITORY = process.env.REPOSITORY;
const GITHUB_API_URL = process.env.GITHUB_API_URL;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const DRY_RUN = process.env.DRY_RUN === 'true';
const DATABASE_ADMIN_CLUSTER = process.env.DATABASE_ADMIN_CLUSTER;
const DATABASE_ADMIN_TASK_DEFINITION = process.env.DATABASE_ADMIN_TASK_DEFINITION;
const DATABASE_ADMIN_CONTAINER = process.env.DATABASE_ADMIN_CONTAINER;
const DATABASE_ADMIN_SUBNETS = JSON.parse(process.env.DATABASE_ADMIN_SUBNETS);
const DATABASE_ADMIN_SECURITY_GROUPS = JSON.parse(process.env.DATABASE_ADMIN_SECURITY_GROUPS);
const PREVIEW_DATABASE_PREFIX = process.env.PREVIEW_DATABASE_PREFIX;

/** Stack states in which a delete is already happening or already done. */
const TERMINAL_STATES = ['DELETE_IN_PROGRESS', 'DELETE_COMPLETE'];

const tagValue = (stack, key) => {
  const tag = (stack.Tags || []).find((candidate) => candidate.Key === key);
  return tag ? tag.Value : undefined;
};

/** Every stack in the account, paginated. DescribeStacks cannot filter by tag. */
async function listStacks() {
  const stacks = [];
  let nextToken;

  do {
    const page = await cloudformation.send(
      new DescribeStacksCommand(nextToken ? { NextToken: nextToken } : {}),
    );
    stacks.push(...(page.Stacks || []));
    nextToken = page.NextToken;
  } while (nextToken);

  return stacks;
}

/**
 * Preview stacks, identified by three independent signals that must agree: the
 * marker tag, a numeric pull-request tag, and the stack-name prefix the delete
 * policy is scoped to. Requiring all three means a stack has to be mislabelled
 * in three places before the reaper will touch it, and the third is enforced by
 * IAM rather than by this code.
 */
function selectPreviewStacks(stacks) {
  const previews = [];

  for (const stack of stacks) {
    const name = stack.StackName;

    if (name === SHARED_STACK_NAME) continue;
    if (!name || !name.startsWith(STACK_NAME_PREFIX)) continue;
    if (tagValue(stack, PREVIEW_TAG_KEY) !== 'true') continue;
    if (TERMINAL_STATES.includes(stack.StackStatus)) continue;

    const prNumber = parseInt(tagValue(stack, PREVIEW_PR_NUMBER_TAG_KEY) || '', 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) continue;

    previews.push({
      stackName: name,
      prNumber,
      stackStatus: stack.StackStatus,
      createdAt: stack.CreationTime ? new Date(stack.CreationTime).getTime() : undefined,
    });
  }

  return previews;
}

async function githubToken() {
  if (!GITHUB_TOKEN_SECRET_ARN) return undefined;

  const response = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: GITHUB_TOKEN_SECRET_ARN }),
  );
  const raw = response.SecretString;
  if (!raw) return undefined;

  try {
    const parsed = JSON.parse(raw);
    return parsed.token || parsed.GITHUB_TOKEN || undefined;
  } catch (error) {
    // A secret created by hand is usually the bare token, not JSON.
    return raw.trim();
  }
}

/**
 * 'open', 'closed', or 'unknown'.
 *
 * 'unknown' is returned for every failure — no token, a rate limit, an outage,
 * a repository rename — and never confused with 'closed'. The difference
 * decides whether an environment somebody is reviewing survives a GitHub
 * incident.
 */
async function pullRequestState(prNumber, token) {
  if (!token || !REPOSITORY) return 'unknown';

  try {
    const response = await fetch(
      GITHUB_API_URL + '/repos/' + REPOSITORY + '/pulls/' + prNumber,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: 'Bearer ' + token,
          'user-agent': 'preview-environment-reaper',
          'x-github-api-version': '2022-11-28',
        },
      },
    );

    // A pull request that never existed is not one to keep alive forever, but
    // it is also not evidence of a closed one — leave it to the lifetime bound.
    if (response.status === 404) return 'unknown';
    if (!response.ok) return 'unknown';

    const body = await response.json();
    return body.state === 'closed' ? 'closed' : 'open';
  } catch (error) {
    console.error('github lookup failed for #' + prNumber + ': ' + error.message);
    return 'unknown';
  }
}

/**
 * Whether a preview should be deleted, and why.
 *
 * The three rules are ordered by how much they know. A closed pull request is
 * a fact about the work and outranks age. The absolute lifetime is the bound
 * that applies whatever GitHub says, because an open pull request nobody has
 * touched in a week is still costing money. The unknown-state fallback is
 * deliberately last and deliberately longer than one sweep: it only ever fires
 * for environments whose pull request could not be read for hours.
 */
function decide(preview, state, nowMs) {
  const ageHours =
    preview.createdAt === undefined ? undefined : (nowMs - preview.createdAt) / 3600000;

  if (state === 'closed') {
    return { delete: true, reason: 'pull-request-closed' };
  }

  if (ageHours !== undefined && ageHours >= MAX_LIFETIME_HOURS) {
    return {
      delete: true,
      reason: 'max-lifetime-exceeded',
      detail: Math.round(ageHours) + 'h old, limit ' + MAX_LIFETIME_HOURS + 'h',
    };
  }

  if (state === 'unknown' && ageHours !== undefined && ageHours >= UNKNOWN_STATE_TTL_HOURS) {
    return {
      delete: true,
      reason: 'pull-request-state-unknown',
      detail: Math.round(ageHours) + 'h old, limit ' + UNKNOWN_STATE_TTL_HOURS + 'h',
    };
  }

  return { delete: false, reason: state === 'open' ? 'pull-request-open' : 'within-limits' };
}

/**
 * Drop the pull request's database before deleting its stack.
 *
 * Before, not after, because the drop is a Fargate task that takes a minute and
 * the stack delete takes several, and this Lambda cannot wait for either. Doing
 * it in this order needs no state carried between sweeps: if the delete then
 * fails, the next sweep drops an already-dropped database, which the admin
 * script treats as success. The reverse order would need the reaper to remember
 * which vanished stacks still owed a database, and forgetting leaks one
 * silently.
 */
async function dropDatabase(prNumber) {
  await ecs.send(
    new RunTaskCommand({
      cluster: DATABASE_ADMIN_CLUSTER,
      taskDefinition: DATABASE_ADMIN_TASK_DEFINITION,
      launchType: 'FARGATE',
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: DATABASE_ADMIN_SUBNETS,
          securityGroups: DATABASE_ADMIN_SECURITY_GROUPS,
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: DATABASE_ADMIN_CONTAINER,
            environment: [
              { name: 'PREVIEW_DB_ACTION', value: 'drop' },
              { name: 'PREVIEW_DB_NAME', value: PREVIEW_DATABASE_PREFIX + prNumber },
            ],
          },
        ],
      },
    }),
  );
}

async function notify(subject, message) {
  if (!SNS_TOPIC_ARN) return;

  await sns.send(
    new PublishCommand({ TopicArn: SNS_TOPIC_ARN, Subject: subject, Message: message }),
  );
}

exports.handler = async () => {
  const nowMs = Date.now();
  const token = await githubToken();
  const previews = selectPreviewStacks(await listStacks());

  const deleted = [];
  const kept = [];
  const failed = [];

  const condemned = [];
  for (const preview of previews) {
    const state = await pullRequestState(preview.prNumber, token);
    const verdict = decide(preview, state, nowMs);

    if (verdict.delete) {
      condemned.push({ preview, verdict });
    } else {
      kept.push({ stackName: preview.stackName, reason: verdict.reason });
    }
  }

  // Oldest first, so a run that hits the cap still makes progress on the
  // environments that have been costing money the longest.
  condemned.sort((a, b) => (a.preview.createdAt || 0) - (b.preview.createdAt || 0));

  const batch = condemned.slice(0, MAX_DELETIONS_PER_RUN);
  const deferred = condemned.slice(MAX_DELETIONS_PER_RUN);

  for (const { preview, verdict } of batch) {
    const record = {
      stackName: preview.stackName,
      prNumber: preview.prNumber,
      reason: verdict.reason,
      detail: verdict.detail,
    };

    if (DRY_RUN) {
      kept.push({ ...record, reason: 'dry-run:' + verdict.reason });
      continue;
    }

    try {
      await dropDatabase(preview.prNumber);
      await cloudformation.send(new DeleteStackCommand({ StackName: preview.stackName }));
      deleted.push(record);
    } catch (error) {
      failed.push({ ...record, error: error.message });
      console.error('failed to reap ' + preview.stackName + ': ' + error.message);
    }
  }

  const summary = {
    dryRun: DRY_RUN,
    examined: previews.length,
    deleted,
    kept,
    failed,
    // Never silent: a capped run says how many it did not get to, so a sweep
    // that is permanently behind is visible rather than looking like a clean one.
    deferredByCap: deferred.map((entry) => entry.preview.stackName),
  };

  console.log(JSON.stringify(summary));

  if (failed.length > 0) {
    await notify(
      'Preview reaper: ' + failed.length + ' deletion(s) failed',
      JSON.stringify(summary, null, 2),
    );
  } else if (deleted.length > 0) {
    await notify(
      'Preview reaper: deleted ' + deleted.length + ' environment(s)',
      JSON.stringify(summary, null, 2),
    );
  }

  return summary;
};
`;
