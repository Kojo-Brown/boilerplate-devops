import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  DRILL_POLL_INTERVAL_SECONDS,
  GAME_DAY_NAMESPACE,
  GAME_DAY_SCENARIOS,
  GameDayScenario,
  MAX_DRILL_INSTANCE_AGE_SECONDS,
  METRIC_DRILL_INSTANCE_AGE,
  METRIC_MEASURED_RESTORE_SECONDS,
  METRIC_RESTORE_VERIFIED,
  RECOVERY_OBJECTIVES,
  RESTORED_BYTES_FLOOR,
  RESTORED_BYTES_TOLERANCE,
  RESTORE_TLS_CHAIN_UNVERIFIED,
  RESTORE_VERIFICATION_CHECKS,
  RecoveryObjective,
  assertValidGameDayCatalogue,
  drillInstanceIdentifier,
  gameDayDocumentName,
  objectiveFor,
  rehearsalParameterName,
  restorePointStaleAfterSeconds,
} from './game-days';

/** How often the sweeper looks for a drill instance nobody is using, in seconds. */
export const SWEEPER_INTERVAL_SECONDS = 3600;

/*
 * The three function names, as literals.
 *
 * Used both for the `functionName` prop and for the `FunctionName` the
 * automation document invokes, rather than reading `fn.functionName` for the
 * second. That attribute is a token, so it synthesises as a `Ref` — which
 * deploys correctly and is opaque to `tools/audit-game-days.ts`, leaving the
 * rules about *which* function each step invokes unable to see anything. A
 * literal in the document is the difference between a gate that checks the
 * verification step exists and one that checks a step exists.
 */
export const verifierFunctionName = (envName: string): string =>
  `${envName}-restore-drill-verifier`;
export const conductorFunctionName = (envName: string): string =>
  `${envName}-restore-drill-conductor`;
export const sweeperFunctionName = (envName: string): string =>
  `${envName}-restore-drill-sweeper`;

/**
 * `<env>-dr-drill-subnets`: the copy's own DB subnet group.
 *
 * A literal for the same reason the function names are: `subnetGroup.subnetGroupName`
 * is a token, so it synthesises as a `Ref` — which deploys and is opaque to the
 * gate, and this name also has to appear in the restore grant's ARN at synth
 * time.
 */
export const drillSubnetGroupName = (envName: string): string => `${envName}-dr-drill-subnets`;

/**
 * Minutes of `AWS/RDS` history the verifier reads `FreeStorageSpace` over.
 *
 * Fifteen. The metric is published every minute, and a restored instance's first
 * datapoint lands a minute or two after it reports `available` — so a window
 * that only looked at the last five minutes would, on a slow publish, find
 * nothing and fail the one check that is about the data. Fifteen minutes is far
 * enough back to always contain a datapoint and far enough forward that the
 * latest one in it is about the instance as it is now.
 */
export const STORAGE_LOOKBACK_MINUTES = 15;

/**
 * How many times the verifier re-reads `FreeStorageSpace` before giving up, and
 * how long it waits between tries.
 *
 * Ten tries thirty seconds apart, so five minutes, against a drill that has
 * already taken forty. The alternative shape — read once, and treat "no
 * datapoint" as a pass because the instance is clearly fine — is how the only
 * check here that can see an empty restore comes to never fire.
 */
export const STORAGE_POLL_ATTEMPTS = 10;
export const STORAGE_POLL_INTERVAL_MS = 30_000;

export interface BackupRestoreDrillStackProps extends cdk.StackProps {
  /** Environment name. Decides which scenarios are built here — see the class docs. */
  readonly envName: string;
  /** VPC the restored copy and the verifier both live in. */
  readonly vpc: ec2.IVpc;
  /**
   * Identifier of the instance whose backups are restored.
   *
   * Read-only from this stack's point of view, and the gate holds it that way:
   * nothing in here is granted a write against this identifier. The drill reads
   * its `LatestRestorableTime`, its instance class, its parameter group and its
   * `FreeStorageSpace`, and restores into an instance of its own.
   */
  readonly sourceInstanceIdentifier: string;
  /**
   * Port the engine listens on (default: 5432).
   *
   * A literal for the same reason `FailoverGameDayStack` takes one: the security
   * group rules want a number, and `instanceEndpoint.port` is a string on the
   * CloudFormation resource.
   */
  readonly databasePort?: number;
  /** Emails subscribed to the drill topic. */
  readonly notificationEmails?: readonly string[];
  /** Override the objectives. Tests only. */
  readonly objectives?: readonly RecoveryObjective[];
  /** Override the scenarios. Tests only. */
  readonly scenarios?: readonly GameDayScenario[];
  /**
   * How long the automation waits for the restored instance to be `available`.
   *
   * Default: three times the objective's RTO, floored at thirty minutes. Three,
   * rather than something tighter, because this wait timing out is the
   * `restore-not-available-in-time` abort — it should fire when a restore is
   * genuinely not happening, not when one is merely slower than hoped. The
   * measured number is what the objective is judged against; the wait is only
   * what stops the drill running all day.
   */
  readonly restoreTimeoutSeconds?: number;
}

/**
 * Backup and restore drill: restore the database into a copy, verify the copy,
 * measure how long it took, and delete it.
 *
 * ## What was wrong with "backups are enabled"
 *
 * `backupRetention: 7` is one line in `lib/rds-stack.ts`, and the signal that it
 * is working is `LatestRestorableTime` advancing — which
 * `FailoverGameDayStack`'s recorder has been publishing as the restore path's
 * live RPO since the previous item. That number advancing is evidence that
 * backups are being *taken*. It is not evidence that anything can be restored
 * *from* them, and the two are different claims that look identical on a
 * dashboard. Meanwhile §3 of docs/game-days.md carried an RTO of 1800 seconds
 * with `status: 'declared'` on it: an honest admission that the number was a
 * guess, which is better than a false number and is not a measurement.
 *
 * ## Architecture
 *
 *     schedule (every 30 days, no approval — see below)
 *       └─ preflight    → there is a restore point, and no drill copy is up
 *          restore      → RestoreDBInstanceToPointInTime into <env>-dr-drill
 *          wait         → the copy reports available
 *          verify       → seven checks, in the VPC, over the control plane and
 *                         the wire protocol (no SQL — see RESTORE_VERIFICATION_CHECKS)
 *          measure      → InstanceCreateTime → verified-at = MeasuredRestoreSeconds
 *          teardown     → delete the copy
 *          └─ any failure: abort, which deletes the copy and records why
 *
 *     sweeper (every hour)
 *       └─ a drill copy older than six hours with no drill running → delete it
 *
 * Six decisions are the design.
 *
 * **It runs on a schedule, and that is the opposite of `FailoverGameDayStack`.**
 * That exercise reboots a live primary, so it starts from `aws:approve` and
 * never from a timer. This one reads the backups into a second instance and
 * touches nothing live, so the reasoning inverts: a restore drill behind a human
 * gate is a restore drill that runs once, in the week the item shipped. The
 * distinction is data rather than convention — `DESTRUCTIVE_FAULTS` and
 * {@link GameDayScenario.trigger} in `lib/game-days.ts`, with a rule in
 * `validateGameDayCatalogue` that refuses a destructive fault on a schedule and
 * a non-destructive one that declares a cadence nothing honours.
 *
 * **Nothing here can write to the source instance.** The automation role holds
 * `rds:RestoreDBInstanceToPointInTime` and reads, and the two roles that hold
 * `rds:DeleteDBInstance` hold it on exactly one ARN: the drill identifier, which
 * is a literal rather than a prefix precisely so that the grant is a name and
 * not a pattern. `tools/audit-game-days.ts` fails on a delete grant that is not
 * that ARN and on any write in this stack's roles against the source.
 *
 * **The copy is unreachable from the application.** Its own subnet group, its
 * own security group with no egress and one ingress rule from the verifier. A
 * drill that restored production's data into the application's security group
 * would have put a stale, writable copy of the database one connection-string
 * typo away from live traffic, once a month.
 *
 * **Verification does not run a query, and that is a real limitation rather
 * than a shortcut.** There is no PostgreSQL client in this repository —
 * `lambda.Code.fromInline` is how every function here ships and a driver means
 * bundling — so the two checks that would have been queries are replaced by the
 * two that reach the same findings from outside the engine:
 * `engine-negotiates-tls` makes the backend answer PostgreSQL's own
 * `SSLRequest`, which a listener with no postmaster behind it cannot do, and
 * `restored-bytes-match-source` compares the two instances' `FreeStorageSpace`,
 * which catches the restore that completed and brought back an empty volume. See
 * `RESTORE_VERIFICATION_CHECKS` for all seven and docs/game-days.md §12 for what
 * is still not covered.
 *
 * **A failed verification is a successful execution.** The SSM execution's
 * status is not the signal: a drill that restored a copy and found it unusable
 * has done its job, and it still has to delete the copy. So `measure` records
 * the finding, the verifier publishes `RestoreVerified: 0`, teardown runs, and
 * the execution ends green — while `<env>-restore-unverified` goes red and the
 * rehearsal clock is *not* reset, so `<env>-rehearsal-overdue-rds-point-in-time-restore`
 * stays red as well. Both are checked by the gate, because a drill whose only
 * output is an execution status is one nobody finds out about.
 *
 * **The sweeper exists because an operator can cancel an execution.** SSM does
 * not run `onFailure` for a cancelled execution, so the one path that leaves a
 * full-size copy of production running is a human clicking stop between the
 * restore and the teardown — and that copy is silent: it serves no traffic, has
 * no alarms of its own, and looks like a database somebody meant to create. The
 * sweeper publishes {@link METRIC_DRILL_INSTANCE_AGE} hourly (zero when there is
 * no copy, so that a sweeper which stopped reporting is itself alarmed on) and
 * deletes a copy older than {@link MAX_DRILL_INSTANCE_AGE_SECONDS} — but only
 * when no execution of the drill document is in progress, because the only thing
 * worse than an orphaned copy of production is a sweeper that deletes a drill
 * which was still working and reports the backups as unverifiable.
 */
export class BackupRestoreDrillStack extends cdk.Stack {
  /** Drill results and the alarms in this stack. */
  public readonly notificationTopic: sns.Topic;
  /** The seven checks, run inside the VPC against the restored copy. */
  public readonly verifier: lambda.Function;
  /** Preflight, measurement, teardown and the abort record. */
  public readonly conductor: lambda.Function;
  /** Hourly: publishes the drill copy's age and removes an abandoned one. */
  public readonly sweeper: lambda.Function;
  /** Automation documents, keyed by scenario id. Empty where none is allowed here. */
  public readonly documents: Record<string, ssm.CfnDocument>;
  /** Role the drill automation assumes. Can restore and read; cannot delete. */
  public readonly automationRole: iam.Role;
  /** The restored copy's security group: one ingress rule, no egress. */
  public readonly drillSecurityGroup: ec2.SecurityGroup;
  public readonly verifierSecurityGroup: ec2.SecurityGroup;
  /** The copy's own subnet group, so it never joins the application's. */
  public readonly subnetGroup: rds.SubnetGroup;

  constructor(scope: Construct, id: string, props: BackupRestoreDrillStackProps) {
    super(scope, id, props);

    const envName = props.envName;
    const objectives = props.objectives ?? RECOVERY_OBJECTIVES;
    const allScenarios = props.scenarios ?? GAME_DAY_SCENARIOS;
    const databasePort = props.databasePort ?? 5432;
    const drillInstance = drillInstanceIdentifier(envName);

    assertValidGameDayCatalogue(objectives, allScenarios);

    // This stack owns the restore drills and `FailoverGameDayStack` owns the
    // failovers. Filtered by fault as well as by environment so that neither
    // stack emits the other's exercises — a restore drill rendered as a
    // `RebootDBInstance` document would be a forced failover carrying a drill's
    // name, cadence and blast radius.
    const scenarios = allScenarios.filter(
      (scenario) =>
        scenario.fault === 'rds-point-in-time-restore' &&
        scenario.allowedEnvironments.includes(envName),
    );

    // ── Encryption ────────────────────────────────────────────────────────────
    const encryptionKey = new kms.Key(this, 'RestoreDrillEncryptionKey', {
      alias: `alias/${envName}-restore-drill`,
      description: `Encrypts ${envName} restore-drill notifications, logs and results`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch publishes this stack's alarms to the topic below, and a
    // customer-managed key means the service principal has to be named.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
      }),
    );

    // ── Where the drill reports ───────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'RestoreDrillTopic', {
      topicName: `${envName}-restore-drill`,
      displayName: `${envName} backup restore drills`,
      masterKey: encryptionKey,
    });
    for (const email of props.notificationEmails ?? []) {
      this.notificationTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── Where the copy lives ──────────────────────────────────────────────────
    // Its own subnet group rather than the application database's. The group the
    // database uses is created by `RdsStack`'s L2 and carries a generated name,
    // so reaching for it would mean a cross-stack reference; but the reason this
    // is right rather than merely convenient is that the copy should not be in
    // the application's group at all. The subnets are the same private subnets —
    // the restore has to measure the storage path a real recovery would use.
    this.subnetGroup = new rds.SubnetGroup(this, 'DrillSubnetGroup', {
      subnetGroupName: drillSubnetGroupName(envName),
      description: `Subnets the ${envName} restore drill restores its copy into`,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.drillSecurityGroup = new ec2.SecurityGroup(this, 'DrillSecurityGroup', {
      securityGroupName: `${envName}-dr-drill-sg`,
      vpc: props.vpc,
      description:
        `Restored copy of the ${envName} database. One ingress rule, from the verifier, and no ` +
        'egress: the copy initiates nothing and nothing but the verifier reaches it.',
      allowAllOutbound: false,
    });

    this.verifierSecurityGroup = new ec2.SecurityGroup(this, 'VerifierSecurityGroup', {
      securityGroupName: `${envName}-restore-drill-verifier-sg`,
      vpc: props.vpc,
      description: `Verifies the ${envName} restored copy`,
      allowAllOutbound: false,
    });
    this.verifierSecurityGroup.addEgressRule(
      ec2.Peer.securityGroupId(this.drillSecurityGroup.securityGroupId),
      ec2.Port.tcp(databasePort),
      'Negotiate TLS with the restored copy',
    );
    // RDS and CloudWatch are reached over the NAT gateway in the private
    // subnets, which is how every other in-VPC function in this repository
    // reaches a regional API.
    this.verifierSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'RDS DescribeDBInstances and CloudWatch, via the NAT gateway',
    );
    this.drillSecurityGroup.addIngressRule(
      this.verifierSecurityGroup,
      ec2.Port.tcp(databasePort),
      `${envName} restore-drill verifier`,
    );

    // ── The verifier ──────────────────────────────────────────────────────────
    const verifierLogGroup = new logs.LogGroup(this, 'VerifierLogGroup', {
      logGroupName: `/aws/lambda/${envName}-restore-drill-verifier`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const verifierRole = new iam.Role(this, 'VerifierRole', {
      roleName: `${envName}-restore-drill-verifier-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Verifies the copy the ${envName} restore drill produced`,
    });
    verifierRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    verifierRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );
    verifierRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadBothInstances',
        // DescribeDBInstances is not resource-scopable: it takes an identifier
        // as a filter and authorises against `*` regardless.
        actions: ['rds:DescribeDBInstances'],
        resources: ['*'],
      }),
    );
    verifierRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadStorageMetrics',
        // `AWS/RDS` `FreeStorageSpace`, for the source and for the copy. The
        // only check here that can see an empty restore is a comparison between
        // two numbers RDS published.
        actions: ['cloudwatch:GetMetricData'],
        resources: ['*'],
      }),
    );
    verifierRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishTheVerdict',
        actions: ['cloudwatch:PutMetricData'],
        // PutMetricData takes no resource, so the namespace condition is the
        // only scope available.
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': GAME_DAY_NAMESPACE } },
      }),
    );

    this.verifier = new lambda.Function(this, 'RestoreDrillVerifier', {
      functionName: verifierFunctionName(envName),
      description:
        `Runs the ${RESTORE_VERIFICATION_CHECKS.length} restore-verification checks against the ` +
        `${envName} restored copy and publishes the verdict`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: verifierRole,
      // Long, because of one check: `FreeStorageSpace` for a minutes-old
      // instance may not be in CloudWatch yet, and the verifier polls for up to
      // STORAGE_POLL_ATTEMPTS × STORAGE_POLL_INTERVAL_MS rather than treating a
      // missing datapoint as a pass. Plus the TLS probe's own deadline.
      timeout: cdk.Duration.seconds(
        Math.ceil((STORAGE_POLL_ATTEMPTS * STORAGE_POLL_INTERVAL_MS) / 1000) + 120,
      ),
      // One. Two drills cannot run at once — the drill identifier is a single
      // literal and `no-drill-instance-present` refuses the second — so a second
      // concurrent verification would be verifying the same copy twice.
      reservedConcurrentExecutions: 1,
      environmentEncryption: encryptionKey,
      logGroup: verifierLogGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.verifierSecurityGroup],
      environment: {
        ENV_NAME: envName,
        NAMESPACE: GAME_DAY_NAMESPACE,
        SOURCE_INSTANCE: props.sourceInstanceIdentifier,
        DRILL_INSTANCE: drillInstance,
        DRILL_PORT: String(databasePort),
        CHECKS: JSON.stringify(RESTORE_VERIFICATION_CHECKS),
        BYTES_TOLERANCE: String(RESTORED_BYTES_TOLERANCE),
        BYTES_FLOOR: String(RESTORED_BYTES_FLOOR),
        STORAGE_LOOKBACK_MINUTES: String(STORAGE_LOOKBACK_MINUTES),
        STORAGE_POLL_ATTEMPTS: String(STORAGE_POLL_ATTEMPTS),
        STORAGE_POLL_INTERVAL_MS: String(STORAGE_POLL_INTERVAL_MS),
        TLS_CHAIN_NOTE: RESTORE_TLS_CHAIN_UNVERIFIED,
        TLS_TIMEOUT_MS: '15000',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(RESTORE_VERIFIER_SOURCE),
    });

    // ── The conductor ─────────────────────────────────────────────────────────
    const conductorLogGroup = new logs.LogGroup(this, 'ConductorLogGroup', {
      logGroupName: `/aws/lambda/${envName}-restore-drill-conductor`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const conductorRole = new iam.Role(this, 'ConductorRole', {
      roleName: `${envName}-restore-drill-conductor-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Preflights, measures, tears down and records the ${envName} restore drills`,
    });
    conductorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadBothInstances',
        actions: ['rds:DescribeDBInstances'],
        resources: ['*'],
      }),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DeleteTheCopy',
        actions: ['rds:DeleteDBInstance'],
        // One literal ARN, which is why `drillInstanceIdentifier` is a fixed
        // name rather than one with an execution id in it: the difference
        // between this and `<env>-dr-drill-*` is the difference between "can
        // delete the drill copy" and "can delete anything named like one".
        resources: [
          `arn:${this.partition}:rds:${this.region}:${this.account}:db:${drillInstance}`,
        ],
      }),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishTheMeasurement',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': GAME_DAY_NAMESPACE } },
      }),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTheExecutionThatFailed',
        // How the abort record learns which step refused. Every step routes to
        // one abort step, so without this the record would say only that
        // something went wrong. GetAutomationExecution takes no resource.
        actions: ['ssm:GetAutomationExecution'],
        resources: ['*'],
      }),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteTheRehearsalLog',
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: objectives.map(
          (objective) =>
            `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter` +
            rehearsalParameterName(envName, objective.id),
        ),
      }),
    );
    this.notificationTopic.grantPublish(conductorRole);

    this.conductor = new lambda.Function(this, 'RestoreDrillConductor', {
      functionName: conductorFunctionName(envName),
      description: `Preflight, measurement, teardown and abort record for ${envName} restore drills`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: conductorRole,
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 2,
      environmentEncryption: encryptionKey,
      logGroup: conductorLogGroup,
      environment: {
        ENV_NAME: envName,
        NAMESPACE: GAME_DAY_NAMESPACE,
        TOPIC_ARN: this.notificationTopic.topicArn,
        SOURCE_INSTANCE: props.sourceInstanceIdentifier,
        DRILL_INSTANCE: drillInstance,
        RESOLUTION_SECONDS: String(DRILL_POLL_INTERVAL_SECONDS),
        CHECK_COUNT: String(RESTORE_VERIFICATION_CHECKS.length),
        SCENARIOS: JSON.stringify(
          scenarios.map((scenario) => {
            const objective = objectiveFor(scenario, objectives);
            return {
              id: scenario.id,
              title: scenario.title,
              objectiveId: scenario.objectiveId,
              preflight: scenario.preflight,
              rtoSeconds: objective?.rtoSeconds,
              rpoSeconds: objective?.rpoSeconds,
              maxRestorePointStaleSeconds:
                objective === undefined ? undefined : restorePointStaleAfterSeconds(objective),
              parameter: rehearsalParameterName(envName, scenario.objectiveId),
            };
          }),
        ),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(RESTORE_DRILL_CONDUCTOR_SOURCE),
    });

    // ── The sweeper ───────────────────────────────────────────────────────────
    const sweeperLogGroup = new logs.LogGroup(this, 'SweeperLogGroup', {
      logGroupName: `/aws/lambda/${envName}-restore-drill-sweeper`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const sweeperRole = new iam.Role(this, 'SweeperRole', {
      roleName: `${envName}-restore-drill-sweeper-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Reports and removes an abandoned ${envName} restore-drill copy`,
    });
    sweeperRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    sweeperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTheCopy',
        actions: ['rds:DescribeDBInstances'],
        resources: ['*'],
      }),
    );
    sweeperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadDrillExecutions',
        // The check that makes the delete below safe: a drill that is still
        // running keeps its copy, however old it looks.
        // DescribeAutomationExecutions takes no resource.
        actions: ['ssm:DescribeAutomationExecutions'],
        resources: ['*'],
      }),
    );
    sweeperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DeleteTheCopy',
        actions: ['rds:DeleteDBInstance'],
        resources: [
          `arn:${this.partition}:rds:${this.region}:${this.account}:db:${drillInstance}`,
        ],
      }),
    );
    sweeperRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishTheAge',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': GAME_DAY_NAMESPACE } },
      }),
    );
    this.notificationTopic.grantPublish(sweeperRole);

    this.sweeper = new lambda.Function(this, 'RestoreDrillSweeper', {
      functionName: sweeperFunctionName(envName),
      description:
        `Publishes the age of the ${envName} restore-drill copy and deletes one no drill is ` +
        'using — the path an operator cancelling an execution leaves behind',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: sweeperRole,
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 1,
      environmentEncryption: encryptionKey,
      logGroup: sweeperLogGroup,
      environment: {
        ENV_NAME: envName,
        NAMESPACE: GAME_DAY_NAMESPACE,
        TOPIC_ARN: this.notificationTopic.topicArn,
        DRILL_INSTANCE: drillInstance,
        MAX_AGE_SECONDS: String(MAX_DRILL_INSTANCE_AGE_SECONDS),
        DOCUMENT_NAMES: JSON.stringify(
          scenarios.map((scenario) => gameDayDocumentName(envName, scenario.id)),
        ),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(RESTORE_DRILL_SWEEPER_SOURCE),
    });

    new events.Rule(this, 'SweeperSchedule', {
      ruleName: `${envName}-restore-drill-sweeper-schedule`,
      description: 'Report and remove an abandoned restore-drill copy',
      schedule: events.Schedule.rate(cdk.Duration.seconds(SWEEPER_INTERVAL_SECONDS)),
      targets: [new targets.LambdaFunction(this.sweeper)],
    });

    for (const [fn, skips] of [
      [
        this.verifier,
        [
          {
            id: 'CKV_AWS_116',
            comment:
              'No DLQ: SSM Automation invokes this synchronously, so a failure is returned to ' +
              'the step rather than dropped — and the step routes to the abort, which deletes ' +
              'the copy and writes the failure down. An asynchronous dead-letter queue is not ' +
              'reachable from a synchronous invoke, so one here would satisfy the check and ' +
              'catch nothing.',
          },
        ],
      ],
      [
        this.conductor,
        [
          {
            id: 'CKV_AWS_116',
            comment:
              'No DLQ, for the same reason as the verifier: the invoker is SSM Automation, ' +
              'synchronously, and every step routes its failure to the abort step.',
          },
          {
            id: 'CKV_AWS_117',
            comment:
              'Not in a VPC: the conductor calls only the regional RDS, SSM, CloudWatch and ' +
              'SNS APIs and touches no VPC resource. The verifier, which has to open a socket ' +
              'to the restored copy, is in it.',
          },
        ],
      ],
      [
        this.sweeper,
        [
          {
            id: 'CKV_AWS_116',
            comment:
              'No DLQ: the invoker is an hourly schedule and every run recomputes the age from ' +
              'the instance. A failed run is superseded an hour later, and the alarm over the ' +
              'age metric breaches on missing data, so a run that never happened is reported ' +
              'rather than replayed.',
          },
          {
            id: 'CKV_AWS_117',
            comment:
              'Not in a VPC: the sweeper calls only the regional RDS, SSM, CloudWatch and SNS ' +
              'APIs. Attaching it would put the NAT gateway on the path of the thing that stops ' +
              'an orphaned copy of production costing money forever.',
          },
        ],
      ],
    ] as const) {
      (fn.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', { skip: [...skips] });
    }

    // ── The drill ─────────────────────────────────────────────────────────────
    this.automationRole = new iam.Role(this, 'RestoreDrillAutomationRole', {
      roleName: `${envName}-restore-drill-automation-role`,
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
      description: `Restores and verifies the ${envName} backup restore drills`,
    });
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTheInstances',
        actions: ['rds:DescribeDBInstances'],
        resources: ['*'],
      }),
    );
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RestoreIntoTheCopy',
        // Both ARNs, because the API authorises against the source it reads and
        // the instance it creates, plus the subnet group it places it in. The
        // source appears here and nowhere else in this stack, and it appears
        // only under this one action: `tools/audit-game-days.ts` fails on any
        // other write naming it.
        actions: ['rds:RestoreDBInstanceToPointInTime'],
        resources: [
          `arn:${this.partition}:rds:${this.region}:${this.account}:db:` +
            props.sourceInstanceIdentifier,
          `arn:${this.partition}:rds:${this.region}:${this.account}:db:${drillInstance}`,
          `arn:${this.partition}:rds:${this.region}:${this.account}:subgrp:` +
            drillSubnetGroupName(envName),
        ],
      }),
    );
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TagTheCopy',
        // The restore call carries tags, and RDS authorises tag-on-create
        // separately. Without this the restore fails, which is loud; with it
        // granted on `*` the role could tag anything, which is not.
        actions: ['rds:AddTagsToResource'],
        resources: [
          `arn:${this.partition}:rds:${this.region}:${this.account}:db:${drillInstance}`,
        ],
      }),
    );
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunTheDrillFunctions',
        actions: ['lambda:InvokeFunction'],
        resources: [this.conductor.functionArn, this.verifier.functionArn],
      }),
    );

    this.documents = {};
    const schedulerRole =
      scenarios.length > 0
        ? new iam.Role(this, 'RestoreDrillSchedulerRole', {
            roleName: `${envName}-restore-drill-scheduler-role`,
            assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
            description: `Starts the ${envName} restore drills on their schedule`,
          })
        : undefined;

    for (const scenario of scenarios) {
      const objective = objectiveFor(scenario, objectives);
      if (objective === undefined) {
        // Unreachable: `assertValidGameDayCatalogue` reports
        // `scenario-objective-unknown` above. Restated because a drill built
        // without an objective would have no RTO to wait against and nowhere to
        // record a result.
        throw new Error(
          `BackupRestoreDrillStack ${id}: scenario '${scenario.id}' names objective ` +
            `'${scenario.objectiveId}', which is not in the catalogue.`,
        );
      }
      if (scenario.trigger !== 'schedule' || scenario.scheduleIntervalDays === undefined) {
        // Also unreachable — `scheduled-scenario-without-interval` and the
        // trigger rules cover it — and also restated, because this is the line
        // that decides whether anything ever runs the drill.
        throw new Error(
          `BackupRestoreDrillStack ${id}: scenario '${scenario.id}' has trigger ` +
            `'${scenario.trigger}' and scheduleIntervalDays ` +
            `${String(scenario.scheduleIntervalDays)}. A restore drill is built here because ` +
            'nobody has to approve it; without a cadence there is nothing to build.',
        );
      }

      const restoreTimeoutSeconds =
        props.restoreTimeoutSeconds ?? Math.max(1800, objective.rtoSeconds * 3);
      const documentName = gameDayDocumentName(envName, scenario.id);

      this.documents[scenario.id] = new ssm.CfnDocument(
        this,
        `${pascalCase(scenario.id)}DrillDocument`,
        {
          name: documentName,
          documentType: 'Automation',
          documentFormat: 'JSON',
          updateMethod: 'NewVersion',
          targetType: '/',
          content: restoreDrillDocumentContent({
            scenario,
            objective,
            envName,
            restoreTimeoutSeconds,
            automationRoleArn: this.automationRole.roleArn,
            conductorFunctionName: conductorFunctionName(envName),
            verifierFunctionName: verifierFunctionName(envName),
            sourceInstanceIdentifier: props.sourceInstanceIdentifier,
            drillInstanceIdentifier: drillInstance,
            subnetGroupName: drillSubnetGroupName(envName),
            drillSecurityGroupId: this.drillSecurityGroup.securityGroupId,
          }),
          tags: [
            { key: 'Environment', value: envName },
            { key: 'GameDayScenario', value: scenario.id },
          ],
        },
      );

      // The schedule, which is the whole reason this exercise is in its own
      // stack rather than next to the failover. An `events.CfnRule` rather than
      // the L2: EventBridge's SSM Automation target has no L2 in aws-cdk-lib,
      // and the shape it needs — an `automation-definition/<name>:$DEFAULT` ARN
      // plus a role that may start it — is explicit enough to be worth writing
      // out where a reviewer can see it.
      const scheduleRule = new events.CfnRule(this, `${pascalCase(scenario.id)}Schedule`, {
        name: `${envName}-${scenario.id}-schedule`,
        description:
          `Starts ${documentName} every ${scenario.scheduleIntervalDays} days. No approval: the ` +
          'drill restores into a copy and changes nothing live — see ' +
          'docs/game-days.md#13-the-drill-nobody-has-to-approve.',
        scheduleExpression: `rate(${scenario.scheduleIntervalDays} days)`,
        state: 'ENABLED',
        targets: [
          {
            id: 'RestoreDrillAutomation',
            arn:
              `arn:${this.partition}:ssm:${this.region}:${this.account}:automation-definition/` +
              `${documentName}:$DEFAULT`,
            roleArn: schedulerRole!.roleArn,
          },
        ],
      });
      // The document has to exist before a rule may target it, and the rule
      // refers to it by name rather than by reference, so CloudFormation cannot
      // work that out for itself.
      scheduleRule.addResourceDependency(this.documents[scenario.id]);

      schedulerRole!.addToPolicy(
        new iam.PolicyStatement({
          sid: `Start${pascalCase(scenario.id)}`,
          actions: ['ssm:StartAutomationExecution'],
          resources: [
            `arn:${this.partition}:ssm:${this.region}:${this.account}:automation-definition/` +
              `${documentName}:*`,
          ],
        }),
      );
    }

    if (schedulerRole !== undefined) {
      schedulerRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'PassTheAutomationRole',
          // Starting an automation whose `assumeRole` is the drill's role means
          // handing that role over, which IAM authorises separately. Scoped to
          // the one role, and conditioned on the service that receives it: a
          // bare `iam:PassRole` here would let the schedule hand this role to
          // anything that accepts one.
          actions: ['iam:PassRole'],
          resources: [this.automationRole.roleArn],
          conditions: { StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' } },
        }),
      );
    }

    // ── The signals ───────────────────────────────────────────────────────────
    const objectiveDimensions = (objectiveId: string) => ({
      Environment: envName,
      Objective: objectiveId,
    });

    for (const scenario of scenarios) {
      const unverified = new cloudwatch.Alarm(
        this,
        `RestoreUnverifiedAlarm${pascalCase(scenario.objectiveId)}`,
        {
          alarmName: `${envName}-restore-unverified`,
          alarmDescription:
            `The ${envName} restore drill restored a copy of the database and could not verify ` +
            'it. The backups produced something; what is not established is that it is the ' +
            'data, which is the only question this drill exists to answer. The execution that ' +
            'reported this will have ended green and deleted the copy — the drill\'s job is to ' +
            'produce a finding, not to fail — so the record in ' +
            `\`${rehearsalParameterName(envName, scenario.objectiveId)}\` is where the failing ` +
            'checks are, and the rehearsal clock was deliberately not reset. See ' +
            'docs/game-days.md#14-what-the-drill-verifies. Owner: ' +
            `${objectiveFor(scenario, objectives)?.owner ?? 'platform-team'}.`,
          metric: new cloudwatch.Metric({
            namespace: GAME_DAY_NAMESPACE,
            metricName: METRIC_RESTORE_VERIFIED,
            dimensionsMap: objectiveDimensions(scenario.objectiveId),
            period: cdk.Duration.days(1),
            statistic: 'Minimum',
          }),
          threshold: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          evaluationPeriods: 1,
          // A drill runs monthly, so most days have no datapoint and absence is
          // the normal state of this metric. The question "has a drill run
          // recently" has its own alarm —
          // `<env>-rehearsal-overdue-<objective>`, from the rehearsal freshness
          // signal — and two alarms for one cause is how a responder learns to
          // read one of them.
          treatMissingData: cloudwatch.TreatMissingData.MISSING,
        },
      );
      unverified.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));
    }

    const orphaned = new cloudwatch.Alarm(this, 'DrillInstanceOrphanedAlarm', {
      alarmName: `${envName}-restore-drill-instance-orphaned`,
      alarmDescription:
        `A copy of the ${envName} database restored by a drill has been running for longer than ` +
        `${Math.round(MAX_DRILL_INSTANCE_AGE_SECONDS / 3600)} hours. Nothing is broken and ` +
        'nothing else is red: it serves no traffic, has no alarms of its own, and looks exactly ' +
        'like a database somebody meant to create — which is why it is the one failure here ' +
        'that costs money indefinitely. The usual cause is an execution a human cancelled ' +
        'between the restore and the teardown, which is the one path SSM does not run ' +
        '`onFailure` for. The sweeper deletes it on the next hour unless a drill is still ' +
        `running; this alarm fires either way. Instance: \`${drillInstance}\`. See ` +
        'docs/game-days.md#15-the-copy-that-outlives-the-drill. Owner: platform-team.',
      metric: new cloudwatch.Metric({
        namespace: GAME_DAY_NAMESPACE,
        metricName: METRIC_DRILL_INSTANCE_AGE,
        dimensionsMap: { Environment: envName },
        period: cdk.Duration.seconds(SWEEPER_INTERVAL_SECONDS),
        statistic: 'Maximum',
      }),
      threshold: MAX_DRILL_INSTANCE_AGE_SECONDS,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // The sweeper publishes zero when there is no copy, precisely so that
      // missing data means the sweeper has stopped rather than that there is
      // nothing to report — and a sweeper that has stopped is the state in which
      // an orphaned copy runs forever unnoticed.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    orphaned.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));

    for (const [fn, label] of [
      [this.verifier, 'verifier'],
      [this.conductor, 'conductor'],
      [this.sweeper, 'sweeper'],
    ] as const) {
      const errors = new cloudwatch.Alarm(this, `RestoreDrill${capitalise(label)}ErrorsAlarm`, {
        alarmName: `${envName}-restore-drill-${label}-errors`,
        alarmDescription:
          `The ${envName} restore-drill ${label} is failing. While this is red the restore ` +
          'path\'s RTO is stale rather than wrong, and — for the sweeper — a copy of the ' +
          'database may be running with nothing watching it. Owner: platform-team.',
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errors.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    new cdk.CfnOutput(this, 'RestoreDrillTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'Restore drill results and the alarms in this stack',
      exportName: `${envName}-restore-drill-topic-arn`,
    });
    new cdk.CfnOutput(this, 'RestoreDrillDocuments', {
      value:
        scenarios.map((scenario) => gameDayDocumentName(envName, scenario.id)).join(',') || 'none',
      description: 'Restore drills scheduled in this environment',
    });
    new cdk.CfnOutput(this, 'DrillInstanceIdentifier', {
      value: drillInstance,
      description: 'Identifier the drill restores into, and the only ARN any delete here is scoped to',
    });
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const pascalCase = (value: string): string => value.split('-').map(capitalise).join('');

interface DrillDocumentInput {
  readonly scenario: GameDayScenario;
  readonly objective: RecoveryObjective;
  readonly envName: string;
  readonly restoreTimeoutSeconds: number;
  readonly automationRoleArn: string;
  readonly conductorFunctionName: string;
  readonly verifierFunctionName: string;
  readonly sourceInstanceIdentifier: string;
  readonly drillInstanceIdentifier: string;
  readonly subnetGroupName: string;
  readonly drillSecurityGroupId: string;
}

/**
 * The drill, as CloudFormation will hold it.
 *
 * Read top to bottom it is the procedure: check there is something to restore
 * and nowhere it would collide, restore it, wait for it, verify it, write down
 * how long it took, delete it. Every step's `onFailure` is the same abort step,
 * and that step's first act is to delete the copy — because the failure modes
 * here are not symmetrical with the failover's. A failover that aborts leaves
 * nothing behind; a restore that aborts leaves a full-size instance running.
 *
 * Two things are deliberately *not* in here:
 *
 *   **No `aws:approve`.** It is the one step `FailoverGameDayStack`'s document
 *   cannot do without, and this document must not have it — see the class docs
 *   and `GameDayTrigger`. `tools/audit-game-days.ts` holds both halves: an
 *   approval step in a scheduled drill and a missing one in an approved exercise
 *   are both violations.
 *
 *   **No `aws:sleep`.** The failover document needs one because
 *   `RebootDBInstance` leaves the instance reading `available` for a few seconds
 *   after it returns, so a status wait placed first is satisfied before anything
 *   has happened. A restore has the opposite shape: the instance does not exist
 *   until the API returns and then reports `creating`, so the status wait is
 *   meaningful immediately and a sleep would be pure latency added to a number
 *   this drill is trying to measure.
 */
export const restoreDrillDocumentContent = (
  input: DrillDocumentInput,
): Record<string, unknown> => {
  const { scenario, objective, envName } = input;

  const parameters: Record<string, unknown> = {
    AutomationAssumeRole: {
      type: 'String',
      description:
        'Role the drill assumes. Can restore and read; holds no delete, and no write at all ' +
        'against the source instance.',
      default: input.automationRoleArn,
    },
    SourceDbInstanceIdentifier: {
      type: 'String',
      description: 'Instance whose backups are restored. Read only.',
      default: input.sourceInstanceIdentifier,
    },
    DrillDbInstanceIdentifier: {
      type: 'String',
      description: 'Instance the copy is restored into, and the only one anything here may delete.',
      default: input.drillInstanceIdentifier,
    },
  };

  const abortOnFailure = 'step:recordAbort';

  return {
    schemaVersion: '0.3',
    description:
      `${scenario.title} — ${envName}. ${scenario.summary} Objective: ` +
      `${objective.rtoSeconds}s RTO, ${objective.rpoSeconds}s RPO on ${objective.rpoBasis}. ` +
      `Runs every ${scenario.scheduleIntervalDays} days without approval, because it changes ` +
      'nothing live. Expect ' +
      `${scenario.expectedDurationMinutes} minutes. The execution status is not the result: a ` +
      'drill that finds the copy unverifiable ends green and publishes RestoreVerified=0. See ' +
      'docs/game-days.md.',
    assumeRole: '{{ AutomationAssumeRole }}',
    parameters,
    mainSteps: [
      {
        // `restore-point-available` and `no-drill-instance-present`. Returns
        // the source's restore point, instance class and parameter group, so
        // the restore below reproduces the instance a real recovery would
        // create rather than whatever the API's defaults are.
        name: 'preflight',
        action: 'aws:invokeLambdaFunction',
        onFailure: abortOnFailure,
        timeoutSeconds: 120,
        inputs: {
          FunctionName: input.conductorFunctionName,
          InputPayload: {
            operation: 'preflight',
            scenarioId: scenario.id,
            executionId: '{{ automation:EXECUTION_ID }}',
          },
        },
        outputs: [
          { Name: 'startedAt', Selector: '$.Payload.startedAt', Type: 'String' },
          { Name: 'restorePoint', Selector: '$.Payload.restorePoint', Type: 'String' },
          { Name: 'instanceClass', Selector: '$.Payload.instanceClass', Type: 'String' },
          { Name: 'parameterGroup', Selector: '$.Payload.parameterGroup', Type: 'String' },
          // A joined string rather than a StringList, for the reason the
          // verifier's outputs give: an `aws:invokeLambdaFunction` output typed
          // StringList over an empty array is undocumented, and on a clean
          // drill `checksFailed` is empty every time.
          { Name: 'checksPassed', Selector: '$.Payload.checksPassed', Type: 'String' },
        ],
      },
      {
        name: 'restore',
        action: 'aws:executeAwsApi',
        onFailure: abortOnFailure,
        timeoutSeconds: 300,
        inputs: {
          Service: 'rds',
          Api: 'RestoreDBInstanceToPointInTime',
          SourceDBInstanceIdentifier: '{{ SourceDbInstanceIdentifier }}',
          TargetDBInstanceName: '{{ DrillDbInstanceIdentifier }}',
          // The latest point rather than a `RestoreTime` parameter, and this is
          // the one input worth defending. A fixed or operator-supplied
          // timestamp is a second thing that can be stale or wrong, and when it
          // is, the drill restores a copy from a point nobody asked for and
          // verifies it happily — which is the failure
          // `restore-point-not-stale` exists to catch and which is better not
          // to invite. The latest point is also the one a real recovery starts
          // from before narrowing, and the only one whose freshness the
          // preflight can bound.
          UseLatestRestorableTime: true,
          // Not an API default and not a cost decision: the same class as the
          // source, read by the preflight. A restore onto a smaller class is
          // cheaper and measures a recovery nobody would perform — the volume
          // hydrates at a rate the instance's own throughput caps.
          DBInstanceClass: '{{ preflight.instanceClass }}',
          // The source's group, so the copy comes up with the parameters a
          // recovery would get. Static parameters land `pending-reboot`, which
          // is itself a thing worth seeing in a drill rather than discovering
          // during one — see docs/game-days.md §12.
          DBParameterGroupName: '{{ preflight.parameterGroup }}',
          DBSubnetGroupName: input.subnetGroupName,
          VpcSecurityGroupIds: [input.drillSecurityGroupId],
          // Not inherited from the source. `RestoreDBInstanceToPointInTime`
          // takes this from the request and defaults it from the subnet group,
          // so omitting it is how a drill puts a full copy of production's data
          // on a public endpoint once a month. Asserted again after the fact by
          // the `not-publicly-accessible` check, because what matters is the
          // instance that exists.
          PubliclyAccessible: false,
          // Single-AZ, which is the one way the copy deliberately differs from
          // the source. A standby adds nothing to a copy that is deleted within
          // the hour, and a real recovery would enable Multi-AZ after the
          // cutover rather than waiting for it during the outage.
          MultiAZ: false,
          // Both off so that the teardown cannot be refused. Deletion
          // protection on a drill copy means a delete that fails, an alarm
          // nobody can clear by hand without a console visit, and an instance
          // that outlives the drill.
          DeletionProtection: false,
          CopyTagsToSnapshot: false,
          AutoMinorVersionUpgrade: false,
          EnableIAMDatabaseAuthentication: false,
          Tags: [
            { Key: 'Environment', Value: envName },
            { Key: 'ManagedBy', Value: 'CDK' },
            { Key: 'GameDayScenario', Value: scenario.id },
            // So that a copy found in the console answers for itself. The
            // alarm and the sweeper find it by identifier; a human finds it
            // here.
            { Key: 'Ephemeral', Value: 'true' },
            { Key: 'Purpose', Value: 'backup-restore-drill' },
          ],
        },
      },
      {
        // `restore-not-available-in-time`. No sleep before it: unlike a
        // forced failover, the instance does not exist until the call above
        // returns, so `available` means something from the first poll.
        name: 'waitForAvailable',
        action: 'aws:waitForAwsResourceProperty',
        onFailure: abortOnFailure,
        timeoutSeconds: Math.round(input.restoreTimeoutSeconds),
        inputs: {
          Service: 'rds',
          Api: 'DescribeDBInstances',
          DBInstanceIdentifier: '{{ DrillDbInstanceIdentifier }}',
          PropertySelector: '$.DBInstances[0].DBInstanceStatus',
          DesiredValues: ['available'],
        },
      },
      {
        // The seven checks. Returns a verdict rather than throwing on a
        // failure, because the results have to reach `measure` to be written
        // down — a drill that discovered the copy was empty and recorded
        // nothing but "aborted" would have thrown away its own finding.
        name: 'verify',
        action: 'aws:invokeLambdaFunction',
        onFailure: abortOnFailure,
        timeoutSeconds: 900,
        inputs: {
          FunctionName: input.verifierFunctionName,
          InputPayload: {
            operation: 'verify',
            scenarioId: scenario.id,
            objectiveId: scenario.objectiveId,
            restorePoint: '{{ preflight.restorePoint }}',
            // Passed in rather than read from the verifier's own environment,
            // because it is a property of the objective and the objective is
            // what the document was built for. A verifier that held its own
            // copy would go on checking last release's ceiling after the
            // catalogue moved.
            maxRestorePointStaleSeconds: restorePointStaleAfterSeconds(objective),
            executionId: '{{ automation:EXECUTION_ID }}',
          },
        },
        outputs: [
          { Name: 'verdict', Selector: '$.Payload.verdict', Type: 'String' },
          { Name: 'verifiedAt', Selector: '$.Payload.verifiedAt', Type: 'String' },
          { Name: 'checksPassed', Selector: '$.Payload.checksPassed', Type: 'String' },
          { Name: 'checksFailed', Selector: '$.Payload.checksFailed', Type: 'String' },
        ],
      },
      {
        // `InstanceCreateTime` → the verifier's completion = the measured
        // restore time, written to the rehearsal log and published.
        name: 'measure',
        action: 'aws:invokeLambdaFunction',
        onFailure: abortOnFailure,
        nextStep: 'teardown',
        timeoutSeconds: 120,
        inputs: {
          FunctionName: input.conductorFunctionName,
          InputPayload: {
            operation: 'measure',
            scenarioId: scenario.id,
            startedAt: '{{ preflight.startedAt }}',
            restorePoint: '{{ preflight.restorePoint }}',
            verdict: '{{ verify.verdict }}',
            verifiedAt: '{{ verify.verifiedAt }}',
            checksPassed: '{{ verify.checksPassed }}',
            checksFailed: '{{ verify.checksFailed }}',
            executionId: '{{ automation:EXECUTION_ID }}',
          },
        },
        outputs: [
          { Name: 'outcome', Selector: '$.Payload.outcome', Type: 'String' },
          {
            Name: 'measuredRestoreSeconds',
            Selector: '$.Payload.measuredRestoreSeconds',
            Type: 'String',
          },
          { Name: 'verdict', Selector: '$.Payload.verdict', Type: 'String' },
        ],
      },
      {
        // The step that stops this item costing money. Idempotent, so the
        // abort path can call the same operation without a second delete
        // failing on an instance that is already going away.
        name: 'teardown',
        action: 'aws:invokeLambdaFunction',
        onFailure: abortOnFailure,
        timeoutSeconds: 120,
        isEnd: true,
        inputs: {
          FunctionName: input.conductorFunctionName,
          InputPayload: {
            operation: 'teardown',
            scenarioId: scenario.id,
            executionId: '{{ automation:EXECUTION_ID }}',
          },
        },
      },
      {
        // Every step above fails into here, and the first thing it does is
        // delete the copy. A drill that ended without a record is one nobody
        // can tell from a drill nobody ran; a drill that ended without a
        // teardown is on next month's bill.
        name: 'recordAbort',
        action: 'aws:invokeLambdaFunction',
        timeoutSeconds: 180,
        isEnd: true,
        inputs: {
          FunctionName: input.conductorFunctionName,
          InputPayload: {
            operation: 'abort',
            scenarioId: scenario.id,
            executionId: '{{ automation:EXECUTION_ID }}',
          },
        },
      },
    ],
    outputs: ['measure.outcome', 'measure.measuredRestoreSeconds', 'measure.verdict'],
  };
};

/* ── The verifier ─────────────────────────────────────────────────────────── */

/**
 * The verifier, shipped inline.
 *
 * Exported as a string so `test/restore-drill-verifier-handler.test.ts` can
 * compile and run it: `lambda.Code.fromInline` means nothing else in the build
 * parses it — `tsc` sees a template literal and `cdk synth` embeds it verbatim —
 * and every decision in a verification routine fails in the direction that looks
 * like success. A check that throws and is skipped, a CloudWatch datapoint that
 * has not arrived yet, a certificate nobody looked at: each of those turns into
 * "verified" in the obvious implementation.
 *
 * Two shapes in here are the whole of it.
 *
 * **Every check produces a result, including the ones that could not run.** A
 * verifier that returns three passes and stops because the fourth threw has
 * reported a pass rate, and a pass rate is not a verdict. So a failure to
 * describe the instance marks all seven as failed with the reason on each, and
 * the verdict function treats a missing result exactly as it treats a failing
 * one.
 *
 * **A missing `FreeStorageSpace` datapoint is not a pass.** It is the only check
 * that can see a restore which completed and brought back an empty volume, and
 * RDS publishes the metric a minute or two after the instance reports
 * `available` — so the obvious code reads once, finds nothing, and skips the
 * check on exactly the drills that run fastest. This polls for five minutes and
 * fails the check if it still has nothing.
 */
export const RESTORE_VERIFIER_SOURCE = `
'use strict';
const net = require('node:net');
const tls = require('node:tls');
const {
  CloudWatchClient,
  GetMetricDataCommand,
  PutMetricDataCommand,
} = require('@aws-sdk/client-cloudwatch');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const rds = new RDSClient({ region: process.env.AWS_REGION });

const ENV_NAME = process.env.ENV_NAME;
const NAMESPACE = process.env.NAMESPACE;
const SOURCE_INSTANCE = process.env.SOURCE_INSTANCE;
const DRILL_INSTANCE = process.env.DRILL_INSTANCE;
const DRILL_PORT = Number(process.env.DRILL_PORT);
const CHECKS = JSON.parse(process.env.CHECKS);
const BYTES_TOLERANCE = Number(process.env.BYTES_TOLERANCE);
const BYTES_FLOOR = Number(process.env.BYTES_FLOOR);
const STORAGE_LOOKBACK_MINUTES = Number(process.env.STORAGE_LOOKBACK_MINUTES);
const STORAGE_POLL_ATTEMPTS = Number(process.env.STORAGE_POLL_ATTEMPTS);
const STORAGE_POLL_INTERVAL_MS = Number(process.env.STORAGE_POLL_INTERVAL_MS);
const TLS_CHAIN_NOTE = process.env.TLS_CHAIN_NOTE;
const TLS_TIMEOUT_MS = Number(process.env.TLS_TIMEOUT_MS);

const GIB = 1024 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const describe = async (identifier) => {
  const result = await rds.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
  );
  const instance = (result.DBInstances || [])[0];
  if (!instance) {
    throw new Error(
      'DescribeDBInstances returned no instance for ' + identifier + '. A filter that matches ' +
        'nothing is not an error to this API, so this is the shape "the instance is gone" takes.',
    );
  }
  return instance;
};

/**
 * Latest \`FreeStorageSpace\` datapoint for an instance, in bytes.
 *
 * Minimum rather than Average over the period: the question is how much data is
 * on the volume, so the lowest free-space reading in the window is the one that
 * answers it. Undefined means no datapoint, which the caller must not read as
 * zero — zero free space and no reading are opposite findings.
 */
const freeStorageBytes = async (identifier, now) => {
  const result = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: new Date(now.getTime() - STORAGE_LOOKBACK_MINUTES * 60000),
      EndTime: now,
      ScanBy: 'TimestampDescending',
      MetricDataQueries: [
        {
          Id: 'free',
          MetricStat: {
            Metric: {
              Namespace: 'AWS/RDS',
              MetricName: 'FreeStorageSpace',
              Dimensions: [{ Name: 'DBInstanceIdentifier', Value: identifier }],
            },
            Period: 60,
            Stat: 'Minimum',
          },
        },
      ],
    }),
  );
  const series = (result.MetricDataResults || []).find((candidate) => candidate.Id === 'free');
  const values = (series && series.Values) || [];
  return values.length > 0 ? values[0] : undefined;
};

/** Both instances' used bytes, polled until RDS has published the copy's. */
const readStorage = async (now) => {
  for (let attempt = 0; attempt < STORAGE_POLL_ATTEMPTS; attempt += 1) {
    const at = attempt === 0 ? now : new Date();
    const [sourceFree, drillFree] = await Promise.all([
      freeStorageBytes(SOURCE_INSTANCE, at),
      freeStorageBytes(DRILL_INSTANCE, at),
    ]);
    if (sourceFree !== undefined && drillFree !== undefined) {
      return { sourceFree, drillFree, attempts: attempt + 1 };
    }
    if (attempt < STORAGE_POLL_ATTEMPTS - 1) await sleep(STORAGE_POLL_INTERVAL_MS);
  }
  return undefined;
};

/**
 * Does a certificate name cover this host?
 *
 * A leading wildcard matches exactly one label, which is the rule in RFC 6125
 * and the one RDS's regional certificates rely on. Written out rather than left
 * to \`tls\`' own identity check because that check only runs when the chain is
 * being validated, which here it deliberately is not — see TLS_CHAIN_NOTE.
 */
const nameMatches = (name, host) => {
  const candidate = String(name || '').trim().toLowerCase();
  const target = String(host || '').trim().toLowerCase();
  if (!candidate || !target) return false;
  if (candidate === target) return true;
  if (!candidate.startsWith('*.')) return false;
  const suffix = candidate.slice(1);
  if (!target.endsWith(suffix)) return false;
  // One label, so the wildcard cannot stand in for a subdomain of its own.
  return target.slice(0, target.length - suffix.length).indexOf('.') === -1;
};

const certificateNames = (certificate) => {
  const names = [];
  if (certificate.subject && certificate.subject.CN) names.push(certificate.subject.CN);
  for (const entry of String(certificate.subjectaltname || '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.toLowerCase().startsWith('dns:')) names.push(trimmed.slice(4));
  }
  return names;
};

/**
 * PostgreSQL's SSL negotiation, then a TLS handshake, then the certificate.
 *
 * Eight bytes out — an int32 length of 8 and the int32 code 80877103 — and one
 * byte back. Every PostgreSQL backend answers that before any session exists, so
 * it separates "a port is open" from "a database is serving" in a way a TCP
 * connect cannot: a listener with nothing behind it accepts the socket and never
 * replies, and an instance still replaying WAL does not get this far either.
 *
 * Two timers, as in the failover probe: \`setTimeout\` bounds the whole attempt
 * because a DNS lookup that hangs happens before the socket exists, and a
 * verifier that can hang is a drill that times out holding a copy of production.
 */
const negotiate = (host, port) =>
  new Promise((resolve) => {
    let settled = false;
    let socket;
    let secure;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (secure) secure.destroy();
      if (socket) socket.destroy();
      resolve(value);
    };
    const deadline = setTimeout(
      () => finish({ ok: false, error: 'deadline of ' + TLS_TIMEOUT_MS + 'ms' }),
      TLS_TIMEOUT_MS,
    );
    try {
      socket = net.createConnection({ host: host, port: port });
      socket.setTimeout(TLS_TIMEOUT_MS);
      socket.once('timeout', () => finish({ ok: false, error: 'socket timeout' }));
      socket.once('error', (error) => finish({ ok: false, error: error.message }));
      socket.once('connect', () => {
        const request = Buffer.alloc(8);
        request.writeInt32BE(8, 0);
        request.writeInt32BE(80877103, 4);
        socket.once('data', (chunk) => {
          if (chunk.length !== 1) {
            finish({
              ok: false,
              error:
                'the backend answered ' + chunk.length + ' bytes to SSLRequest, not 1. Whatever ' +
                'is on this port is not speaking the PostgreSQL protocol.',
            });
            return;
          }
          const answer = String.fromCharCode(chunk[0]);
          if (answer !== 'S') {
            finish({
              ok: false,
              error:
                'the backend answered ' + JSON.stringify(answer) + ' to SSLRequest. "N" means ' +
                'TLS is off on the restored copy, which is a finding about the parameter group ' +
                'the restore came up with.',
            });
            return;
          }
          // rejectUnauthorized: false is deliberate and is the subject of
          // TLS_CHAIN_NOTE. The identity check is the certificate-name check
          // below; nothing is sent on this socket past the handshake and
          // nothing is read from it but the certificate.
          // No \`servername\` for an IP literal: RFC 6066 forbids SNI for one, and
          // Node answers that with DEP0123 rather than with an error. An RDS
          // endpoint is always a name, so this only ever matters to a caller
          // that was handed an address — and a deprecation warning out of the
          // thing that verifies the backups is noise in the one log somebody
          // reads after a failed drill.
          secure = tls.connect({
            socket: socket,
            rejectUnauthorized: false,
            ...(net.isIP(host) ? {} : { servername: host }),
          });
          secure.setTimeout(TLS_TIMEOUT_MS);
          secure.once('timeout', () => finish({ ok: false, error: 'TLS handshake timeout' }));
          secure.once('error', (error) => finish({ ok: false, error: error.message }));
          secure.once('secureConnect', () => {
            const certificate = secure.getPeerCertificate() || {};
            finish({
              ok: true,
              protocol: secure.getProtocol(),
              names: certificateNames(certificate),
              validTo: certificate.valid_to,
            });
          });
        });
        socket.write(request);
      });
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  });

/* ── The verdict. Pinned to restoreVerdict() by the tests. ────────────────── */

const verdictFor = (results, required) => {
  if (results.some((result) => !result.passed)) return 'failed';
  const seen = new Set(results.map((result) => result.check));
  return required.every((check) => seen.has(check)) ? 'verified' : 'failed';
};

/* ── The checks ───────────────────────────────────────────────────────────── */

const bytesMatch = (source, restored) => {
  const sourceUsed = source.allocatedStorageGiB * GIB - source.freeStorageBytes;
  const restoredUsed = restored.allocatedStorageGiB * GIB - restored.freeStorageBytes;
  const ratio = sourceUsed === 0 ? 0 : restoredUsed / sourceUsed;
  if (sourceUsed < BYTES_FLOOR) {
    return { matches: false, reason: 'source-too-small', sourceUsed, restoredUsed, ratio };
  }
  if (ratio < 1 - BYTES_TOLERANCE) {
    return { matches: false, reason: 'restored-too-small', sourceUsed, restoredUsed, ratio };
  }
  if (ratio > 1 + BYTES_TOLERANCE) {
    return { matches: false, reason: 'restored-too-large', sourceUsed, restoredUsed, ratio };
  }
  return { matches: true, sourceUsed, restoredUsed, ratio };
};

const gib = (bytes) => (bytes / GIB).toFixed(2) + ' GiB';

const runChecks = async (event, now) => {
  const results = [];
  const record = (check, passed, detail) => {
    results.push({ check: check, passed: passed, detail: detail });
  };

  let drill;
  let source;
  try {
    drill = await describe(DRILL_INSTANCE);
    source = await describe(SOURCE_INSTANCE);
  } catch (error) {
    // Nothing below can be decided, so every check is reported as not run
    // rather than left out: a verdict assembled from four results out of seven
    // is a pass rate, and the record has to say which questions were not asked.
    for (const check of CHECKS) {
      record(check, false, 'not run: ' + error.message);
    }
    return results;
  }

  record(
    'instance-available',
    drill.DBInstanceStatus === 'available',
    'DBInstanceStatus is ' + drill.DBInstanceStatus,
  );
  record(
    'not-publicly-accessible',
    drill.PubliclyAccessible === false,
    'PubliclyAccessible is ' + String(drill.PubliclyAccessible) +
      (drill.PubliclyAccessible ? ' — a copy of ' + SOURCE_INSTANCE + ' is on a public endpoint' : ''),
  );
  record(
    'storage-encrypted',
    drill.StorageEncrypted === true,
    'StorageEncrypted is ' + String(drill.StorageEncrypted),
  );

  const host = (drill.Endpoint && drill.Endpoint.Address) || undefined;
  if (host === undefined) {
    const detail = 'not run: the restored instance has no endpoint address yet';
    record('engine-negotiates-tls', false, detail);
    record('certificate-names-the-instance', false, detail);
  } else {
    const negotiation = await negotiate(host, DRILL_PORT);
    record(
      'engine-negotiates-tls',
      negotiation.ok === true,
      negotiation.ok
        ? 'the backend answered SSLRequest and completed a ' + negotiation.protocol +
            ' handshake (' + TLS_CHAIN_NOTE + ')'
        : 'could not negotiate TLS with ' + host + ':' + DRILL_PORT + ' — ' + negotiation.error,
    );
    if (negotiation.ok !== true) {
      record(
        'certificate-names-the-instance',
        false,
        'not run: no handshake completed, so no certificate was presented',
      );
    } else {
      const names = negotiation.names || [];
      const matched = names.some((name) => nameMatches(name, host));
      record(
        'certificate-names-the-instance',
        matched,
        matched
          ? 'the certificate names ' + host + ' (presented: ' + names.join(', ') + ')'
          : 'the certificate presented ' + (names.length ? names.join(', ') : '(no names)') +
              ', none of which covers ' + host,
      );
    }
  }

  const storage = await readStorage(now);
  if (storage === undefined) {
    record(
      'restored-bytes-match-source',
      false,
      'not run: no AWS/RDS FreeStorageSpace datapoint for one of the instances within ' +
        STORAGE_LOOKBACK_MINUTES + ' minutes, after ' + STORAGE_POLL_ATTEMPTS + ' attempts. This ' +
        'is the only check that can see a restore which came back empty, so a missing datapoint ' +
        'is reported as a failure rather than skipped.',
    );
  } else {
    const comparison = bytesMatch(
      {
        allocatedStorageGiB: Number(source.AllocatedStorage),
        freeStorageBytes: storage.sourceFree,
      },
      {
        allocatedStorageGiB: Number(drill.AllocatedStorage),
        freeStorageBytes: storage.drillFree,
      },
    );
    record(
      'restored-bytes-match-source',
      comparison.matches === true,
      'the copy holds ' + gib(comparison.restoredUsed) + ' against the source\\'s ' +
        gib(comparison.sourceUsed) + ' (' + comparison.ratio.toFixed(3) + 'x' +
        (comparison.matches ? '' : ', ' + comparison.reason) + ')',
    );
  }

  const restorePointAtPreflight = new Date(event.restorePoint);
  const createdAt = drill.InstanceCreateTime ? new Date(drill.InstanceCreateTime) : undefined;
  const maxStale = Number(event.maxRestorePointStaleSeconds);
  if (
    Number.isNaN(restorePointAtPreflight.getTime()) ||
    createdAt === undefined ||
    !Number.isFinite(maxStale)
  ) {
    record(
      'restore-point-not-stale',
      false,
      'not run: restorePoint ' + JSON.stringify(event.restorePoint) + ', InstanceCreateTime ' +
        String(drill.InstanceCreateTime) + ', maxRestorePointStaleSeconds ' +
        String(event.maxRestorePointStaleSeconds),
    );
  } else {
    const span = Math.round((createdAt.getTime() - restorePointAtPreflight.getTime()) / 1000);
    record(
      'restore-point-not-stale',
      span >= 0 && span <= maxStale,
      'the copy was created ' + span + 's after the restore point the preflight read, against a ' +
        'ceiling of ' + maxStale + 's',
    );
  }

  return results;
};

exports.handler = async (event) => {
  if (event.operation !== 'verify') {
    throw new Error('Unknown operation ' + event.operation + '.');
  }
  const now = new Date();
  const results = await runChecks(event, now);
  const verdict = verdictFor(results, CHECKS);
  const verifiedAt = new Date();

  const passed = results.filter((result) => result.passed);
  const failed = results.filter((result) => !result.passed);

  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: 'RestoreVerified',
          Value: verdict === 'verified' ? 1 : 0,
          Unit: 'None',
          Timestamp: verifiedAt,
          Dimensions: [
            { Name: 'Environment', Value: ENV_NAME },
            { Name: 'Objective', Value: event.objectiveId },
          ],
        },
      ],
    }),
  );

  const summary = {
    event: 'restore-drill-verification',
    verdict: verdict,
    instance: DRILL_INSTANCE,
    executionId: event.executionId,
    results: results,
  };
  if (verdict === 'verified') {
    console.log(JSON.stringify(summary));
  } else {
    console.warn(JSON.stringify(summary));
  }

  return {
    operation: 'verify',
    verdict: verdict,
    verifiedAt: verifiedAt.toISOString(),
    // Joined strings rather than StringList outputs. An SSM
    // \`aws:invokeLambdaFunction\` output typed StringList over an empty array is
    // a case the schema does not document, and on a verified drill
    // \`checksFailed\` is empty every single time — so the one code path that
    // always runs would be the one relying on undocumented behaviour.
    checksPassed: passed.map((result) => result.check).join(' | ') || 'none',
    checksFailed:
      failed.map((result) => result.check + ': ' + result.detail).join(' | ') || 'none',
  };
};
`;

/* ── The conductor ────────────────────────────────────────────────────────── */

/**
 * The conductor, shipped inline: preflight, measurement, teardown, abort.
 *
 * The restore arithmetic in here is the same arithmetic as `measureRestore` in
 * `lib/game-days.ts`, written twice because `lambda.Code.fromInline` cannot
 * import. That is a real risk and it is handled the way this repository handles
 * the others like it: `test/restore-drill-conductor-handler.test.ts` runs a
 * table of hand-built timestamps through both implementations and asserts they
 * agree, so a change to either is a failing assertion rather than a number
 * nobody can reproduce.
 *
 * `teardown` is idempotent and `abort` calls it first. Between them they are the
 * only reason this item does not cost money: every step in the document routes
 * its failure to `abort`, and `abort`'s first act is to delete the copy — before
 * it writes the record, before it reads the execution to find out what went
 * wrong, and before it notifies anybody. A failure to explain the abort is a
 * worse record; a failure to delete the copy is a bill.
 */
export const RESTORE_DRILL_CONDUCTOR_SOURCE = `
'use strict';
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const {
  RDSClient,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
} = require('@aws-sdk/client-rds');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const {
  SSMClient,
  GetAutomationExecutionCommand,
  GetParameterCommand,
  PutParameterCommand,
} = require('@aws-sdk/client-ssm');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const rds = new RDSClient({ region: process.env.AWS_REGION });
const sns = new SNSClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

const ENV_NAME = process.env.ENV_NAME;
const NAMESPACE = process.env.NAMESPACE;
const TOPIC_ARN = process.env.TOPIC_ARN;
const SOURCE_INSTANCE = process.env.SOURCE_INSTANCE;
const DRILL_INSTANCE = process.env.DRILL_INSTANCE;
const RESOLUTION_SECONDS = Number(process.env.RESOLUTION_SECONDS);
const CHECK_COUNT = Number(process.env.CHECK_COUNT);
const SCENARIOS = JSON.parse(process.env.SCENARIOS);

/** SNS rejects a subject over 100 characters, and rejects newlines in one. */
const SUBJECT_LIMIT = 100;

const subject = (text) => text.replace(/\\s+/g, ' ').slice(0, SUBJECT_LIMIT);

const scenarioById = (id) => {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(
      'Unknown scenario ' + id + ' in ' + ENV_NAME + '. The document was built for a scenario ' +
        'this function does not know about, which means the two were deployed from different ' +
        'revisions.',
    );
  }
  return scenario;
};

const NOT_FOUND = ['DBInstanceNotFound', 'DBInstanceNotFoundFault'];

/** The instance, or undefined when it is not there. Not an error either way. */
const describeOrUndefined = async (identifier) => {
  try {
    const result = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }),
    );
    return (result.DBInstances || [])[0];
  } catch (error) {
    if (NOT_FOUND.includes(error.name)) return undefined;
    throw error;
  }
};

/* ── The restore arithmetic. Pinned to measureRestore() by the tests. ─────── */

const measureRestore = (requestedAt, verifiedAt) => {
  const restoreSeconds = Math.round((verifiedAt.getTime() - requestedAt.getTime()) / 1000);
  if (restoreSeconds < 0) {
    throw new Error(
      'measureRestore: the copy was verified at ' + verifiedAt.toISOString() + ', before it was ' +
        'created at ' + requestedAt.toISOString() + '. The two timestamps are not about the ' +
        'same restore — most likely a drill instance left over from an earlier run was ' +
        'described instead of this one.',
    );
  }
  return { restoreSeconds: restoreSeconds, resolutionSeconds: RESOLUTION_SECONDS };
};

const verdictAgainstObjective = (rtoObjectiveSeconds, measurement) => {
  if (measurement.restoreSeconds <= rtoObjectiveSeconds) return 'met';
  if (measurement.restoreSeconds - rtoObjectiveSeconds <= measurement.resolutionSeconds) {
    return 'within-measurement-error';
  }
  return 'missed';
};

/* ── The record ───────────────────────────────────────────────────────────── */

const readLog = async (name) => {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    const raw = result.Parameter && result.Parameter.Value;
    return typeof raw === 'string' ? JSON.parse(raw) : undefined;
  } catch (error) {
    if (error.name === 'ParameterNotFound') return undefined;
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

const writeRecord = async (scenario, record) => {
  const previous = await readLog(scenario.parameter);
  const log = {
    objectiveId: record.objectiveId,
    lastAttempt: record,
    // Only a measured drill moves lastMeasured, which is what the rehearsal
    // clock is computed from. This is where \`verification-failed\` is actually
    // implemented: a copy that came back unusable leaves the objective exactly
    // as overdue as it was, so the overdue alarm goes on reporting that nobody
    // has a verified restore — which is true.
    lastMeasured:
      record.outcome === 'measured'
        ? record
        : previous && previous.lastMeasured
          ? previous.lastMeasured
          : undefined,
  };
  await ssm.send(
    new PutParameterCommand({
      Name: scenario.parameter,
      Value: JSON.stringify(log),
      Type: 'String',
      Overwrite: true,
      Description: 'Last recovery-exercise attempt and last measurement for this objective',
    }),
  );
  return log;
};

/* ── Teardown ─────────────────────────────────────────────────────────────── */

/**
 * Delete the copy. Idempotent, and the one call in here that must not throw for
 * a reason that is really "it is already gone".
 *
 * \`DeleteAutomatedBackups: true\` is not tidiness. Without it RDS keeps the
 * deleted copy's automated backups for the source's retention period, so every
 * drill leaves a month of a full copy of production's data in a place nobody is
 * looking at and nothing is alarming on — a growing, invisible, perfectly
 * encrypted liability.
 */
const deleteDrillInstance = async () => {
  const instance = await describeOrUndefined(DRILL_INSTANCE);
  if (instance === undefined) return { deleted: false, reason: 'not-present' };
  if (instance.DBInstanceStatus === 'deleting') {
    return { deleted: false, reason: 'already-deleting' };
  }
  try {
    await rds.send(
      new DeleteDBInstanceCommand({
        DBInstanceIdentifier: DRILL_INSTANCE,
        SkipFinalSnapshot: true,
        DeleteAutomatedBackups: true,
      }),
    );
    return { deleted: true, reason: 'requested' };
  } catch (error) {
    if (NOT_FOUND.includes(error.name)) return { deleted: false, reason: 'not-present' };
    throw error;
  }
};

/* ── Preflight ────────────────────────────────────────────────────────────── */

const preflightRestorePointAvailable = async (scenario, now) => {
  const source = await describeOrUndefined(SOURCE_INSTANCE);
  if (source === undefined) {
    throw new Error(
      'restore-point-available: ' + SOURCE_INSTANCE + ' does not exist, so there is nothing to ' +
        'restore from. The check cannot be made, and a preflight that cannot be made is not one ' +
        'that passed.',
    );
  }
  if (!source.LatestRestorableTime) {
    throw new Error(
      'restore-point-available: ' + SOURCE_INSTANCE + ' reports no LatestRestorableTime, which ' +
        'is what an instance with no automated backups looks like. There is no restore path at ' +
        'all — which is the most important thing this drill can find out, and the reason it is ' +
        'found out here rather than as an InvalidDBInstanceState forty seconds into a restore.',
    );
  }
  const restorePoint = new Date(source.LatestRestorableTime);
  const lagSeconds = Math.round((now.getTime() - restorePoint.getTime()) / 1000);
  const ceiling = Number(scenario.maxRestorePointStaleSeconds);
  if (Number.isFinite(ceiling) && lagSeconds > ceiling) {
    throw new Error(
      'restore-point-available: the latest restorable point is ' + lagSeconds + 's old, past the ' +
        ceiling + 's this objective can vouch for. Backups are being taken and have stopped ' +
        'keeping up, so restoring now would produce a copy from a point nobody asked for — ' +
        'which ' + ENV_NAME + '-restore-point-stale is already reporting.',
    );
  }
  return {
    restorePoint: restorePoint.toISOString(),
    lagSeconds: lagSeconds,
    instanceClass: source.DBInstanceClass,
    parameterGroup:
      ((source.DBParameterGroups || [])[0] || {}).DBParameterGroupName || undefined,
    allocatedStorage: source.AllocatedStorage,
  };
};

const preflightNoDrillInstancePresent = async () => {
  const existing = await describeOrUndefined(DRILL_INSTANCE);
  if (existing === undefined) return;
  throw new Error(
    'no-drill-instance-present: ' + DRILL_INSTANCE + ' already exists, status ' +
      existing.DBInstanceStatus + ', created ' + String(existing.InstanceCreateTime) + '. A ' +
      'restore onto an identifier that exists fails, which would be harmless; what is not is ' +
      'the teardown, which is scoped to this identifier and would delete that copy in the ' +
      'middle of its own verification. ' + ENV_NAME + '-restore-drill-instance-orphaned reports ' +
      'a copy nothing is using, and the sweeper removes one.',
  );
};

/* ── Operations ───────────────────────────────────────────────────────────── */

const preflight = async (scenario, now) => {
  // The restore-point read comes first because it is the only one that can
  // report that there is no restore path at all, and that finding should not be
  // hidden behind a leftover instance from last month.
  const point = await preflightRestorePointAvailable(scenario, now);
  await preflightNoDrillInstancePresent();

  if (!point.instanceClass) {
    throw new Error(
      'restore-point-available: ' + SOURCE_INSTANCE + ' reports no DBInstanceClass, so the ' +
        'restore has no class to reproduce. Restoring onto a default would measure a recovery ' +
        'nobody would perform.',
    );
  }
  if (!point.parameterGroup) {
    throw new Error(
      'restore-point-available: ' + SOURCE_INSTANCE + ' reports no parameter group, so the copy ' +
        'would come up on the engine defaults rather than on the parameters a recovery gets.',
    );
  }

  return {
    operation: 'preflight',
    scenarioId: scenario.id,
    // Taken after the checks, so a slow preflight does not widen the span the
    // measurement is read over.
    startedAt: new Date().toISOString(),
    restorePoint: point.restorePoint,
    restorePointLagSeconds: point.lagSeconds,
    instanceClass: point.instanceClass,
    parameterGroup: point.parameterGroup,
    checksPassed: ['restore-point-available', 'no-drill-instance-present'].join(' | '),
  };
};

const measure = async (scenario, event, now) => {
  const drill = await describeOrUndefined(DRILL_INSTANCE);
  if (drill === undefined || !drill.InstanceCreateTime) {
    throw new Error(
      'measure: ' + DRILL_INSTANCE + ' has no InstanceCreateTime' +
        (drill === undefined ? ' because it does not exist' : '') + '. That timestamp is what ' +
        'the restore is measured from — a number the automation timed itself would be as good ' +
        'as its own scheduling.',
    );
  }
  const verifiedAt = new Date(event.verifiedAt);
  if (Number.isNaN(verifiedAt.getTime())) {
    throw new Error('measure: verifiedAt ' + event.verifiedAt + ' is not a timestamp.');
  }

  const measurement = measureRestore(new Date(drill.InstanceCreateTime), verifiedAt);
  const verified = event.verdict === 'verified';
  const objectiveVerdict = verdictAgainstObjective(scenario.rtoSeconds, measurement);

  const record = {
    objectiveId: scenario.objectiveId,
    scenarioId: scenario.id,
    startedAt: typeof event.startedAt === 'string' ? event.startedAt : now.toISOString(),
    completedAt: now.toISOString(),
    // Not 'aborted'. The drill ran end to end and produced a finding; what it
    // could not produce is a measurement anybody should believe, because the
    // thing it measured the restore of is a copy that failed verification.
    outcome: verified ? 'measured' : 'inconclusive',
    measuredRtoSeconds: measurement.restoreSeconds,
    resolutionSeconds: measurement.resolutionSeconds,
    restorePoint: typeof event.restorePoint === 'string' ? event.restorePoint : undefined,
    checksPassed: String(event.checksPassed || '').split(' | ').filter((entry) => entry !== 'none'),
    checksFailed: String(event.checksFailed || '').split(' | ').filter((entry) => entry !== 'none'),
    executionId: event.executionId,
  };

  await writeRecord(scenario, record);

  // Published only for a verified copy. A restore time for a copy that came
  // back wrong is a number about how long it took to produce something
  // unusable, and on a graph next to the objective it is indistinguishable
  // from a good result.
  if (verified) {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [
          {
            MetricName: 'MeasuredRestoreSeconds',
            Value: measurement.restoreSeconds,
            Unit: 'Seconds',
            Timestamp: now,
            Dimensions: [
              { Name: 'Environment', Value: ENV_NAME },
              { Name: 'Objective', Value: scenario.objectiveId },
            ],
          },
        ],
      }),
    );
  }

  const headline = verified
    ? 'restore verified in ' + measurement.restoreSeconds + 's, ' + objectiveVerdict
    : 'restore NOT verified';

  const message =
    ENV_NAME + ' ' + scenario.title + '\\n\\n' +
    'Verification: ' + event.verdict + ' (' + CHECK_COUNT + ' checks)\\n' +
    'Measured restore: ' + measurement.restoreSeconds + 's (+/-' +
    measurement.resolutionSeconds + 's)\\n' +
    'Objective: ' + scenario.rtoSeconds + 's — ' + objectiveVerdict + '\\n' +
    'Restored to: ' + String(record.restorePoint) + '\\n' +
    'Passed: ' + String(event.checksPassed) + '\\n' +
    'Failed: ' + String(event.checksFailed) + '\\n' +
    'Execution: ' + event.executionId + '\\n\\n' +
    (verified
      ? 'The copy is being deleted. The rehearsal clock has been reset.'
      : 'The copy is being deleted and the rehearsal clock has NOT been reset, so ' + ENV_NAME +
        '-rehearsal-overdue-' + scenario.objectiveId + ' stays as it was: there is still no ' +
        'verified restore for this objective. The backups produced something; what is not ' +
        'established is that it is the data.');

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject(ENV_NAME + ' restore drill: ' + headline),
      Message: message,
    }),
  );

  const summary = {
    operation: 'measure',
    outcome: record.outcome,
    verdict: event.verdict,
    objectiveVerdict: objectiveVerdict,
    ...record,
  };
  console.log(JSON.stringify(summary));
  return { ...summary, measuredRestoreSeconds: String(measurement.restoreSeconds) };
};

const teardown = async (scenario, event) => {
  const outcome = await deleteDrillInstance();
  const summary = {
    operation: 'teardown',
    scenarioId: scenario.id,
    instance: DRILL_INSTANCE,
    deleted: outcome.deleted,
    reason: outcome.reason,
    executionId: event.executionId,
  };
  console.log(JSON.stringify(summary));
  return summary;
};

/**
 * Which step failed, and what it said.
 *
 * The execution is still running when this is called — recordAbort is a step
 * inside it — so the failed step is already in the history. Best effort: a
 * record that says "aborted, reason unavailable" is worth more than an abort
 * step that threw while trying to explain itself, which would leave no record
 * and, here, no teardown either.
 */
const failureNote = async (executionId) => {
  try {
    const result = await ssm.send(
      new GetAutomationExecutionCommand({ AutomationExecutionId: executionId }),
    );
    const steps = (result.AutomationExecution && result.AutomationExecution.StepExecutions) || [];
    const failed = steps.filter(
      (step) => step.StepStatus === 'Failed' || step.StepStatus === 'TimedOut',
    );
    if (failed.length === 0) return undefined;
    return failed
      .map((step) => step.StepName + ' ' + step.StepStatus + ': ' + (step.FailureMessage || 'no message'))
      .join(' | ');
  } catch (error) {
    console.warn(JSON.stringify({ event: 'failure-note-unavailable', error: error.message }));
    return undefined;
  }
};

const abort = async (scenario, event, now) => {
  // First, before the record and before the explanation. Everything else in
  // this function is information; this is the part that stops a full-size copy
  // of production running until somebody notices it on a bill.
  let teardownOutcome;
  let teardownError;
  try {
    teardownOutcome = await deleteDrillInstance();
  } catch (error) {
    teardownError = error.message;
  }

  const note =
    (typeof event.note === 'string' && event.note.trim() ? event.note : undefined) ??
    (await failureNote(event.executionId)) ??
    'no reason recorded';

  const record = {
    objectiveId: scenario.objectiveId,
    scenarioId: scenario.id,
    startedAt: typeof event.startedAt === 'string' ? event.startedAt : now.toISOString(),
    completedAt: now.toISOString(),
    outcome: 'aborted',
    note: note,
    executionId: event.executionId,
  };
  await writeRecord(scenario, record);

  const teardownLine =
    teardownError !== undefined
      ? 'THE COPY COULD NOT BE DELETED: ' + teardownError + '. ' + DRILL_INSTANCE +
        ' is a full-size copy of ' + SOURCE_INSTANCE + ' and is still running. ' + ENV_NAME +
        '-restore-drill-instance-orphaned will report it within the hour and the sweeper will ' +
        'remove it; if neither happens, delete it by hand.'
      : teardownOutcome.deleted
        ? 'The copy has been deleted.'
        : 'No copy to delete (' + teardownOutcome.reason + ').';

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject(ENV_NAME + ' restore drill aborted: ' + scenario.id),
      Message:
        ENV_NAME + ' ' + scenario.title + ' did not complete.\\n\\n' +
        'Reason: ' + note + '\\n' +
        'Execution: ' + event.executionId + '\\n' +
        teardownLine + '\\n\\n' +
        'The rehearsal clock has not been reset — lastMeasured is untouched, so the objective ' +
        'stays as overdue as it was. A preflight refusing is the expected outcome when the ' +
        'backups have stopped keeping up or a copy from an earlier drill is still around, and ' +
        'both of those are findings.',
    }),
  );

  const summary = { operation: 'abort', outcome: 'aborted', teardown: teardownLine, ...record };
  console.warn(JSON.stringify(summary));
  if (teardownError !== undefined) {
    // Rethrown after the record and the notification, deliberately. The abort
    // step is the last one in the document, so failing it costs nothing that
    // has not already been lost — and it is what puts the error on the
    // conductor's own error metric, which is alarmed.
    throw new Error('abort: the copy could not be deleted: ' + teardownError);
  }
  return summary;
};

exports.handler = async (event) => {
  const now = new Date();
  const scenario = scenarioById(event.scenarioId);
  switch (event.operation) {
    case 'preflight':
      return preflight(scenario, now);
    case 'measure':
      return measure(scenario, event, now);
    case 'teardown':
      return teardown(scenario, event);
    case 'abort':
      return abort(scenario, event, now);
    default:
      throw new Error('Unknown operation ' + event.operation + '.');
  }
};
`;

/* ── The sweeper ──────────────────────────────────────────────────────────── */

/**
 * The sweeper, shipped inline.
 *
 * It exists for one path, and the path is a human: SSM does not run a step's
 * `onFailure` when an execution is *cancelled*, so an operator stopping a drill
 * between the restore and the teardown leaves a full-size copy of production
 * running with nothing to clean it up. That copy is the quietest failure in this
 * whole item — it serves no traffic, it breaches no threshold, it has no alarms
 * of its own, and it looks exactly like a database somebody meant to create.
 *
 * Two decisions:
 *
 * **It publishes zero when there is no copy.** The obvious implementation
 * publishes nothing, which makes "no copy" and "the sweeper has stopped"
 * identical on the graph — and the second is the state in which an orphan runs
 * forever. Publishing zero lets the alarm breach on missing data, so the
 * sweeper's own silence is the thing that pages.
 *
 * **It will not delete while a drill is running.** `DescribeAutomationExecutions`
 * for an `InProgress` execution of the drill document is the check, and without
 * it the one thing worse than an orphan becomes possible: a copy deleted out
 * from under a verification that was still running, reported as a restore that
 * could not be verified, sending somebody to look at the backups.
 */
export const RESTORE_DRILL_SWEEPER_SOURCE = `
'use strict';
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const {
  RDSClient,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
} = require('@aws-sdk/client-rds');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { SSMClient, DescribeAutomationExecutionsCommand } = require('@aws-sdk/client-ssm');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const rds = new RDSClient({ region: process.env.AWS_REGION });
const sns = new SNSClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

const ENV_NAME = process.env.ENV_NAME;
const NAMESPACE = process.env.NAMESPACE;
const TOPIC_ARN = process.env.TOPIC_ARN;
const DRILL_INSTANCE = process.env.DRILL_INSTANCE;
const MAX_AGE_SECONDS = Number(process.env.MAX_AGE_SECONDS);
const DOCUMENT_NAMES = JSON.parse(process.env.DOCUMENT_NAMES);

const NOT_FOUND = ['DBInstanceNotFound', 'DBInstanceNotFoundFault'];

const describeOrUndefined = async () => {
  try {
    const result = await rds.send(
      new DescribeDBInstancesCommand({ DBInstanceIdentifier: DRILL_INSTANCE }),
    );
    return (result.DBInstances || [])[0];
  } catch (error) {
    if (NOT_FOUND.includes(error.name)) return undefined;
    throw error;
  }
};

const publishAge = async (ageSeconds, at) => {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: 'DrillInstanceAgeSeconds',
          Value: ageSeconds,
          Unit: 'Seconds',
          Timestamp: at,
          Dimensions: [{ Name: 'Environment', Value: ENV_NAME }],
        },
      ],
    }),
  );
};

/** Is a drill running right now? One call per document; there is one of them. */
const drillInProgress = async () => {
  for (const documentName of DOCUMENT_NAMES) {
    const result = await ssm.send(
      new DescribeAutomationExecutionsCommand({
        Filters: [
          { Key: 'DocumentNamePrefix', Values: [documentName] },
          { Key: 'ExecutionStatus', Values: ['InProgress'] },
        ],
        MaxResults: 10,
      }),
    );
    const running = result.AutomationExecutionMetadataList || [];
    if (running.length > 0) return running[0].AutomationExecutionId;
  }
  return undefined;
};

exports.handler = async () => {
  const now = new Date();
  const instance = await describeOrUndefined();

  if (instance === undefined || !instance.InstanceCreateTime) {
    // Zero rather than nothing. See the class docs: a metric that is absent
    // when there is nothing to report cannot distinguish "no copy" from "the
    // sweeper has stopped", and the alarm over it breaches on missing data
    // precisely so that the second case pages.
    await publishAge(0, now);
    const summary = { event: 'restore-drill-sweep', present: false };
    console.log(JSON.stringify(summary));
    return summary;
  }

  const ageSeconds = Math.round(
    (now.getTime() - new Date(instance.InstanceCreateTime).getTime()) / 1000,
  );
  await publishAge(ageSeconds, now);

  if (ageSeconds <= MAX_AGE_SECONDS) {
    const summary = {
      event: 'restore-drill-sweep',
      present: true,
      ageSeconds: ageSeconds,
      action: 'within-the-window',
    };
    console.log(JSON.stringify(summary));
    return summary;
  }

  if (instance.DBInstanceStatus === 'deleting') {
    const summary = {
      event: 'restore-drill-sweep',
      present: true,
      ageSeconds: ageSeconds,
      action: 'already-deleting',
    };
    console.log(JSON.stringify(summary));
    return summary;
  }

  const running = await drillInProgress();
  if (running !== undefined) {
    // Reported, not deleted. A drill slower than the window is a finding about
    // the restore path; a copy deleted mid-verification is a finding about the
    // sweeper that will be read as one about the backups.
    const summary = {
      event: 'restore-drill-sweep',
      present: true,
      ageSeconds: ageSeconds,
      action: 'drill-in-progress',
      executionId: running,
    };
    console.warn(JSON.stringify(summary));
    return summary;
  }

  await rds.send(
    new DeleteDBInstanceCommand({
      DBInstanceIdentifier: DRILL_INSTANCE,
      SkipFinalSnapshot: true,
      // As in the conductor's teardown: without this the deleted copy's
      // automated backups survive for the source's retention period, so every
      // swept orphan leaves a month of a full copy of production's data
      // somewhere nobody is looking.
      DeleteAutomatedBackups: true,
    }),
  );

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: (ENV_NAME + ' restore drill: deleted an abandoned copy').slice(0, 100),
      Message:
        DRILL_INSTANCE + ' had been running for ' + ageSeconds + 's, past the ' +
        MAX_AGE_SECONDS + 's a drill is allowed, with no drill execution in progress. It was a ' +
        'full-size copy of the ' + ENV_NAME + ' database and it has been deleted along with its ' +
        'automated backups.\\n\\n' +
        'The usual cause is an execution somebody cancelled between the restore and the ' +
        'teardown: SSM does not run onFailure for a cancelled execution, so nothing else would ' +
        'ever have removed this. Check the drill\\'s recent executions — if none was cancelled, ' +
        'the teardown step itself is failing and ' + ENV_NAME +
        '-restore-drill-conductor-errors should be red.',
    }),
  );

  const summary = {
    event: 'restore-drill-sweep',
    present: true,
    ageSeconds: ageSeconds,
    action: 'deleted',
  };
  console.warn(JSON.stringify(summary));
  return summary;
};
`;
