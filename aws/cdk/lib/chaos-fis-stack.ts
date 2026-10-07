import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fis from 'aws-cdk-lib/aws-fis';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {
  type ChaosExperiment,
  CHAOS_EXPERIMENTS,
  FIS_ACTIONS,
  LOG_SCHEMA_VERSION,
  STOP_CONDITION_SOURCE_ALARM,
  assertValidChaosCatalogue,
  experimentLogGroupName,
  experimentTemplateName,
  experimentsFor,
} from './fis-experiments';

/**
 * AWS FIS experiment templates for the three faults in `lib/fis-experiments.ts`,
 * with the guardrails that make them experiments.
 *
 * The catalogue decides what is run and holds the arithmetic; this stack is the
 * deployment of it, and the two things it owns that the catalogue cannot are the
 * **role** and the **record**.
 *
 * **The role is the blast radius.** An FIS experiment template names a role FIS
 * assumes, and whatever that role can do is what a started experiment can do.
 * AWS publishes managed policies for exactly this — `AWSFaultInjectionSimulator
 * NetworkAccess`, `...ECSAccess` — and they are what every tutorial attaches.
 * They are also account-wide: `AWSFaultInjectionSimulatorECSAccess` permits
 * `ecs:StopTask` against every task in the account, so an experiment template
 * whose target selection somebody widens in the console can reach a cluster
 * nobody intended to include. So the policies here are written out, scoped to
 * this environment's own cluster and this VPC's own subnets, and the gate in
 * `tools/audit-iam-least-privilege.ts` holds them to it. The two statements that
 * genuinely cannot name a resource — creating a network ACL that does not exist
 * yet, and tagging it — are conditioned instead, on `ec2:CreateAction` and on
 * FIS's own `managedByFIS` request tag, which is the same shape AWS's managed
 * policy uses and is the reason those two are not simply `Resource: "*"`.
 *
 * **The record is what makes the experiment reviewable.** `logConfiguration` is
 * optional in FIS: an experiment with none runs identically and writes nothing,
 * and what is lost is not the timeline — the console keeps that — but *which
 * targets resolved*. "One task was stopped" and "the task in us-east-1a was
 * stopped, and the replacement landed in us-east-1b" are the same experiment and
 * different findings, and only one of them is a conclusion about the AZ layout.
 * The log group is encrypted with a key this stack owns, because the repository
 * holds new log groups to that (`.checkov.baseline` records the ones that
 * predate the rule and this is not one of them).
 *
 * What this stack deliberately does **not** do is start anything. There is no
 * EventBridge rule here, and that is the same line `lib/game-days.ts` draws for a
 * destructive fault: a `aws:ecs:stop-task` experiment on a cron is an outage
 * nobody chose, arriving at the traffic peak because that is when the cron fired.
 * The templates are inert until a human calls `StartExperiment`, and the
 * `docs/chaos-engineering.md` section for each one is what they read first.
 *
 * See docs/chaos-engineering.md.
 */
export interface ChaosFisStackProps extends cdk.StackProps {
  /** Environment name. Decides which experiments are built here. */
  readonly envName: string;
  /** VPC whose subnets the availability-zone experiment partitions. */
  readonly vpc: ec2.IVpc;
  /** Cluster and service whose tasks the instance and latency experiments target. */
  readonly service: { readonly clusterName: string; readonly serviceName: string };
  /**
   * Alarms the experiments stop on, keyed by the catalogue's `alarmName`.
   *
   * Passed in rather than created here, and that is the point: these are the
   * alarms the rest of the repository already pages on. An alarm created in this
   * stack purely to be a stop condition would be one whose thresholds nobody
   * tunes and whose silence nobody notices — a guardrail with no other reason to
   * be correct. `CloudWatchAlarmsStack` and `FailoverGameDayStack` own these, so
   * a threshold edited there moves the guardrail with it.
   *
   * A catalogue entry naming an alarm that is not in this map is a synth-time
   * error rather than a template with one fewer stop condition than it claims.
   */
  readonly stopConditionAlarms: Readonly<Record<string, cloudwatch.IAlarm>>;
  /** Override the catalogue. Tests only. */
  readonly experiments?: readonly ChaosExperiment[];
  /** Retention for the experiment log group (default: six months). */
  readonly logRetention?: logs.RetentionDays;
}

export class ChaosFisStack extends cdk.Stack {
  /** Experiment templates built here, keyed by experiment id. */
  public readonly experimentTemplates: Record<string, fis.CfnExperimentTemplate>;
  /** Role FIS assumes. One per stack, with a statement per fault kind. */
  public readonly experimentRole: iam.Role;
  /** Target resolution and timeline for every experiment run here. */
  public readonly logGroup: logs.LogGroup;
  /** Encrypts the log group. */
  public readonly encryptionKey: kms.Key;

  constructor(scope: Construct, id: string, props: ChaosFisStackProps) {
    super(scope, id, props);

    const envName = props.envName;
    const isProduction = envName === 'production';
    const catalogue = props.experiments ?? CHAOS_EXPERIMENTS;

    // Synth fails on a bad catalogue rather than deploying one. Every rule in
    // here is offline arithmetic, so there is no reason for it to be discovered
    // later than this.
    assertValidChaosCatalogue(catalogue);

    const experiments = experimentsFor(envName, catalogue);

    // ── The record ────────────────────────────────────────────────────────────

    this.encryptionKey = new kms.Key(this, 'ChaosLogKey', {
      alias: `alias/${envName}-chaos-experiments`,
      description: `Encrypts the ${envName} FIS experiment log group`,
      enableKeyRotation: true,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch Logs encrypts with a key it can use, and `LogGroup`'s
    // `encryptionKey` prop does not add this grant: without it the log group
    // fails to create with `InvalidParameterException`, at deploy time. The
    // condition is what keeps it from being "this service, for anything in the
    // account" — the same statement `LogPipelineStack` carries, for the same
    // reason.
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    this.logGroup = new logs.LogGroup(this, 'ChaosExperimentLogs', {
      logGroupName: experimentLogGroupName(envName),
      encryptionKey: this.encryptionKey,
      // Six months. An experiment's value is mostly in the comparison with the
      // last time it ran, and the AZ experiment's own cadence is measured in
      // months — a retention shorter than the gap between runs means every run
      // is the first one.
      retention: props.logRetention ?? logs.RetentionDays.SIX_MONTHS,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // ── The role ──────────────────────────────────────────────────────────────

    this.experimentRole = new iam.Role(this, 'ExperimentRole', {
      roleName: `${envName}-chaos-experiment`,
      assumedBy: new iam.ServicePrincipal('fis.amazonaws.com'),
      description: `Role AWS FIS assumes to inject the ${envName} chaos experiments`,
    });

    const clusterArn = `arn:${this.partition}:ecs:${this.region}:${this.account}:cluster/${props.service.clusterName}`;
    const taskArnPattern = `arn:${this.partition}:ecs:${this.region}:${this.account}:task/${props.service.clusterName}/*`;

    // FIS resolves the target set itself before it injects anything, so the role
    // needs the read half as well as the write half — and `ecs:ListTasks` and
    // `ecs:DescribeTasks` take the cluster, not the task, which is why this
    // statement's resource is the cluster ARN rather than the task pattern.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ResolveEcsTaskTargets',
        actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
        resources: [clusterArn],
      }),
    );

    // `ecs:StopTask` scoped to this cluster's tasks. The managed policy AWS
    // publishes for this grants it on `"*"`, which is every task in the account:
    // the experiment template's target selection is then the only thing standing
    // between this role and another team's cluster, and target selection is
    // editable in the console by anyone who can reach the template.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StopEcsTasksInThisCluster',
        actions: ['ecs:StopTask'],
        resources: [taskArnPattern],
      }),
    );

    // The latency action stops nothing — it runs inside the task, and FIS has
    // to read the task definition to establish that it may: `PidMode` and
    // `EnableFaultInjection` are properties of the definition, not of the task.
    //
    // Scoped to this account and region's task definitions rather than `"*"`.
    // A task definition's response carries its containers' environment
    // variables, so an unscoped read here is a read of every service's
    // configuration in the account — and the revision in the ARN is not
    // knowable from this stack, which is the only reason the resource is a
    // pattern at all.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTargetedTaskDefinitions',
        actions: ['ecs:DescribeTaskDefinition'],
        resources: [`arn:${this.partition}:ecs:${this.region}:${this.account}:task-definition/*`],
      }),
    );

    // Deliberately absent: `ssm:SendCommand` on AWS's `AWSFIS-Run-*` documents.
    //
    // There are two ways FIS reaches inside an ECS task. The older one registers
    // the task as an SSM managed instance through an SSM-agent sidecar and runs
    // a document against it; the newer one goes through the ECS
    // fault-injection endpoints, which is what the three `aws:ecs:task-network-*`
    // actions use on Fargate and what `useEcsFaultInjectionEndpoints: 'true'`
    // selects. This repository's task definition has no SSM-agent sidecar, so
    // the SSM path could not work here even if the role permitted it — and
    // granting it anyway would be `ssm:SendCommand` against every managed
    // instance in the account, in exchange for a capability nothing uses.
    //
    // A future experiment on one of the other `aws:ecs:task` actions —
    // `task-cpu-stress`, `task-io-stress`, `task-kill-process` — needs both
    // halves: the sidecar in `EcsStack` and the grant here. It is a deliberate
    // addition, not an oversight.

    // The AZ experiment. `aws:network:disrupt-connectivity` works by creating a
    // deny-all network ACL and re-associating the target subnets with it for the
    // duration, then putting the original association back — which is why the
    // role needs create and delete on an ACL rather than a modify on an existing
    // one, and why the create cannot name a resource that does not exist yet.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ResolveSubnetTargets',
        actions: [
          'ec2:DescribeSubnets',
          'ec2:DescribeVpcs',
          'ec2:DescribeNetworkAcls',
          'ec2:DescribeRouteTables',
        ],
        resources: ['*'],
        // Describes, which take no resource in IAM's model. Same documented
        // wildcard as above: they read the VPC layout FIS has to resolve the
        // target against.
      }),
    );
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CreateFisManagedNetworkAcl',
        actions: ['ec2:CreateNetworkAcl'],
        resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:network-acl/*`],
        // The ACL is created by this call, so there is no ARN to name — the
        // condition is what scopes it instead, to a create that tags the new ACL
        // as FIS's own. Without it this is "create any network ACL in the
        // account", which is a resource a deny-all rule can be attached to and
        // then associated with a subnet nobody is experimenting on.
        conditions: {
          StringEquals: { 'aws:RequestTag/managedByFIS': 'true' },
        },
      }),
    );
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'TagFisManagedNetworkAcl',
        actions: ['ec2:CreateTags'],
        resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:network-acl/*`],
        // `ec2:CreateTags` is a privileged action in this repository's own audit
        // because tags decide what other policies apply. The condition narrows
        // it to the tagging that happens as part of creating the ACL above —
        // not to re-tagging something that already exists.
        conditions: {
          StringEquals: { 'ec2:CreateAction': 'CreateNetworkAcl' },
        },
      }),
    );
    // Writing the deny-all rules into FIS's own ACL, and deleting it afterwards.
    // Both are scoped by the tag FIS put on the ACL it created, so this role can
    // write rules into and tear down its own ACL and not the VPC's.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'RuleAndCleanUpFisManagedNetworkAcl',
        actions: ['ec2:CreateNetworkAclEntry', 'ec2:DeleteNetworkAcl'],
        resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:network-acl/*`],
        conditions: {
          StringEquals: { 'ec2:ResourceTag/managedByFIS': 'true' },
        },
      }),
    );

    // `ec2:ReplaceNetworkAclAssociation` is deliberately *not* tag-conditioned,
    // and the asymmetry is the most considered line in this stack.
    //
    // This is the call that both starts and **ends** the fault: FIS points the
    // subnets at its deny-all ACL, and at the end of the duration it points them
    // back. The two directions do not see the same tags — the ACL being
    // associated on the way out is the VPC's original, which carries no
    // `managedByFIS` tag, and the subnet never carries one either. A tag
    // condition here is therefore a condition that can fail on the *rollback*,
    // and a failed rollback is not a failed experiment: it is one AZ of the VPC
    // left behind a deny-all ACL until somebody re-associates it by hand, which
    // is the single worst outcome anything in this stack can produce. Scoping it
    // to a condition this stack cannot prove holds would be trading a small,
    // bounded privilege for that.
    //
    // What the privilege actually is, bounded: re-point a subnet in this account
    // and region at an ACL that already exists. It adds nothing this role cannot
    // already do — it can create a deny-all ACL (under the tag condition above)
    // and associate it — and the role is assumable only by `fis.amazonaws.com`.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'SwapNetworkAclAssociationBothWays',
        actions: ['ec2:ReplaceNetworkAclAssociation'],
        resources: [
          `arn:${this.partition}:ec2:${this.region}:${this.account}:network-acl/*`,
          `arn:${this.partition}:ec2:${this.region}:${this.account}:subnet/*`,
        ],
      }),
    );

    // Experiment logs. `logs:CreateLogDelivery` takes no resource; the log group
    // half is scoped to the one group this stack created.
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'DeliverExperimentLogs',
        actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:ListLogDeliveries'],
        resources: ['*'],
        // Log-delivery calls are account-level in IAM's model and name no
        // resource. The destination is scoped by the statement below.
      }),
    );
    this.experimentRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteExperimentLogs',
        actions: ['logs:PutLogEvents', 'logs:CreateLogStream', 'logs:DescribeLogStreams'],
        resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:*`],
      }),
    );
    this.encryptionKey.grantEncryptDecrypt(this.experimentRole);

    // ── The templates ─────────────────────────────────────────────────────────

    this.experimentTemplates = {};

    for (const experiment of experiments) {
      const action = FIS_ACTIONS[experiment.action];
      const templateName = experimentTemplateName(envName, experiment.id);

      const stopConditions = experiment.stopConditions.map((alarm) => {
        const resolved = props.stopConditionAlarms[alarm.alarmName];
        if (resolved === undefined) {
          throw new Error(
            `Experiment '${experiment.id}' stops on '${alarm.alarmName}', which ` +
              `${id} was not given. Known: ${Object.keys(props.stopConditionAlarms).join(', ') || '(none)'}. ` +
              'A missing alarm must fail synth rather than deploy a template with one fewer ' +
              'guardrail than the catalogue says it has — the template would look identical in ' +
              'the console to one that was never meant to have it.',
          );
        }
        return { source: STOP_CONDITION_SOURCE_ALARM, value: resolved.alarmArn };
      });

      const target = this.targetFor(experiment, props);
      const parameters = this.parametersFor(experiment);

      const template = new fis.CfnExperimentTemplate(this, `Experiment${pascal(experiment.id)}`, {
        description:
          `${experiment.title} (${envName}). ${experiment.summary} ` +
          `Hypothesis: ${experiment.hypothesis} Runbook: docs/chaos-engineering.md${experiment.anchor}`,
        roleArn: this.experimentRole.roleArn,
        stopConditions,
        targets: { [targetName(experiment)]: target },
        actions: {
          [experiment.faultKind]: {
            actionId: action.actionId,
            description: `${experiment.faultKind} fault: ${experiment.title}`,
            // Omitted rather than `{}` where the action takes none —
            // `aws:ecs:stop-task` has no parameters, and an empty map in the
            // template reads as "parameters that were cleared" rather than as
            // "an action that does not take any".
            ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
            targets: { [action.targetKey]: targetName(experiment) },
          },
        },
        logConfiguration: {
          logSchemaVersion: LOG_SCHEMA_VERSION,
          cloudWatchLogsConfiguration: { logGroupArn: this.logGroup.logGroupArn },
        },
        // `AWS::FIS::ExperimentTemplate` has no name property, and the console
        // lists templates by this tag. A template without it is a blank row
        // somebody has to open to identify, which is how the wrong one gets
        // started.
        tags: {
          Name: templateName,
          Environment: envName,
          ManagedBy: 'CDK',
          Stack: id,
          Experiment: experiment.id,
          FaultKind: experiment.faultKind,
        },
      });

      this.experimentTemplates[experiment.id] = template;

      new cdk.CfnOutput(this, `Experiment${pascal(experiment.id)}Id`, {
        value: template.ref,
        description: `${templateName} — start with: aws fis start-experiment --experiment-template-id`,
        exportName: `${envName}-chaos-${experiment.id}-template-id`,
      });
    }

    new cdk.CfnOutput(this, 'ChaosExperimentLogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'Target resolution and timeline for every experiment started here',
      exportName: `${envName}-chaos-experiment-logs`,
    });

    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);
  }

  /**
   * The target definition for one experiment.
   *
   * ECS task targets are selected by cluster and service *parameters* rather
   * than by tag, which matters: a tag-selected target resolves against whatever
   * carries the tag at the moment the experiment starts, and the tags on a task
   * come from the task definition, so a second service sharing a task definition
   * joins the target set with no change to the experiment. Naming the service is
   * the narrower statement and it is the one the hypothesis was written about.
   *
   * Subnet targets are selected by ARN, one per AZ. Two things make that the
   * right shape rather than a `resourceTags` selector. The VPC has three subnet
   * groups per AZ — public, private and isolated — and an AZ fault that
   * partitions only the private subnets leaves the load balancer node in that AZ
   * reachable and still advertised in DNS, which is a partition of the
   * application from its database rather than of one AZ from the others. And
   * FIS's `COUNT(1)` over a tag-selected set of six subnets would pick *one
   * subnet*, not one AZ.
   */
  private targetFor(
    experiment: ChaosExperiment,
    props: ChaosFisStackProps,
  ): fis.CfnExperimentTemplate.ExperimentTemplateTargetProperty {
    const action = FIS_ACTIONS[experiment.action];

    if (action.resourceType === 'aws:ecs:task') {
      return {
        resourceType: action.resourceType,
        selectionMode: experiment.selectionMode,
        parameters: {
          cluster: props.service.clusterName,
          service: props.service.serviceName,
        },
      };
    }

    // The AZ to partition is decided here, at synth time, and written into the
    // template as a list of subnet ARNs. Two alternatives were rejected.
    //
    // `resourceTags` plus `selectionMode: COUNT(1)` is the shape most examples
    // use, and it selects *one subnet*: FIS counts resources, and the resource
    // type is a subnet. This VPC has three subnet groups per AZ — public,
    // private and isolated — so a template that reads as "one Availability
    // Zone" partitions a sixth of the VPC, and which sixth is whatever FIS
    // picked that run. An experiment whose blast radius changes between runs
    // cannot be compared with its own last result, which is the only thing an
    // experiment is for.
    //
    // A `filters` entry on the AZ would express it in one line, and it moves
    // the choice of AZ from the reviewed template to resolution time. Which AZ
    // was partitioned is the first question the write-up answers, and the second
    // is whether the database's writer was in it — neither is answerable from a
    // template that says "some AZ".
    //
    // So: the first AZ the VPC was given, every subnet in it, `ALL` of them.
    const targetAz = props.vpc.availabilityZones[0];
    const subnetsInTargetAz = [
      ...props.vpc.publicSubnets,
      ...props.vpc.privateSubnets,
      ...props.vpc.isolatedSubnets,
    ].filter((subnet) => subnet.availabilityZone === targetAz);

    if (subnetsInTargetAz.length === 0) {
      throw new Error(
        `No subnets found in ${targetAz} for the availability-zone experiment. A template whose ` +
          'target resolves to nothing starts, injects nothing and succeeds, which reads in the ' +
          'console exactly like an AZ this application tolerated losing.',
      );
    }

    return {
      resourceType: action.resourceType,
      // `ALL` of the subnets named below — which is one AZ, completely. The
      // partition is of an Availability Zone from the others, and leaving one of
      // its subnet groups connected is a different experiment: with the public
      // subnet still reachable, the load balancer node in that AZ stays
      // advertised in DNS and keeps accepting requests it can no longer serve.
      selectionMode: 'ALL',
      resourceArns: subnetsInTargetAz.map(
        (subnet) =>
          `arn:${this.partition}:ec2:${this.region}:${this.account}:subnet/${subnet.subnetId}`,
      ),
    };
  }

  /** Action parameters, which are all strings in CloudFormation. */
  private parametersFor(experiment: ChaosExperiment): Record<string, string> {
    switch (experiment.faultKind) {
      case 'instance':
        // `aws:ecs:stop-task` takes none: the fault is the call.
        return {};

      case 'latency':
        return {
          duration: experiment.duration,
          delayMilliseconds: String(experiment.delayMilliseconds),
          // The flag without which this action cannot run on Fargate at all.
          // The task definition half of the same requirement —
          // `pidMode: task` and `EnableFaultInjection: true` — lives in
          // `EcsStack`, and `tools/audit-fis-experiments.ts` is what keeps the
          // two in step: every combination of the three deploys cleanly and the
          // failure surfaces only when somebody starts the experiment.
          useEcsFaultInjectionEndpoints: 'true',
        };

      case 'availability-zone':
        return {
          duration: experiment.duration,
          // Validated by the catalogue, which refuses the scopes that are
          // dependency-isolation experiments rather than AZ faults.
          scope: String(experiment.disruptScope),
        };
    }
  }
}

/** `ecs-task-loss` → `EcsTaskLoss`, for construct ids. */
const pascal = (id: string): string =>
  id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

/**
 * Name of the target definition inside the template.
 *
 * Mirrors the `<TargetKey>-Target-1` convention the FIS console generates, so a
 * template built here reads the same as one somebody made by hand.
 */
const targetName = (experiment: ChaosExperiment): string =>
  `${FIS_ACTIONS[experiment.action].targetKey}-Target-1`;
