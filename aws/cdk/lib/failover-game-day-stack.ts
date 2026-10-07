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
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  GAME_DAY_NAMESPACE,
  GAME_DAY_SCENARIOS,
  GameDayScenario,
  METRIC_CONNECT_SUCCESS,
  METRIC_ENDPOINT_ADDRESS_CHANGED,
  METRIC_HOURS_SINCE_REHEARSAL,
  METRIC_MEASURED_RTO,
  METRIC_RESOLUTION_FAILED,
  METRIC_RESTORE_POINT_LAG,
  MAX_RESOLUTION_SECONDS,
  PROBE_RESOLUTION_SECONDS,
  PROBE_SAMPLES_PER_INVOCATION,
  PROBE_SAMPLE_INTERVAL_SECONDS,
  PROBE_SCHEDULE_SECONDS,
  RECORDER_INTERVAL_SECONDS,
  RECOVERY_OBJECTIVES,
  RecoveryObjective,
  assertValidGameDayCatalogue,
  gameDayDocumentName,
  objectiveFor,
  rehearsalParameterName,
  restorePointAlarmThresholdSeconds,
} from './game-days';

/**
 * Name of the SSM parameter holding the endpoint address the probe last saw.
 *
 * Not `/tmp`, which is where the obvious implementation puts it. A Lambda's
 * `/tmp` survives a warm invocation and nothing else, so on every cold start —
 * which for a one-minute schedule means after every deployment and after every
 * idle period — the probe would have no previous address and would report an
 * address change that did not happen. The one signal that distinguishes a
 * failover from a reboot would then be loudest exactly when nothing had failed
 * over.
 */
export const endpointAddressParameterName = (envName: string): string =>
  `/${envName}/game-day/endpoint-address`;

/** The ECS service the `no-deployment-in-progress` preflight reads. */
export interface GameDayServiceTarget {
  readonly clusterName: string;
  readonly serviceName: string;
}

export interface FailoverGameDayStackProps extends cdk.StackProps {
  /** Environment name. Decides which scenarios are built here — see the class docs. */
  readonly envName: string;
  /** VPC the probe runs in. The application's network, which is the caller's vantage point. */
  readonly vpc: ec2.IVpc;
  /**
   * Security group id of the database the probe connects to.
   *
   * An id rather than the construct, because the ingress rule is declared in
   * *this* stack — see the class docs on why the rule cannot live next to the
   * database.
   */
  readonly databaseSecurityGroupId: string;
  /** Endpoint hostname the probe resolves and connects to, as a caller would. */
  readonly databaseEndpointAddress: string;
  /**
   * Endpoint port (default: 5432).
   *
   * A literal, and deliberately not `instanceEndpoint.port`. That attribute is a
   * *string* on the CloudFormation resource, so using it puts an `Fn::ImportValue`
   * where the security-group rules want a number — which CloudFormation coerces
   * and cfn-lint reports — and it takes a strong cross-stack reference on a value
   * `RdsStack` cannot vary, since it pins PostgreSQL. The cost of the literal is
   * that changing the engine's port silently points the probe at a closed socket;
   * that failure is `<env>-db-connect-failing` going red within two minutes of
   * the deploy, which is loud.
   */
  readonly databasePort?: number;
  /** Instance identifier, for the failover call and the restore-point read. */
  readonly databaseInstanceIdentifier: string;
  /** Read by the `no-deployment-in-progress` preflight. */
  readonly service: GameDayServiceTarget;
  /**
   * IAM principals that may approve an exercise.
   *
   * Required, and refused when empty: `aws:approve` with no approvers is a
   * document that deploys cleanly and fails the moment anybody runs it, which is
   * during the game day somebody scheduled.
   */
  readonly approverArns: readonly string[];
  /** Emails subscribed to the exercise topic. */
  readonly notificationEmails?: readonly string[];
  /** Override the objectives. Tests only. */
  readonly objectives?: readonly RecoveryObjective[];
  /** Override the scenarios. Tests only. */
  readonly scenarios?: readonly GameDayScenario[];
  /** Connect timeout the probe uses, in milliseconds (default: 5000). */
  readonly probeConnectTimeoutMs?: number;
  /**
   * How long the automation waits after injecting the fault before measuring.
   *
   * Default: three times the objective's RTO, floored at five minutes. See the
   * class docs on why this is a sleep rather than a poll.
   */
  readonly settleSeconds?: number;
}

/**
 * Multi-AZ failover game day: inject the fault on purpose, and measure the
 * recovery from a signal that was already running.
 *
 * ## What was wrong with `multiAz: true`
 *
 * It is one line in `lib/rds-stack.ts` and it is the whole of this repository's
 * disaster-recovery story. It is also a claim about what AWS does rather than
 * about what happens here. AWS promotes the standby; what nobody had measured is
 * how long a caller waits, which is a different number and is usually dominated
 * by our side of the endpoint — a pool holding sockets to the old writer, a
 * resolver cache outliving the endpoint's TTL, a health check that passes
 * because the process is up. The failure is not that the number was wrong. There
 * was no number, and "RTO: 60 seconds" in a DR document is a figure from a
 * product page that nobody checks until the real AZ event.
 *
 * ## Architecture
 *
 *     probe (in the VPC, every minute)
 *       ├─ resolve the endpoint name          → EndpointAddressChanged
 *       └─ TCP connect to it, as a caller does → ConnectSuccess (1s resolution)
 *
 *     recorder (every five minutes)
 *       ├─ rds:DescribeDBInstances → LatestRestorableTime → RestorePointLagSeconds
 *       └─ the rehearsal log       → HoursSinceRehearsal
 *
 *     game day (a human, deliberately)
 *       approve → preflight → rds:RebootDBInstance(ForceFailover) → settle
 *              → measure the probe's datapoints → write the record
 *              └─ on any failure: record the abort and say why
 *
 * Six decisions are the design.
 *
 * **The measurement comes from a signal that is always on.** A game day timed on
 * a phone measures the exercise, and the exercise is not the interesting event.
 * `ConnectSuccess` is published every minute whether or not anyone is running
 * anything, so the arithmetic in `measureRto` produces the same number during the
 * real failover, with nobody awake and no preparation.
 *
 * **The probe runs inside the VPC, and that is the opposite of
 * `SyntheticCanaryStack`.** The canaries probe from outside the account because
 * the thing they have to see — DNS, TLS, WAF — is invisible from within it. Here
 * the caller *is* inside: the application connects to a private endpoint over the
 * same subnets and the same security groups, so a probe anywhere else would be
 * measuring a path nothing uses.
 *
 * **The ingress rule is declared here, not next to the database.** The probe
 * needs port 5432 on the database's security group and the probe needs the
 * database's endpoint, so a rule added in `RdsStack` would make each stack
 * depend on the other. A standalone `AWS::EC2::SecurityGroupIngress` in this
 * stack points at the database's group by id and changes nothing that `RdsStack`
 * owns.
 *
 * **The blast radius is structural rather than checked.** A scenario declares
 * `allowedEnvironments`, and `bin/app.ts` builds the automation document only
 * where the environment is in that list. A run in a forbidden environment is not
 * refused at run time; there is nothing to run. `tools/audit-game-days.ts` holds
 * the synthesised documents against the declaration, because the failure mode of
 * a runtime check is a document that exists in production and refuses — which is
 * one `--parameters` override away from not refusing.
 *
 * **The first step is a human.** Everything else this repository starts
 * automatically is read-only — `lib/runbooks.ts`' gate rejects a first step whose
 * API call is not a `Describe` — and this is the one automation that deliberately
 * changes production. So `aws:approve` is step one, with the scenario's summary
 * and blast radius in the message, and `operator-abort` is a mandatory abort
 * condition.
 *
 * **The wait is a sleep and not a poll.** The obvious shape is
 * `aws:waitForAwsResourceProperty` on `DBInstanceStatus == available`, and it has
 * a trap: for a few seconds after `RebootDBInstance` returns, the instance still
 * reads `available`, so the wait is satisfied immediately and the measurement
 * runs against a window in which nothing has happened yet. A fixed settle
 * period does not have that failure, and the status wait is kept — placed
 * *after* the sleep, where observing `available` means something — as the
 * implementation of the `instance-not-available-in-time` abort.
 *
 * ## The alarms, and the one that is supposed to fire
 *
 * `<env>-db-connect-failing` goes red during the exercise. That is the point: an
 * exercise in which the outage signal stays green has measured nothing, and the
 * game day is the only time anybody finds out that the signal works. It is
 * called out in `docs/game-days.md` §6 so that the page is expected rather than
 * surprising, and `<env>-game-day-probe-silent` is its counterpart — the alarm
 * whose subject is the probe's own absence, because a probe that stopped
 * reporting produces windows full of nothing, and nothing looks like health to
 * any arithmetic that averages.
 */
export class FailoverGameDayStack extends cdk.Stack {
  /** Exercise notifications and the alarms in this stack. */
  public readonly notificationTopic: sns.Topic;
  public readonly probe: lambda.Function;
  public readonly recorder: lambda.Function;
  /** Preflight, measurement and abort recording. Invoked by the automation only. */
  public readonly conductor: lambda.Function;
  /** Automation documents, keyed by scenario id. Empty where none is allowed here. */
  public readonly documents: Record<string, ssm.CfnDocument>;
  /** Role the game-day automations assume. Holds the one write in this repository. */
  public readonly automationRole: iam.Role;
  public readonly probeSecurityGroup: ec2.SecurityGroup;
  /**
   * The alarm that goes red when nothing in the VPC can reach the database.
   *
   * Exposed because `ChaosFisStack` stops its experiments on it. It is the one
   * alarm in this repository whose metric is published on a schedule rather than
   * by request traffic — the probe below emits `ConnectSuccess` every minute
   * whether or not anybody is running anything — which is the property that
   * makes it usable as a chaos guardrail in an environment nobody is calling.
   * See `TRAFFIC_INDEPENDENT_METRICS` in `lib/fis-experiments.ts`.
   */
  public readonly connectFailingAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: FailoverGameDayStackProps) {
    super(scope, id, props);

    const envName = props.envName;
    const objectives = props.objectives ?? RECOVERY_OBJECTIVES;
    const allScenarios = props.scenarios ?? GAME_DAY_SCENARIOS;
    const connectTimeoutMs = props.probeConnectTimeoutMs ?? 5000;
    const databasePort = props.databasePort ?? 5432;

    assertValidGameDayCatalogue(objectives, allScenarios);

    if (props.approverArns.length === 0) {
      throw new Error(
        `FailoverGameDayStack ${id}: approverArns is empty. \`aws:approve\` with no approvers ` +
          'synthesises, deploys and passes every rule in the gate, and fails at run time — ' +
          'during the exercise somebody put in the calendar.',
      );
    }

    // The blast radius, applied. A scenario that does not name this environment
    // has no document here, so there is nothing to run and nothing to refuse.
    //
    // Filtered by fault as well, because this stack is not the only one that
    // builds exercises any more: `BackupRestoreDrillStack` owns the
    // `rds-point-in-time-restore` scenarios, and without this line every drill
    // in the catalogue would also be emitted here as a `RebootDBInstance`
    // document — a forced failover carrying a restore drill's name, approval
    // message and blast radius, deployed and runnable.
    const scenarios = allScenarios.filter(
      (scenario) =>
        scenario.fault === 'rds-force-failover' &&
        scenario.allowedEnvironments.includes(envName),
    );

    // The exercises this stack does not build, kept because the freshness
    // signals below are published from here for *every* objective: the recorder
    // reads one parameter per objective and `HoursSinceRehearsal` is this
    // stack's metric, so the overdue alarm for an objective rehearsed elsewhere
    // belongs next to the metric rather than next to the document. What it needs
    // from the other scenarios is only their names, for the "run this" line in
    // the alarm description.
    const exercisedHere = allScenarios.filter((scenario) =>
      scenario.allowedEnvironments.includes(envName),
    );

    // ── Encryption ────────────────────────────────────────────────────────────
    const encryptionKey = new kms.Key(this, 'GameDayEncryptionKey', {
      alias: `alias/${envName}-game-day`,
      description: `Encrypts ${envName} game-day notifications, logs and the rehearsal record`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch publishes the alarms below to the topic, and a customer-managed
    // key means the service principal has to be named — the same statement
    // `RunbookStack` carries, for the same reason.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
      }),
    );

    // ── Where the exercise reports ────────────────────────────────────────────
    this.notificationTopic = new sns.Topic(this, 'GameDayTopic', {
      topicName: `${envName}-game-day`,
      displayName: `${envName} recovery exercises and DR signal alarms`,
      masterKey: encryptionKey,
    });
    for (const email of props.notificationEmails ?? []) {
      this.notificationTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── The probe ─────────────────────────────────────────────────────────────
    this.probeSecurityGroup = new ec2.SecurityGroup(this, 'GameDayProbeSecurityGroup', {
      securityGroupName: `${envName}-game-day-probe-sg`,
      vpc: props.vpc,
      description: `Connectivity probe for the ${envName} database endpoint`,
      allowAllOutbound: false,
    });
    this.probeSecurityGroup.addEgressRule(
      ec2.Peer.securityGroupId(props.databaseSecurityGroupId),
      ec2.Port.tcp(databasePort),
      'Probe the database endpoint on its own port',
    );
    // CloudWatch and SSM are reached over the NAT gateway in the private
    // subnets, which is how every other in-VPC function in this repository
    // reaches a regional API. Narrowing this to interface-endpoint prefix lists
    // would be better and is a VPC change, not a game-day one.
    this.probeSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'CloudWatch PutMetricData and SSM, via the NAT gateway',
    );

    // Declared here rather than on the database's group: see the class docs.
    new ec2.CfnSecurityGroupIngress(this, 'GameDayProbeToDatabase', {
      groupId: props.databaseSecurityGroupId,
      ipProtocol: 'tcp',
      fromPort: databasePort,
      toPort: databasePort,
      sourceSecurityGroupId: this.probeSecurityGroup.securityGroupId,
      description: `${envName} game-day connectivity probe`,
    });

    const probeLogGroup = new logs.LogGroup(this, 'GameDayProbeLogGroup', {
      logGroupName: `/aws/lambda/${envName}-game-day-probe`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const probeRole = new iam.Role(this, 'GameDayProbeRole', {
      roleName: `${envName}-game-day-probe-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Measures whether the ${envName} database endpoint answers`,
    });
    probeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    probeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
    );
    probeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishProbeMetrics',
        actions: ['cloudwatch:PutMetricData'],
        // PutMetricData takes no resource, so the namespace condition is the
        // only scope available — without it this role can write to `AWS/RDS`
        // and to every other namespace an alarm in this account reads.
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': GAME_DAY_NAMESPACE } },
      }),
    );
    probeRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RememberTheEndpointAddress',
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [
          `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter` +
            endpointAddressParameterName(envName),
        ],
      }),
    );

    this.probe = new lambda.Function(this, 'GameDayProbe', {
      functionName: `${envName}-game-day-probe`,
      description: `Resolves and connects to the ${envName} database endpoint once a minute`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: probeRole,
      // Six samples spaced ten seconds apart span fifty seconds, plus the last
      // connect's own deadline and the two parameter calls. Seventy is that with
      // room, and it is deliberately longer than the schedule: an invocation
      // that overran and was killed loses nothing here, because each sample is
      // published as it is taken.
      timeout: cdk.Duration.seconds(70),
      // Two, not one. The timeout above exceeds the schedule interval, so an
      // invocation running late overlaps the next — and with a reservation of
      // one the next is throttled away, leaving a sixty-second hole in exactly
      // the series a measurement needs to be unbroken. Two overlapping probes
      // write the same address to the same parameter, which is idempotent.
      reservedConcurrentExecutions: 2,
      environmentEncryption: encryptionKey,
      logGroup: probeLogGroup,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.probeSecurityGroup],
      environment: {
        ENV_NAME: envName,
        NAMESPACE: GAME_DAY_NAMESPACE,
        ENDPOINT_ADDRESS: props.databaseEndpointAddress,
        ENDPOINT_PORT: String(databasePort),
        TARGET: props.databaseInstanceIdentifier,
        ADDRESS_PARAMETER: endpointAddressParameterName(envName),
        CONNECT_TIMEOUT_MS: String(connectTimeoutMs),
        STORAGE_RESOLUTION: String(PROBE_RESOLUTION_SECONDS),
        SAMPLE_INTERVAL_MS: String(PROBE_SAMPLE_INTERVAL_SECONDS * 1000),
        SAMPLES_PER_INVOCATION: String(PROBE_SAMPLES_PER_INVOCATION),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(GAME_DAY_PROBE_SOURCE),
    });

    new events.Rule(this, 'GameDayProbeSchedule', {
      ruleName: `${envName}-game-day-probe-schedule`,
      description: 'Probe the database endpoint from inside the VPC',
      schedule: events.Schedule.rate(cdk.Duration.seconds(PROBE_SCHEDULE_SECONDS)),
      targets: [new targets.LambdaFunction(this.probe)],
    });

    // ── The recorder ──────────────────────────────────────────────────────────
    const recorderLogGroup = new logs.LogGroup(this, 'GameDayRecorderLogGroup', {
      logGroupName: `/aws/lambda/${envName}-game-day-recorder`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const recorderRole = new iam.Role(this, 'GameDayRecorderRole', {
      roleName: `${envName}-game-day-recorder-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Publishes the ${envName} restore-point lag and rehearsal freshness`,
    });
    recorderRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    recorderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishRecoveryMetrics',
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': GAME_DAY_NAMESPACE } },
      }),
    );
    recorderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadRestorePoint',
        actions: ['rds:DescribeDBInstances'],
        // DescribeDBInstances is not resource-scopable: it takes an identifier
        // as a filter and authorises against `*` regardless.
        resources: ['*'],
      }),
    );
    recorderRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadRehearsalLog',
        actions: ['ssm:GetParameter'],
        resources: objectives.map(
          (objective) =>
            `arn:${this.partition}:ssm:${this.region}:${this.account}:parameter` +
            rehearsalParameterName(envName, objective.id),
        ),
      }),
    );

    this.recorder = new lambda.Function(this, 'GameDayRecorder', {
      functionName: `${envName}-game-day-recorder`,
      description:
        `Publishes the ${envName} restore-point lag — the RPO nobody watches — and how stale ` +
        'each objective\'s last measurement is',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: recorderRole,
      timeout: cdk.Duration.seconds(30),
      reservedConcurrentExecutions: 1,
      environmentEncryption: encryptionKey,
      logGroup: recorderLogGroup,
      environment: {
        ENV_NAME: envName,
        NAMESPACE: GAME_DAY_NAMESPACE,
        DB_INSTANCE_IDENTIFIER: props.databaseInstanceIdentifier,
        OBJECTIVES: JSON.stringify(
          objectives.map((objective) => ({
            id: objective.id,
            path: objective.path,
            rpoBasis: objective.rpoBasis,
            rehearsalIntervalDays: objective.rehearsalIntervalDays,
            parameter: rehearsalParameterName(envName, objective.id),
          })),
        ),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(GAME_DAY_RECORDER_SOURCE),
    });

    new events.Rule(this, 'GameDayRecorderSchedule', {
      ruleName: `${envName}-game-day-recorder-schedule`,
      description: 'Publish restore-point lag and rehearsal freshness',
      schedule: events.Schedule.rate(cdk.Duration.seconds(RECORDER_INTERVAL_SECONDS)),
      targets: [new targets.LambdaFunction(this.recorder)],
    });

    // ── The conductor ─────────────────────────────────────────────────────────
    const conductorLogGroup = new logs.LogGroup(this, 'GameDayConductorLogGroup', {
      logGroupName: `/aws/lambda/${envName}-game-day-conductor`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const conductorRole = new iam.Role(this, 'GameDayConductorRole', {
      roleName: `${envName}-game-day-conductor-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Preflights, measures and records the ${envName} recovery exercises`,
    });
    conductorRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTheProbesDatapoints',
        // GetMetricData is the read; DescribeAlarms is the
        // `no-alarm-in-alarm-state` preflight. Neither takes a resource.
        actions: ['cloudwatch:GetMetricData', 'cloudwatch:DescribeAlarms'],
        resources: ['*'],
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
        sid: 'ReadTheDatabaseAndTheService',
        actions: ['rds:DescribeDBInstances', 'ecs:DescribeServices'],
        resources: ['*'],
      }),
    );
    conductorRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTheExecutionThatFailed',
        // How the abort record learns which step refused. SSM Automation gives a
        // failing step one destination, so seven steps routing to one abort step
        // would otherwise produce seven identical records saying only that
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

    this.conductor = new lambda.Function(this, 'GameDayConductor', {
      functionName: `${envName}-game-day-conductor`,
      description: `Preflight, RTO measurement and abort recording for ${envName} game days`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: conductorRole,
      // A measurement reads up to an hour of one-minute datapoints, which is one
      // GetMetricData call; the preflight is three reads. A minute is generous.
      timeout: cdk.Duration.seconds(60),
      reservedConcurrentExecutions: 2,
      environmentEncryption: encryptionKey,
      logGroup: conductorLogGroup,
      environment: {
        ENV_NAME: envName,
        NAMESPACE: GAME_DAY_NAMESPACE,
        TOPIC_ARN: this.notificationTopic.topicArn,
        DB_INSTANCE_IDENTIFIER: props.databaseInstanceIdentifier,
        TARGET: props.databaseInstanceIdentifier,
        CLUSTER_NAME: props.service.clusterName,
        SERVICE_NAME: props.service.serviceName,
        SAMPLE_INTERVAL_SECONDS: String(PROBE_SAMPLE_INTERVAL_SECONDS),
        MAX_RESOLUTION_SECONDS: String(MAX_RESOLUTION_SECONDS),
        SCENARIOS: JSON.stringify(
          scenarios.map((scenario) => {
            const objective = objectiveFor(scenario, objectives);
            return {
              id: scenario.id,
              title: scenario.title,
              objectiveId: scenario.objectiveId,
              preflight: scenario.preflight,
              rtoSeconds: objective?.rtoSeconds,
              parameter: rehearsalParameterName(envName, scenario.objectiveId),
            };
          }),
        ),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(GAME_DAY_CONDUCTOR_SOURCE),
    });

    (this.probe.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ, and here one would be actively harmful. The invoker is a schedule and each ' +
            'invocation publishes samples stamped with the moment it took them; a replayed ' +
            'invocation would publish samples minutes after the fact, into the series a ' +
            'measurement reads as a timeline, and the RTO derived from it would be nonsense ' +
            'rather than missing. A failed invocation is a hole in the series, which ' +
            '`<env>-game-day-probe-silent` reports and `measureRto` refuses to measure across.',
        },
      ],
    });

    (this.recorder.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: the invoker is a schedule and every run recomputes both gauges from the ' +
            'instance and the parameter. A failed run is superseded five minutes later, and the ' +
            'alarms over both metrics breach on missing data, so a run that never happened is ' +
            'reported rather than replayed.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the recorder calls only the regional RDS, SSM and CloudWatch APIs ' +
            'and touches no VPC resource. The probe, which stands in for a caller and therefore ' +
            'has to be on the caller\'s network, is in it.',
        },
      ],
    });

    (this.conductor.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: SSM Automation invokes this synchronously, so a failure is returned to the ' +
            'step rather than dropped — and the step routes to `recordAbort`, which writes the ' +
            'failure down. An asynchronous dead-letter queue is not reachable from a synchronous ' +
            'invoke, so one here would satisfy the check and catch nothing.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the conductor calls only the regional CloudWatch, RDS, ECS, SSM and ' +
            'SNS APIs. Attaching it would put the NAT gateway on the path of the thing that ' +
            'measures whether recovery works.',
        },
      ],
    });

    // ── The exercises ─────────────────────────────────────────────────────────
    // One role for every scenario. It holds the only deliberate write in this
    // repository's automation surface, and `tools/audit-game-days.ts` checks that
    // the write is scoped to one instance: `rds:RebootDBInstance` on `*` is a
    // grant to reboot every database in the account, and it reads in a diff
    // exactly like the scoped one.
    this.automationRole = new iam.Role(this, 'GameDayAutomationRole', {
      roleName: `${envName}-game-day-automation-role`,
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
      description: `Injects and measures the ${envName} recovery exercises`,
    });
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTheInstance',
        actions: ['rds:DescribeDBInstances'],
        resources: ['*'],
      }),
    );
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ForceTheFailover',
        actions: ['rds:RebootDBInstance'],
        resources: [
          `arn:${this.partition}:rds:${this.region}:${this.account}:db:` +
            props.databaseInstanceIdentifier,
        ],
      }),
    );
    this.automationRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RunTheConductor',
        actions: ['lambda:InvokeFunction'],
        resources: [this.conductor.functionArn],
      }),
    );
    // `aws:approve` publishes the approval request through SNS on the
    // automation's own identity, so without this the exercise starts, waits for
    // an approval nobody was told about, and times out.
    this.notificationTopic.grantPublish(this.automationRole);

    this.documents = {};
    for (const scenario of scenarios) {
      const objective = objectiveFor(scenario, objectives);
      if (objective === undefined) {
        // Unreachable: `assertValidGameDayCatalogue` reports
        // `scenario-objective-unknown` above. Restated because a document built
        // without an objective would have no RTO to settle against and no
        // parameter to record into.
        throw new Error(
          `FailoverGameDayStack ${id}: scenario '${scenario.id}' names objective ` +
            `'${scenario.objectiveId}', which is not in the catalogue.`,
        );
      }
      const settleSeconds =
        props.settleSeconds ?? Math.max(300, objective.rtoSeconds * 3);

      this.documents[scenario.id] = new ssm.CfnDocument(
        this,
        `${pascalCase(scenario.id)}GameDayDocument`,
        {
          name: gameDayDocumentName(envName, scenario.id),
          documentType: 'Automation',
          documentFormat: 'JSON',
          updateMethod: 'NewVersion',
          targetType: '/',
          content: gameDayDocumentContent({
            scenario,
            objective,
            envName,
            settleSeconds,
            automationRoleArn: this.automationRole.roleArn,
            conductorFunctionName: this.conductor.functionName,
            topicArn: this.notificationTopic.topicArn,
            approverArns: props.approverArns,
            databaseInstanceIdentifier: props.databaseInstanceIdentifier,
          }),
          tags: [
            { key: 'Environment', value: envName },
            { key: 'GameDayScenario', value: scenario.id },
          ],
        },
      );
    }

    // ── The signals ───────────────────────────────────────────────────────────
    const probeDimensions = { Environment: envName, Target: props.databaseInstanceIdentifier };

    const connectFailing = new cloudwatch.Alarm(this, 'DatabaseConnectFailingAlarm', {
      alarmName: `${envName}-db-connect-failing`,
      alarmDescription:
        `Nothing in the ${envName} VPC can open a connection to the database endpoint. This is ` +
        'the alarm a Multi-AZ failover is supposed to trip, so it goes red during a game day ' +
        'on purpose — see docs/game-days.md#6-the-alarm-that-is-supposed-to-fire. Outside an ' +
        'exercise it means the writer is gone and the promotion has not finished, or the ' +
        'endpoint now resolves somewhere the security group does not allow. Owner: ' +
        'platform-team.',
      metric: new cloudwatch.Metric({
        namespace: GAME_DAY_NAMESPACE,
        metricName: METRIC_CONNECT_SUCCESS,
        dimensionsMap: probeDimensions,
        // A minute, not the ten seconds the measurement reads this same metric
        // at. The two want different things from it on purpose: a measurement
        // wants every sample, and a pager wants two minutes of agreement before
        // it wakes anybody — a single failed sample is a blip, and CloudWatch
        // will aggregate the high-resolution datapoints into these buckets for
        // free.
        period: cdk.Duration.seconds(PROBE_SCHEDULE_SECONDS),
        statistic: 'Minimum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      // Absence is the subject of `<env>-game-day-probe-silent` below, and
      // paging twice for one cause is how a responder learns to read one of the
      // two. MISSING holds the last known state rather than inventing one.
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    connectFailing.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));
    this.connectFailingAlarm = connectFailing;

    const probeSilent = new cloudwatch.Alarm(this, 'GameDayProbeSilentAlarm', {
      alarmName: `${envName}-game-day-probe-silent`,
      alarmDescription:
        `The ${envName} database probe has stopped reporting. Nothing is known to be broken; ` +
        'what has broken is the ability to find out — every RTO measured from here on, and ' +
        'every game day run in the meantime, reads an empty window, which averages to health. ' +
        'Owner: platform-team.',
      metric: new cloudwatch.Metric({
        namespace: GAME_DAY_NAMESPACE,
        metricName: METRIC_CONNECT_SUCCESS,
        dimensionsMap: probeDimensions,
        period: cdk.Duration.minutes(5),
        // The count of datapoints, not their value: a probe reporting nothing
        // and a probe reporting failures are different incidents with different
        // first steps.
        statistic: 'SampleCount',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      // The whole subject of this alarm is missing data, so it is the one alarm
      // here that must breach on it.
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });
    probeSilent.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));

    const resolutionFailing = new cloudwatch.Alarm(this, 'EndpointResolutionFailingAlarm', {
      alarmName: `${envName}-game-day-endpoint-unresolvable`,
      alarmDescription:
        `The ${envName} database endpoint name is not resolving. During a promotion the record ` +
        'changes and continues to resolve; a name that resolves to nothing is a deleted ' +
        'instance, a deleted hosted zone, or a VPC that has lost DNS resolution — none of ' +
        'which a failover fixes. Owner: platform-team.',
      metric: new cloudwatch.Metric({
        namespace: GAME_DAY_NAMESPACE,
        metricName: METRIC_RESOLUTION_FAILED,
        dimensionsMap: probeDimensions,
        period: cdk.Duration.seconds(PROBE_SCHEDULE_SECONDS),
        statistic: 'Maximum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    resolutionFailing.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));

    for (const objective of objectives) {
      if (objective.rpoBasis === 'latest-restorable-time') {
        const threshold = restorePointAlarmThresholdSeconds(objective);
        const stale = new cloudwatch.Alarm(
          this,
          `RestorePointStaleAlarm${pascalCase(objective.id)}`,
          {
            alarmName: `${envName}-restore-point-stale`,
            alarmDescription:
              `The ${envName} database's restore point has stopped advancing. The instance is ` +
              'healthy and the backups are enabled; what has changed is that the data ' +
              'recoverable by a point-in-time restore is getting older, which is the only RPO ' +
              `here that can go wrong without anything failing. Objective: ` +
              `${objective.rpoSeconds}s of loss; this fires past ${threshold}s, which is one ` +
              'sample interval clear of the sawtooth — see docs/game-days.md#5-the-rpo-nobody-' +
              'watches. Owner: ' +
              `${objective.owner}.`,
            metric: new cloudwatch.Metric({
              namespace: GAME_DAY_NAMESPACE,
              metricName: METRIC_RESTORE_POINT_LAG,
              dimensionsMap: { Environment: envName, Objective: objective.id },
              period: cdk.Duration.seconds(RECORDER_INTERVAL_SECONDS),
              statistic: 'Maximum',
            }),
            threshold,
            comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
            evaluationPeriods: 2,
            // No reading is not a small lag. The recorder publishes nothing when
            // `LatestRestorableTime` is absent — which is what an instance with
            // no backup retention looks like — and "we do not know whether this
            // can be restored" carries the same risk as "it cannot".
            treatMissingData: cloudwatch.TreatMissingData.BREACHING,
          },
        );
        stale.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));
      }

      // Only the rehearsed objectives are armed. A `declared` one has no
      // scenario to rehearse it, so an overdue alarm on it would be red forever
      // and would say nothing the status does not already say.
      if (objective.status !== 'rehearsed') continue;

      // And only where an exercise for it exists in this environment — in this
      // stack or in `BackupRestoreDrillStack`. An alarm whose instruction is
      // "run this document" in an environment that has no such document is an
      // alarm nobody can clear, and the responder's only options are to widen
      // the interval or to mute it. The case is not thereby
      // ignored: `tools/audit-game-days.ts` requires an overdue alarm for every
      // rehearsed objective in every environment that publishes the signal, so
      // a scenario that excludes production while its objective claims a number
      // for production fails the build here rather than going unmeasured there.
      if (!exercisedHere.some((candidate) => candidate.objectiveId === objective.id)) continue;

      const overdue = new cloudwatch.Alarm(this, `RehearsalOverdueAlarm${pascalCase(objective.id)}`, {
        alarmName: `${envName}-rehearsal-overdue-${objective.id}`,
        alarmDescription:
          `The ${envName} '${objective.id}' objective has not been measured inside its ` +
          `${objective.rehearsalIntervalDays}-day interval, so its RTO of ` +
          `${objective.rtoSeconds}s is now a number from the last time somebody checked. An ` +
          'engine upgrade, an instance-class change or a new connection pool each move it, and ' +
          'none of them is a change anybody files under disaster recovery. Run ' +
          `\`${gameDayDocumentName(envName, scenariosForAlarm(objective, exercisedHere))}\`. Owner: ` +
          `${objective.owner}.`,
        metric: new cloudwatch.Metric({
          namespace: GAME_DAY_NAMESPACE,
          metricName: METRIC_HOURS_SINCE_REHEARSAL,
          dimensionsMap: { Environment: envName, Objective: objective.id },
          period: cdk.Duration.hours(1),
          statistic: 'Maximum',
        }),
        threshold: objective.rehearsalIntervalDays * 24,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 1,
        // An objective that has never been rehearsed has no datapoint, and that
        // is the state this alarm exists for. Treating it as OK would mean the
        // alarm arms itself only once somebody has already done the thing it is
        // reminding them to do.
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      overdue.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));
    }

    for (const [fn, label] of [
      [this.probe, 'probe'],
      [this.recorder, 'recorder'],
    ] as const) {
      const errors = new cloudwatch.Alarm(this, `GameDay${capitalise(label)}ErrorsAlarm`, {
        alarmName: `${envName}-game-day-${label}-errors`,
        alarmDescription:
          `The ${envName} game-day ${label} is failing. The signal it publishes is the one the ` +
          'recovery objectives are measured against, so while this is red the DR numbers are ' +
          'stale rather than wrong. Owner: platform-team.',
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      errors.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));
    }

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    new cdk.CfnOutput(this, 'GameDayTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'Recovery exercises and DR signal alarms',
      exportName: `${envName}-game-day-topic-arn`,
    });
    new cdk.CfnOutput(this, 'GameDayDocuments', {
      value: scenarios.map((scenario) => gameDayDocumentName(envName, scenario.id)).join(',') || 'none',
      description: 'Automation documents runnable in this environment',
    });
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const pascalCase = (value: string): string => value.split('-').map(capitalise).join('');

/**
 * The scenario id named in the overdue alarm's description.
 *
 * The caller has already established that a scenario for this objective exists
 * in this environment, and `validateGameDayCatalogue` has refused the case where
 * two do — so there is exactly one. The fallback stays because an alarm
 * description is not the place to throw: `(none)` in the text of an alert is a
 * clearer failure than a stack that will not synthesise for a reason three files
 * away.
 */
const scenariosForAlarm = (
  objective: RecoveryObjective,
  scenarios: readonly GameDayScenario[],
): string => scenarios.find((s) => s.objectiveId === objective.id)?.id ?? '(none)';

interface DocumentInput {
  readonly scenario: GameDayScenario;
  readonly objective: RecoveryObjective;
  readonly envName: string;
  readonly settleSeconds: number;
  readonly automationRoleArn: string;
  readonly conductorFunctionName: string;
  readonly topicArn: string;
  readonly approverArns: readonly string[];
  readonly databaseInstanceIdentifier: string;
}

/**
 * The exercise, as CloudFormation will hold it.
 *
 * Read top to bottom it is the procedure: ask a human, check the four things
 * that make the measurement mean anything, break it, wait, measure, write it
 * down. Every step's `onFailure` is the same abort step, so there is no path
 * through this document that ends without a record — an exercise that vanished
 * is indistinguishable from one nobody ran, and the second is the story people
 * tell themselves.
 */
export const gameDayDocumentContent = (input: DocumentInput): Record<string, unknown> => {
  const { scenario, objective, envName } = input;

  const parameters: Record<string, unknown> = {
    AutomationAssumeRole: {
      type: 'String',
      description: 'Role the exercise assumes. Holds one write, scoped to one instance.',
      default: input.automationRoleArn,
    },
    DbInstanceIdentifier: {
      type: 'String',
      description: 'Database instance the fault is injected into',
      default: input.databaseInstanceIdentifier,
    },
    Approvers: {
      type: 'StringList',
      description: 'IAM principals who may approve this exercise',
      default: [...input.approverArns],
    },
  };

  const abortOnFailure = 'step:recordAbort';

  return {
    schemaVersion: '0.3',
    description:
      `${scenario.title} — ${envName}. ${scenario.summary} Objective: ` +
      `${objective.rtoSeconds}s RTO, ${objective.rpoSeconds}s RPO on ` +
      `${objective.rpoBasis}. Expect ${scenario.expectedDurationMinutes} minutes. See ` +
      'docs/game-days.md.',
    assumeRole: '{{ AutomationAssumeRole }}',
    parameters,
    mainSteps: [
      {
        // `operator-abort`, and the reason this document is not something a
        // schedule may start. Rejecting is a normal outcome and the exercise
        // records it.
        name: 'approve',
        action: 'aws:approve',
        onFailure: abortOnFailure,
        // Long enough for an approval to reach somebody in another timezone,
        // short enough that a forgotten request does not sit open for a day
        // waiting to inject a failover into production at an hour nobody chose.
        timeoutSeconds: 3600,
        inputs: {
          NotificationArn: input.topicArn,
          Message:
            `${envName}: ${scenario.title}. This will reboot ` +
            `${input.databaseInstanceIdentifier} with ForceFailover and measure the ` +
            `caller-side outage against a ${objective.rtoSeconds}s objective. Connections ` +
            'will fail while the standby is promoted, and ' +
            `${envName}-db-connect-failing will page. Approve only if this environment can ` +
            `take a ${objective.rtoSeconds}s database outage right now. Blast radius: ` +
            `${scenario.allowedEnvironments.join(', ')}.`,
          MinRequiredApprovals: 1,
          Approvers: '{{ Approvers }}',
        },
      },
      {
        // `multi-az-enabled`, declaratively. On a Single-AZ instance the call
        // below is a reboot: the probe records an outage, the exercise reports a
        // measured RTO, and the number is for a failover that never happened.
        // Asserted here rather than inside the conductor so that it is visible
        // in the document, and checkable by the gate, without reading a Lambda.
        name: 'assertMultiAz',
        action: 'aws:assertAwsResourceProperty',
        onFailure: abortOnFailure,
        timeoutSeconds: 60,
        inputs: {
          Service: 'rds',
          Api: 'DescribeDBInstances',
          DBInstanceIdentifier: '{{ DbInstanceIdentifier }}',
          PropertySelector: '$.DBInstances[0].MultiAZ',
          // Both spellings. `DesiredValues` is a list of strings compared
          // against the string form of whatever the selector returns, and the
          // case SSM uses for a boolean is not something the API documents —
          // AWS's own examples use both. Getting it wrong aborts every exercise
          // at the second step, which is the safe direction and still a bug
          // nobody would find until the first game day.
          DesiredValues: ['True', 'true'],
        },
      },
      {
        // `probe-reporting`, `no-alarm-in-alarm-state` and
        // `no-deployment-in-progress` — each a read of something that is not a
        // property of one resource, which is why they are in the conductor
        // rather than three more asserts. Returns the timestamp the measurement
        // window starts at, so the window is bounded by the exercise rather than
        // by a lookback that could pick up an earlier outage.
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
          { Name: 'checksPassed', Selector: '$.Payload.checksPassed', Type: 'StringList' },
        ],
      },
      {
        name: 'injectFailover',
        action: 'aws:executeAwsApi',
        onFailure: abortOnFailure,
        timeoutSeconds: 120,
        inputs: {
          Service: 'rds',
          Api: 'RebootDBInstance',
          DBInstanceIdentifier: '{{ DbInstanceIdentifier }}',
          // The whole exercise. Without it this is a reboot of the primary,
          // which has an outage and no promotion, and the two are
          // indistinguishable in everything except this flag.
          ForceFailover: true,
        },
      },
      {
        // Not `aws:waitForAwsResourceProperty` on `available`: for a few seconds
        // after the call above the instance still reads `available`, so that
        // wait is satisfied immediately and the measurement runs over a window
        // in which nothing has happened. The status wait is the step after this
        // one, where observing `available` means something.
        name: 'settle',
        action: 'aws:sleep',
        onFailure: abortOnFailure,
        inputs: { Duration: `PT${Math.round(input.settleSeconds)}S` },
      },
      {
        // `instance-not-available-in-time`.
        name: 'waitForAvailable',
        action: 'aws:waitForAwsResourceProperty',
        onFailure: abortOnFailure,
        timeoutSeconds: 1800,
        inputs: {
          Service: 'rds',
          Api: 'DescribeDBInstances',
          DBInstanceIdentifier: '{{ DbInstanceIdentifier }}',
          PropertySelector: '$.DBInstances[0].DBInstanceStatus',
          DesiredValues: ['available'],
        },
      },
      {
        // `probe-failing-past-rto-budget` lives in here: the conductor throws
        // when the window it reads has no resolved outage in it, which is the
        // one case where reporting a number would be reporting a lower bound as
        // a measurement.
        name: 'measure',
        action: 'aws:invokeLambdaFunction',
        onFailure: abortOnFailure,
        timeoutSeconds: 120,
        isEnd: true,
        inputs: {
          FunctionName: input.conductorFunctionName,
          InputPayload: {
            operation: 'measure',
            scenarioId: scenario.id,
            windowStart: '{{ preflight.startedAt }}',
            executionId: '{{ automation:EXECUTION_ID }}',
          },
        },
        outputs: [
          { Name: 'outcome', Selector: '$.Payload.outcome', Type: 'String' },
          { Name: 'measuredRtoSeconds', Selector: '$.Payload.measuredRtoSeconds', Type: 'String' },
          { Name: 'verdict', Selector: '$.Payload.verdict', Type: 'String' },
        ],
      },
      {
        // Every step above fails into here. An exercise that ended without a
        // record is one nobody can tell from an exercise nobody ran, and the
        // refusals are the most useful thing this produces: three aborted
        // attempts in a row is a finding about the environment.
        name: 'recordAbort',
        action: 'aws:invokeLambdaFunction',
        timeoutSeconds: 120,
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
    outputs: ['measure.outcome', 'measure.measuredRtoSeconds', 'measure.verdict'],
  };
};

/* ── The probe ────────────────────────────────────────────────────────────── */

/**
 * The probe, shipped inline.
 *
 * Exported as a string so `test/game-day-probe-handler.test.ts` can compile and
 * run it: `lambda.Code.fromInline` means nothing else in the build parses it, and
 * every decision in here fails in the direction that looks like health — a
 * connect that is never attempted, a timeout that never fires, an address change
 * reported on every cold start.
 *
 * It connects to the endpoint by **name**, not to the address it resolved a line
 * earlier, because that is what a caller does and the difference is the whole
 * point: a client that has cached the pre-failover address keeps failing after
 * RDS considers the promotion complete, and a probe that dials the address it
 * just looked up would never see it.
 */
export const GAME_DAY_PROBE_SOURCE = `
'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

const NAMESPACE = process.env.NAMESPACE;
const HOST = process.env.ENDPOINT_ADDRESS;
const PORT = Number(process.env.ENDPOINT_PORT);
const TIMEOUT_MS = Number(process.env.CONNECT_TIMEOUT_MS);
const STORAGE_RESOLUTION = Number(process.env.STORAGE_RESOLUTION);
const SAMPLE_INTERVAL_MS = Number(process.env.SAMPLE_INTERVAL_MS);
const SAMPLES_PER_INVOCATION = Number(process.env.SAMPLES_PER_INVOCATION);
const ADDRESS_PARAMETER = process.env.ADDRESS_PARAMETER;

const DIMENSIONS = [
  { Name: 'Environment', Value: process.env.ENV_NAME },
  { Name: 'Target', Value: process.env.TARGET },
];

/**
 * Connect the way the application's pool does: by name, with a deadline.
 *
 * Two timers rather than one. \`socket.setTimeout\` is an idle timeout and does
 * fire during the connect phase, but a DNS lookup that hangs happens before the
 * socket exists — so the explicit timer is what bounds the whole attempt. A
 * probe that can hang is a probe that stops reporting during the event it exists
 * to measure, which is the failure the silence alarm is for and the one worth
 * not having.
 */
const connect = () =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let socket;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (socket) socket.destroy();
      resolve({ ok, latencyMs: Date.now() - startedAt, error });
    };
    const deadline = setTimeout(() => finish(false, 'deadline'), TIMEOUT_MS);
    try {
      socket = net.createConnection({ host: HOST, port: PORT });
      socket.setTimeout(TIMEOUT_MS);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false, 'timeout'));
      socket.once('error', (error) => finish(false, error.message));
    } catch (error) {
      finish(false, error.message);
    }
  });

/** What the name resolves to right now, or undefined if it does not. */
const resolveAddress = async () => {
  try {
    const { address } = await dns.lookup(HOST);
    return address;
  } catch (error) {
    console.warn(JSON.stringify({ event: 'endpoint-resolution-failed', host: HOST, error: error.message }));
    return undefined;
  }
};

/**
 * The address the probe saw last time, from SSM rather than from /tmp.
 *
 * A missing parameter is a first run, not a change: reporting a change on the
 * first run would make every deployment look like a failover.
 */
const readPreviousAddress = async () => {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: ADDRESS_PARAMETER }));
    return result.Parameter && result.Parameter.Value ? result.Parameter.Value : undefined;
  } catch (error) {
    // A first run, which is not a change: reporting one would make every
    // deployment look like a failover. Every other error is left to the caller,
    // which treats it as "could not look" rather than as "did not change".
    if (error.name === 'ParameterNotFound') return undefined;
    throw error;
  }
};

const sleepUntil = (target) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, target - Date.now())));

exports.handler = async () => {
  const invokedAt = Date.now();

  // Once per invocation, not once per sample. The address is bookkeeping and the
  // connect is the measurement: six SSM reads a minute to answer a question that
  // changes twice a year would be the expensive half of this stack.
  const address = await resolveAddress();
  let addressChanged;
  if (address !== undefined) {
    // Non-fatal, deliberately. This is bookkeeping and the connect below is the
    // measurement: an SSM throttle, a deleted parameter or a denied
    // PutParameter must not cost the six samples this invocation is here to
    // take, because a hole in the series is what \`measureRto\` refuses to
    // measure across. A first run is not this path: readPreviousAddress handles
    // ParameterNotFound itself, so the baseline still gets recorded.
    try {
      const previous = await readPreviousAddress();
      addressChanged = previous !== undefined && previous !== address;
      if (previous !== address) {
        await ssm.send(
          new PutParameterCommand({
            Name: ADDRESS_PARAMETER,
            Value: address,
            Type: 'String',
            Overwrite: true,
            Description: 'Address the game-day probe last resolved the database endpoint to',
          }),
        );
      }
    } catch (error) {
      console.warn(JSON.stringify({ event: 'endpoint-address-unreadable', error: error.message }));
      addressChanged = undefined;
    }
  }

  const publishFailures = [];

  const samples = [];
  for (let index = 0; index < SAMPLES_PER_INVOCATION; index += 1) {
    // Slots are measured from the invocation, not from the previous sample, so a
    // slow connect or a slow publish does not push the rest of the series later
    // and later — which over six samples would leave a hole at the minute
    // boundary that a measurement counts against itself.
    await sleepUntil(invokedAt + index * SAMPLE_INTERVAL_MS);

    const timestamp = new Date();
    const result = await connect();
    const common = {
      Timestamp: timestamp,
      Dimensions: DIMENSIONS,
      StorageResolution: STORAGE_RESOLUTION,
    };
    const metricData = [
      { ...common, MetricName: 'ConnectSuccess', Value: result.ok ? 1 : 0, Unit: 'Count' },
    ];
    if (result.ok) {
      metricData.push({ ...common, MetricName: 'ConnectLatencyMs', Value: result.latencyMs, Unit: 'Milliseconds' });
    }
    if (index === 0) {
      metricData.push({
        ...common,
        MetricName: 'EndpointResolutionFailed',
        Value: address === undefined ? 1 : 0,
        Unit: 'Count',
      });
      // Deliberately omitted, rather than published as 0, when the name did not
      // resolve: "it did not change" and "we could not look" are different
      // facts, and a zero here would be the probe asserting the first while
      // observing the second.
      if (addressChanged !== undefined) {
        metricData.push({
          ...common,
          MetricName: 'EndpointAddressChanged',
          Value: addressChanged ? 1 : 0,
          Unit: 'Count',
        });
      }
    }

    // Published per sample rather than batched at the end. An invocation killed
    // at its timeout — or throttled, or hitting a cold-start pause — then costs
    // the samples it had not taken yet and none of the ones it had, which is the
    // difference between a coarser measurement and a refused one. A failed
    // publish is collected rather than thrown for the same reason: one
    // throttled call must not take the other five samples with it. The throw
    // comes after the loop, so \`<env>-game-day-probe-errors\` still reports it.
    try {
      await cloudwatch.send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: metricData }));
    } catch (error) {
      publishFailures.push(error.message);
    }
    samples.push({ at: timestamp.toISOString(), connected: result.ok, latencyMs: result.ok ? result.latencyMs : null, error: result.error ?? null });
  }

  const summary = {
    event: 'game-day-probe',
    host: HOST,
    port: PORT,
    address: address ?? null,
    addressChanged: addressChanged ?? null,
    samples,
    failed: samples.filter((sample) => !sample.connected).length,
  };
  console.log(JSON.stringify(summary));

  if (publishFailures.length > 0) {
    throw new Error(
      publishFailures.length + ' of ' + SAMPLES_PER_INVOCATION + ' sample(s) could not be ' +
        'published: ' + publishFailures.join('; '),
    );
  }

  return summary;
};
`;

/* ── The recorder ─────────────────────────────────────────────────────────── */

/**
 * The recorder, shipped inline.
 *
 * Publishes the two numbers that are true between exercises: how old the restore
 * point is, and how stale the last measurement is. Neither is a metric AWS
 * offers — `LatestRestorableTime` is a timestamp on a describe call, and the
 * rehearsal date is in a parameter this repository writes — so neither is
 * alarmable until something turns it into a gauge.
 *
 * It publishes nothing at all for a reading it cannot make, and that is the
 * decision worth keeping: the alarms over both metrics breach on missing data,
 * so an absent reading pages rather than reading as a healthy zero. An instance
 * with backup retention set to zero has no `LatestRestorableTime`, and the lag
 * that describes it is not small — there is no restore path.
 */
export const GAME_DAY_RECORDER_SOURCE = `
'use strict';
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const rds = new RDSClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

const NAMESPACE = process.env.NAMESPACE;
const ENV_NAME = process.env.ENV_NAME;
const DB_INSTANCE_IDENTIFIER = process.env.DB_INSTANCE_IDENTIFIER;
const OBJECTIVES = JSON.parse(process.env.OBJECTIVES);

const readLog = async (name) => {
  try {
    const result = await ssm.send(new GetParameterCommand({ Name: name }));
    const raw = result.Parameter && result.Parameter.Value;
    if (typeof raw !== 'string') return undefined;
    const parsed = JSON.parse(raw);
    if (typeof parsed.objectiveId !== 'string' || typeof parsed.lastAttempt !== 'object') {
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (error.name === 'ParameterNotFound') return undefined;
    // A parameter that will not parse is treated as no parameter, for the same
    // reason lib/game-days.ts does: throwing here takes the freshness metric off
    // the air, and an objective with no freshness metric has no overdue alarm.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

exports.handler = async () => {
  const now = new Date();
  const described = await rds.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: DB_INSTANCE_IDENTIFIER }),
  );
  const instance = (described.DBInstances || [])[0] || {};
  const latestRestorableTime = instance.LatestRestorableTime
    ? new Date(instance.LatestRestorableTime)
    : undefined;

  const metricData = [];
  const report = [];

  for (const objective of OBJECTIVES) {
    const dimensions = [
      { Name: 'Environment', Value: ENV_NAME },
      { Name: 'Objective', Value: objective.id },
    ];

    if (objective.rpoBasis === 'latest-restorable-time') {
      if (latestRestorableTime === undefined) {
        report.push({ objectiveId: objective.id, restorePointLagSeconds: null, reason: 'absent' });
      } else {
        const lagSeconds = Math.round((now.getTime() - latestRestorableTime.getTime()) / 1000);
        if (lagSeconds < 0) {
          // Clamping to zero would publish a perfect RPO out of a broken clock.
          report.push({ objectiveId: objective.id, restorePointLagSeconds: null, reason: 'in-the-future' });
        } else {
          metricData.push({
            MetricName: 'RestorePointLagSeconds',
            Value: lagSeconds,
            Unit: 'Seconds',
            Timestamp: now,
            Dimensions: dimensions,
          });
          report.push({ objectiveId: objective.id, restorePointLagSeconds: lagSeconds });
        }
      }
    }

    const log = await readLog(objective.parameter);
    const completedAt = log && log.lastMeasured ? log.lastMeasured.completedAt : undefined;
    const measuredAt = typeof completedAt === 'string' ? new Date(completedAt) : undefined;
    if (measuredAt === undefined || Number.isNaN(measuredAt.getTime())) {
      // Never measured, or a record that will not parse. No datapoint, so the
      // overdue alarm breaches on missing data — which is the correct verdict
      // and the reason no sentinel value is invented here.
      report.push({ objectiveId: objective.id, hoursSinceRehearsal: null });
      continue;
    }
    const hoursSince = (now.getTime() - measuredAt.getTime()) / 3600000;
    metricData.push({
      MetricName: 'HoursSinceRehearsal',
      Value: Math.max(0, hoursSince),
      Unit: 'Count',
      Timestamp: now,
      Dimensions: dimensions,
    });
    report.push({ objectiveId: objective.id, hoursSinceRehearsal: hoursSince });
  }

  if (metricData.length > 0) {
    await cloudwatch.send(new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: metricData }));
  }

  const summary = { event: 'game-day-recorder', published: metricData.length, objectives: report };
  console.log(JSON.stringify(summary));
  return summary;
};
`;

/* ── The conductor ────────────────────────────────────────────────────────── */

/**
 * The conductor, shipped inline: preflight, measurement, and the abort record.
 *
 * The RTO arithmetic in here is the same arithmetic as `measureRto` in
 * `lib/game-days.ts`, written twice because `lambda.Code.fromInline` cannot
 * import. That is a real risk and it is handled the way this repository handles
 * the other one like it: `test/game-day-conductor-handler.test.ts` runs a table
 * of hand-built outages — clean recoveries, a window that starts failing, one
 * that ends failing, a gap across the event — through both implementations and
 * asserts they agree, so a change to either is a failing assertion rather than a
 * number nobody can reproduce.
 *
 * `preflight` is allowed to refuse, and refusing is the common case: something
 * is already in ALARM, a deploy is halfway out, the probe is quiet. A refusal
 * throws, which fails the step, which routes to `recordAbort` — so the exercise
 * that did not happen is still written down.
 */
export const GAME_DAY_CONDUCTOR_SOURCE = `
'use strict';
const {
  CloudWatchClient,
  DescribeAlarmsCommand,
  GetMetricDataCommand,
  PutMetricDataCommand,
} = require('@aws-sdk/client-cloudwatch');
const { ECSClient, DescribeServicesCommand } = require('@aws-sdk/client-ecs');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const {
  SSMClient,
  GetAutomationExecutionCommand,
  GetParameterCommand,
  PutParameterCommand,
} = require('@aws-sdk/client-ssm');

const cloudwatch = new CloudWatchClient({ region: process.env.AWS_REGION });
const ecs = new ECSClient({ region: process.env.AWS_REGION });
const rds = new RDSClient({ region: process.env.AWS_REGION });
const sns = new SNSClient({ region: process.env.AWS_REGION });
const ssm = new SSMClient({ region: process.env.AWS_REGION });

const NAMESPACE = process.env.NAMESPACE;
const ENV_NAME = process.env.ENV_NAME;
const TOPIC_ARN = process.env.TOPIC_ARN;
const TARGET = process.env.TARGET;
const DB_INSTANCE_IDENTIFIER = process.env.DB_INSTANCE_IDENTIFIER;
const CLUSTER_NAME = process.env.CLUSTER_NAME;
const SERVICE_NAME = process.env.SERVICE_NAME;
const SAMPLE_INTERVAL_SECONDS = Number(process.env.SAMPLE_INTERVAL_SECONDS);
const MAX_RESOLUTION_SECONDS = Number(process.env.MAX_RESOLUTION_SECONDS);
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

const probeDimensions = [
  { Name: 'Environment', Value: ENV_NAME },
  { Name: 'Target', Value: TARGET },
];

/* ── The RTO arithmetic. Pinned to measureRto() by the tests. ─────────────── */

const secondsBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / 1000);

const deriveRto = (datapoints, maxResolutionSeconds) => {
  const inWindow = datapoints.slice().sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  if (inWindow.length === 0) return { conclusive: false, reason: 'no-datapoints' };

  const firstFailureIndex = inWindow.findIndex((d) => d.connectSuccess < 1);
  if (firstFailureIndex === -1) return { conclusive: false, reason: 'no-outage-observed' };
  if (firstFailureIndex === 0) return { conclusive: false, reason: 'outage-began-before-window' };

  const outageStartedAt = inWindow[firstFailureIndex].timestamp;
  const lastHealthyAt = inWindow[firstFailureIndex - 1].timestamp;

  const recoveryIndex = inWindow.findIndex((d, index) => index > firstFailureIndex && d.connectSuccess >= 1);
  if (recoveryIndex === -1) {
    return {
      conclusive: false,
      reason: 'outage-unresolved-in-window',
      atLeastSeconds: secondsBetween(outageStartedAt, inWindow[inWindow.length - 1].timestamp),
    };
  }

  let resolutionSeconds = 0;
  for (let index = firstFailureIndex; index <= recoveryIndex; index += 1) {
    const gap = secondsBetween(inWindow[index - 1].timestamp, inWindow[index].timestamp);
    resolutionSeconds = Math.max(resolutionSeconds, gap);
  }
  if (resolutionSeconds > maxResolutionSeconds) {
    return { conclusive: false, reason: 'datapoint-gap-across-outage' };
  }

  return {
    conclusive: true,
    lastHealthyAt,
    outageStartedAt,
    recoveredAt: inWindow[recoveryIndex].timestamp,
    rtoSeconds: secondsBetween(outageStartedAt, inWindow[recoveryIndex].timestamp),
    resolutionSeconds,
    failedDatapoints: recoveryIndex - firstFailureIndex,
  };
};

const verdictFor = (rtoObjectiveSeconds, measurement) => {
  if (measurement.rtoSeconds <= rtoObjectiveSeconds) return 'met';
  if (measurement.rtoSeconds - rtoObjectiveSeconds <= measurement.resolutionSeconds) {
    return 'within-measurement-error';
  }
  return 'missed';
};

/* ── Reads ────────────────────────────────────────────────────────────────── */

const seriesFor = (result, id) => {
  const series = (result.MetricDataResults || []).find((candidate) => candidate.Id === id);
  const timestamps = (series && series.Timestamps) || [];
  const values = (series && series.Values) || [];
  return timestamps.map((timestamp, index) => ({
    timestamp: new Date(timestamp),
    value: values[index],
  }));
};

const readProbeWindow = async (startTime, endTime) => {
  const result = await cloudwatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: [
        {
          Id: 'connect',
          MetricStat: {
            Metric: { Namespace: NAMESPACE, MetricName: 'ConnectSuccess', Dimensions: probeDimensions },
            Period: SAMPLE_INTERVAL_SECONDS,
            // Minimum, not Average: one failure inside a period is an outage,
            // and an average over a period holding one failure and one success
            // is 0.5, which is neither.
            Stat: 'Minimum',
          },
        },
        {
          Id: 'changed',
          MetricStat: {
            Metric: {
              Namespace: NAMESPACE,
              MetricName: 'EndpointAddressChanged',
              Dimensions: probeDimensions,
            },
            Period: SAMPLE_INTERVAL_SECONDS,
            Stat: 'Sum',
          },
        },
      ],
    }),
  );
  return {
    connect: seriesFor(result, 'connect').map((point) => ({
      timestamp: point.timestamp,
      connectSuccess: point.value,
    })),
    addressChanged: seriesFor(result, 'changed').some((point) => point.value > 0),
  };
};

const readRestorePointLag = async (now) => {
  const described = await rds.send(
    new DescribeDBInstancesCommand({ DBInstanceIdentifier: DB_INSTANCE_IDENTIFIER }),
  );
  const instance = (described.DBInstances || [])[0] || {};
  if (!instance.LatestRestorableTime) return undefined;
  const lag = Math.round((now.getTime() - new Date(instance.LatestRestorableTime).getTime()) / 1000);
  return lag < 0 ? undefined : lag;
};

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

/* ── Preflight ────────────────────────────────────────────────────────────── */

const preflightProbeReporting = async (now) => {
  const lookbackMinutes = 10;
  // Six samples a minute, so ten minutes is sixty datapoints when everything is
  // working. Half of that is the floor: a probe missing the odd sample is normal
  // and a probe that has stopped is not, and the gap between those two is wide
  // enough that a threshold anywhere in it does the job.
  const expected = lookbackMinutes * (60 / SAMPLE_INTERVAL_SECONDS);
  const window = await readProbeWindow(new Date(now.getTime() - lookbackMinutes * 60000), now);
  if (window.connect.length < expected / 2) {
    throw new Error(
      'probe-reporting: only ' + window.connect.length + ' of about ' + expected + ' expected ' +
        'ConnectSuccess datapoints in the last ' + lookbackMinutes + ' minutes. The measurement ' +
        'window would have holes in it, and a hole is not a fast recovery.',
    );
  }
  if (window.connect.some((point) => point.connectSuccess < 1)) {
    throw new Error(
      'probe-reporting: the probe is already failing. An outage that started before the fault ' +
        'was injected cannot be attributed to it, and the measurement would be a lower bound ' +
        'presented as a number.',
    );
  }
};

const preflightNoAlarmInAlarmState = async () => {
  const result = await cloudwatch.send(
    new DescribeAlarmsCommand({ AlarmNamePrefix: ENV_NAME + '-', StateValue: 'ALARM', MaxRecords: 100 }),
  );
  const firing = [
    ...(result.MetricAlarms || []).map((alarm) => alarm.AlarmName),
    ...(result.CompositeAlarms || []).map((alarm) => alarm.AlarmName),
  ];
  if (firing.length > 0) {
    throw new Error(
      'no-alarm-in-alarm-state: ' + firing.join(', ') + ' already in ALARM. A game day during ' +
        'an incident is not a game day.',
    );
  }
};

const preflightNoDeploymentInProgress = async () => {
  const result = await ecs.send(
    new DescribeServicesCommand({ cluster: CLUSTER_NAME, services: [SERVICE_NAME] }),
  );
  const service = (result.services || [])[0];
  // A falsy check rather than \`=== undefined\`: DescribeServices returns an
  // empty list for a service that is not there, and a failure not in the list
  // shows up in \`failures\` instead. Either way there is nothing to check, and a
  // preflight that cannot be made is not one that passed.
  if (!service) {
    throw new Error(
      'no-deployment-in-progress: ' + CLUSTER_NAME + '/' + SERVICE_NAME + ' was not found. The ' +
        'check cannot be made, and a preflight that cannot be made is not one that passed.',
    );
  }
  const inFlight = (service.deployments || []).filter(
    (deployment) => deployment.rolloutState === 'IN_PROGRESS',
  );
  if (inFlight.length > 0 || service.runningCount !== service.desiredCount) {
    throw new Error(
      'no-deployment-in-progress: ' + inFlight.length + ' deployment(s) in progress, ' +
        service.runningCount + '/' + service.desiredCount + ' tasks running. Two changes at ' +
        'once means the exercise measures both and reports one.',
    );
  }
};

const PREFLIGHTS = {
  'probe-reporting': preflightProbeReporting,
  'no-alarm-in-alarm-state': preflightNoAlarmInAlarmState,
  'no-deployment-in-progress': preflightNoDeploymentInProgress,
  // Asserted in the document itself by aws:assertAwsResourceProperty, where it
  // is visible without reading a Lambda. A no-op here so that a scenario listing
  // it does not fail as unimplemented.
  'multi-az-enabled': async () => undefined,
};

/* ── Operations ───────────────────────────────────────────────────────────── */

const preflight = async (scenario, now) => {
  const checksPassed = [];
  for (const check of scenario.preflight) {
    const implementation = PREFLIGHTS[check];
    if (implementation === undefined) {
      throw new Error(
        'preflight ' + check + ' is not implemented here. lib/game-days.ts refuses an unknown ' +
          'check, so this means the two were deployed from different revisions.',
      );
    }
    await implementation(now);
    checksPassed.push(check);
  }
  return {
    operation: 'preflight',
    scenarioId: scenario.id,
    // The window the measurement is bounded by. Taken after the checks, so a
    // slow preflight does not widen it and pick up an earlier outage.
    startedAt: new Date().toISOString(),
    checksPassed,
  };
};

const measure = async (scenario, event, now) => {
  const windowStart = new Date(event.windowStart);
  if (Number.isNaN(windowStart.getTime())) {
    throw new Error('measure: windowStart ' + event.windowStart + ' is not a timestamp.');
  }

  const window = await readProbeWindow(windowStart, now);
  const measurement = deriveRto(window.connect, MAX_RESOLUTION_SECONDS);
  const restorePointLagSeconds = await readRestorePointLag(now);

  if (!measurement.conclusive) {
    // Thrown rather than recorded as a measurement: the step fails, the
    // automation routes to recordAbort, and the record says 'inconclusive' with
    // this reason on it. Returning a number here is the single most tempting
    // mistake in this whole item.
    const detail =
      measurement.reason === 'outage-unresolved-in-window'
        ? ' The probe has been failing for at least ' + measurement.atLeastSeconds + 's, which is ' +
          'past the objective — this is now an incident, not an exercise.'
        : '';
    throw new Error('measure: ' + measurement.reason + '.' + detail);
  }

  const verdict = verdictFor(scenario.rtoSeconds, measurement);
  const record = {
    objectiveId: scenario.objectiveId,
    scenarioId: scenario.id,
    startedAt: windowStart.toISOString(),
    completedAt: now.toISOString(),
    outcome: 'measured',
    measuredRtoSeconds: measurement.rtoSeconds,
    resolutionSeconds: measurement.resolutionSeconds,
    endpointAddressChanged: window.addressChanged,
    restorePointLagSeconds,
    executionId: event.executionId,
  };

  await writeRecord(scenario, record);
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: NAMESPACE,
      MetricData: [
        {
          MetricName: 'MeasuredRtoSeconds',
          Value: measurement.rtoSeconds,
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

  // An RTO that met the objective while the endpoint never moved is the result
  // worth shouting about, because it is not a result: the instance rebooted and
  // nothing was promoted, so the number describes the wrong event. The
  // assertMultiAz step should have made it impossible; this says so if it
  // happens anyway.
  const caveat = window.addressChanged
    ? ''
    : ' WARNING: the endpoint address never changed, so no promotion was observed — this ' +
      'measures a reboot, not a failover.';

  const message =
    ENV_NAME + ' ' + scenario.title + '\\n\\n' +
    'Measured RTO: ' + measurement.rtoSeconds + 's (+/-' + measurement.resolutionSeconds + 's)\\n' +
    'Objective: ' + scenario.rtoSeconds + 's — ' + verdict + '\\n' +
    'Outage: ' + measurement.outageStartedAt.toISOString() + ' to ' +
    measurement.recoveredAt.toISOString() + ' (' + measurement.failedDatapoints + ' failing probe(s))\\n' +
    'Endpoint address changed: ' + window.addressChanged + '\\n' +
    'Restore-point lag at measurement: ' +
    (restorePointLagSeconds === undefined ? 'unreadable' : restorePointLagSeconds + 's') + '\\n' +
    'Execution: ' + event.executionId + caveat;

  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject(ENV_NAME + ' game day: RTO ' + measurement.rtoSeconds + 's, ' + verdict),
      Message: message,
    }),
  );

  const summary = { operation: 'measure', outcome: 'measured', verdict, ...record };
  console.log(JSON.stringify(summary));
  return { ...summary, measuredRtoSeconds: String(measurement.rtoSeconds) };
};

/**
 * Which step failed, and what it said.
 *
 * The execution is still running when this is called -- recordAbort is a step
 * inside it — so the failed step is already in the history. Best effort: a
 * record that says "aborted, reason unavailable" is worth more than an abort
 * step that threw while trying to explain itself, which would leave no record
 * at all.
 */
const failureNote = async (executionId) => {
  try {
    const result = await ssm.send(new GetAutomationExecutionCommand({ AutomationExecutionId: executionId }));
    const steps = (result.AutomationExecution && result.AutomationExecution.StepExecutions) || [];
    const failed = steps.filter((step) => step.StepStatus === 'Failed' || step.StepStatus === 'TimedOut');
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
  const note =
    (typeof event.note === 'string' && event.note.trim() ? event.note : undefined) ??
    (await failureNote(event.executionId)) ??
    'no reason recorded';
  const record = {
    objectiveId: scenario.objectiveId,
    scenarioId: scenario.id,
    startedAt: typeof event.windowStart === 'string' ? event.windowStart : now.toISOString(),
    completedAt: now.toISOString(),
    outcome: 'aborted',
    note,
    executionId: event.executionId,
  };
  await writeRecord(scenario, record);
  await sns.send(
    new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: subject(ENV_NAME + ' game day aborted: ' + scenario.id),
      Message:
        ENV_NAME + ' ' + scenario.title + ' did not complete.\\n\\n' +
        'Reason: ' + note + '\\n' +
        'Execution: ' + event.executionId + '\\n\\n' +
        'The rehearsal clock has not been reset — lastMeasured is untouched, so the objective ' +
        'stays as overdue as it was. Read the execution for the step that failed; a preflight ' +
        'refusing is the expected outcome when something else is going on.',
    }),
  );
  const summary = { operation: 'abort', outcome: 'aborted', ...record };
  console.log(JSON.stringify(summary));
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
    case 'abort':
      return abort(scenario, event, now);
    default:
      throw new Error('Unknown operation ' + event.operation + '.');
  }
};
`;
