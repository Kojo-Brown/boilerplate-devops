import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  RUNBOOK_CATALOGUE,
  RUNBOOK_DOC_BASE_URL,
  RunbookDefinition,
  assertValidRunbookCatalogue,
  firstStepDocumentName,
  requiredDocumentKeys,
  runbookUrl,
} from './runbooks';

/**
 * Suffix of the topic the enriched alerts are published to: `<env>-runbook-alerts`.
 *
 * Restated in `tools/audit-runbooks.ts` as the one topic an alarm may notify
 * without an enricher behind it — see {@link RunbookStack} on why the enricher's
 * own failure alarm has to go somewhere the enricher is not.
 */
export const ENRICHED_TOPIC_SUFFIX = 'runbook-alerts';

/** The ECS service a saturation or 5xx alarm is about. */
export interface RunbookServiceTarget {
  readonly clusterName: string;
  readonly serviceName: string;
}

export interface RunbookStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and in the alert. */
  readonly envName: string;
  /**
   * Alarm topics whose notifications are enriched.
   *
   * Every topic an alarm in this environment notifies belongs here, or in
   * `ENRICHMENT_EXEMPTIONS` with a reason. `tools/audit-runbooks.ts` holds the
   * two lists against the synthesised templates, because a topic nobody
   * subscribed the enricher to is invisible: the alarm still fires, still
   * arrives, and simply has no runbook on it.
   */
  readonly alarmTopics: readonly sns.ITopic[];
  /** Filled into the `ecs-service-state` document's defaults. */
  readonly service: RunbookServiceTarget;
  /** Filled into the `rds-instance-state` document's default. */
  readonly databaseInstanceIdentifier: string;
  /** Filled into the `log-delivery-state` document's default. */
  readonly logDeliveryStreamName: string;
  /** Emails subscribed to the enriched topic. */
  readonly notificationEmails?: readonly string[];
  /** Override the catalogue. Tests only. */
  readonly catalogue?: readonly RunbookDefinition[];
  /** Base URL the runbook links are built from (default {@link RUNBOOK_DOC_BASE_URL}). */
  readonly docBaseUrl?: string;
  /** Enricher timeout in seconds (default: 30). */
  readonly lambdaTimeoutSeconds?: number;
}

/** One `aws:executeAwsApi` parameter of a first-step document. */
interface DocumentParameter {
  readonly name: string;
  readonly description: string;
  /** Omitted for the parameters the enricher fills from the alarm. */
  readonly defaultValue?: string;
}

interface DocumentSpec {
  readonly key: string;
  readonly description: string;
  /** IAM service prefix, e.g. `ecs`. */
  readonly iamService: string;
  /** SSM `Service` input, which is the SDK client name — usually the same. */
  readonly apiService: string;
  /** SDK operation, e.g. `DescribeServices`. Must be a read. */
  readonly api: string;
  /** IAM actions the automation role needs for this step. */
  readonly iamActions: readonly string[];
  readonly parameters: readonly DocumentParameter[];
  /** Inputs passed to the API, `{{ Parameter }}` references included. */
  readonly apiInputs: Record<string, unknown>;
  /** Declared step outputs: what the responder reads off the execution. */
  readonly outputs: readonly { readonly name: string; readonly selector: string; readonly type: string }[];
}

/**
 * Runbook automation: the alert carries the runbook, and the runbook's first
 * step has already run by the time anybody opens it.
 *
 * ## What was wrong with the link
 *
 * Before this stack the SLO alarms carried
 * `Runbook: …/docs/slo.md#7-responding-to-a-burn-rate-alert` in their
 * description and every other alarm in the repository carried nothing. Both are
 * the same failure at different depths. The link is a document whose first
 * instruction is "open the `<env>-slo` dashboard", which at 04:00 is not a step
 * but a prerequisite — the right account, the right region, console access, and
 * knowing which of the nine dashboards is meant. The alarms with no link at all
 * simply hand over a name and a threshold.
 *
 * ## Architecture
 *
 *     alarm → SNS (the topics that already existed)
 *                ├─ the subscribers that were already there — unchanged
 *                └─ runbook enricher (Lambda)
 *                     ├─ match alarm name → runbook  (lib/runbooks.ts)
 *                     ├─ ssm:StartAutomationExecution → the first step
 *                     └─ SNS `<env>-runbook-alerts` → the rota
 *
 * Three decisions in there are the whole design:
 *
 *   **The enricher is added to the existing topics, not put in front of them.**
 *   A relay in the delivery path is a single point of failure on the path that
 *   reports failures. Here the raw alarm still reaches whoever was subscribed
 *   before; enrichment is a second, better copy. An enricher that is broken,
 *   throttled or mid-deployment costs the responder a runbook link, never a page.
 *
 *   **The first step runs itself.** Starting a read-only automation is something
 *   a machine can do in the two hundred milliseconds between the alarm and the
 *   phone buzzing, and it is the part of the first ten minutes that is pure
 *   latency. The alert carries the execution id, so the first human action is
 *   reading an answer rather than gathering one.
 *
 *   **The first step cannot change anything.** Every document here is a single
 *   `aws:executeAwsApi` step on a `Describe`/`Get`/`List` call, and
 *   `tools/audit-runbooks.ts` refuses any other verb. A one-click "restart the
 *   service" in a page is a way to turn a degraded service into an outage while
 *   still half asleep — remediation belongs behind a decision, which is what
 *   `RollbackAutomationStack` and `SloBurnRateRollbackStack` already are.
 *
 * ## Why the enricher's own alarm goes somewhere else
 *
 * `<env>-runbook-enricher-errors` notifies `<env>-runbook-alerts` directly. It
 * is the one alarm that must not be enriched: the component that would enrich it
 * is the component that failed. Everything else that reaches the rota comes
 * through the enricher, so an unenriched message on that topic is itself the
 * signal that enrichment is down.
 */
export class RunbookStack extends cdk.Stack {
  /** Where enriched alerts are published. The rota subscribes here. */
  public readonly alertTopic: sns.Topic;
  public readonly enricher: lambda.Function;
  /** Failed enrichments, after SNS and Lambda have both retried. */
  public readonly deadLetterQueue: sqs.Queue;
  /** First-step documents, keyed by catalogue `documentKey`. */
  public readonly documents: Record<string, ssm.CfnDocument>;
  /** Role the automations assume. Read-only, by construction. */
  public readonly automationRole: iam.Role;

  constructor(scope: Construct, id: string, props: RunbookStackProps) {
    super(scope, id, props);

    const envName = props.envName;
    const catalogue = props.catalogue ?? RUNBOOK_CATALOGUE;
    const docBaseUrl = props.docBaseUrl ?? RUNBOOK_DOC_BASE_URL;
    const timeoutSeconds = props.lambdaTimeoutSeconds ?? 30;

    assertValidRunbookCatalogue(catalogue);

    if (props.alarmTopics.length === 0) {
      throw new Error(
        `RunbookStack ${id}: alarmTopics is empty. The stack would synthesise every document ` +
          'and every rule would pass while no alarm in the account reached the enricher.',
      );
    }

    const specs = documentSpecs(props);
    const needed = requiredDocumentKeys(catalogue);
    const missing = needed.filter((key) => !specs.some((spec) => spec.key === key));
    if (missing.length > 0) {
      throw new Error(
        `RunbookStack ${id}: the catalogue's first steps need document(s) ${missing.join(', ')}, ` +
          'which this stack does not build. A runbook whose first step names a document nobody ' +
          'created is a link that 404s at 04:00.',
      );
    }

    // ── Encryption ────────────────────────────────────────────────────────────
    const encryptionKey = new kms.Key(this, 'RunbookEncryptionKey', {
      alias: `alias/${envName}-runbook`,
      description: `Encrypts ${envName} runbook alerts, enricher logs and configuration`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch publishes the enricher's own failure alarm to the topic below,
    // and a customer-managed key means the service principal needs saying so
    // explicitly — an AWS-managed `alias/aws/sns` would not, which is why every
    // other topic in this repository uses one. This topic holds the enriched
    // text of an alert, which is the one place an alarm's context and a
    // service's internals are written down together.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchAlarmsToPublish',
        principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'aws:SourceAccount': cdk.Stack.of(this).account } },
      }),
    );

    // ── Where the enriched alerts land ────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'RunbookAlertTopic', {
      topicName: `${envName}-${ENRICHED_TOPIC_SUFFIX}`,
      displayName: `${envName} alerts with runbooks attached`,
      masterKey: encryptionKey,
    });
    for (const email of props.notificationEmails ?? []) {
      this.alertTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── The first steps ───────────────────────────────────────────────────────
    // One role for every document, holding exactly the reads the documents make.
    // A role per document would be tidier on paper and would mean five roles
    // whose policies drift apart; the set here is small enough to read in one
    // screen, and `tools/audit-runbooks.ts` checks the verbs rather than trusting
    // the review.
    this.automationRole = new iam.Role(this, 'RunbookAutomationRole', {
      roleName: `${envName}-runbook-automation-role`,
      assumedBy: new iam.ServicePrincipal('ssm.amazonaws.com'),
      description: `Read-only diagnostics for the ${envName} runbook first steps`,
    });

    for (const spec of specs) {
      this.automationRole.addToPolicy(
        new iam.PolicyStatement({
          sid: `Read${spec.key.split('-').map(capitalise).join('')}`,
          actions: spec.iamActions.map((action) => `${spec.iamService}:${action}`),
          // None of these APIs is resource-scopable in a way that would narrow
          // anything: ecs:DescribeServices takes a service ARN but the document
          // is the only caller and names one service; cloudwatch:DescribeAlarms
          // and DescribeAlarmHistory take no resource at all. The scope that
          // matters here is the verb, and every verb is a read.
          resources: ['*'],
        }),
      );
    }

    this.documents = {};
    for (const spec of specs) {
      this.documents[spec.key] = new ssm.CfnDocument(this, `${pascalCase(spec.key)}Document`, {
        name: firstStepDocumentName(envName, spec.key),
        documentType: 'Automation',
        documentFormat: 'JSON',
        // Replaces the document in place on every change rather than leaving the
        // old version as the default. A document whose default version is three
        // changes behind is the kind of thing nobody looks at until the step it
        // runs is the wrong one.
        updateMethod: 'NewVersion',
        targetType: '/',
        content: documentContent(spec, this.automationRole.roleArn),
        tags: [
          { key: 'Environment', value: envName },
          { key: 'RunbookFirstStep', value: spec.key },
        ],
      });
    }

    // ── The enricher ──────────────────────────────────────────────────────────
    // A real dead-letter queue, unlike the scheduled Lambdas elsewhere in this
    // repository: this one is driven by a message, and a message that failed
    // every retry is an alert that reached nobody. The queue is the only record
    // that it happened.
    this.deadLetterQueue = new sqs.Queue(this, 'RunbookEnricherDlq', {
      queueName: `${envName}-runbook-enricher-dlq`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: encryptionKey,
      enforceSSL: true,
      retentionPeriod: cdk.Duration.days(14),
    });

    const logGroup = new logs.LogGroup(this, 'RunbookEnricherLogGroup', {
      logGroupName: `/aws/lambda/${envName}-runbook-enricher`,
      retention: logs.RetentionDays.ONE_MONTH,
      encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const enricherRole = new iam.Role(this, 'RunbookEnricherRole', {
      roleName: `${envName}-runbook-enricher-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Attaches runbooks to ${envName} alarm notifications and starts their first step`,
    });
    enricherRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );

    enricherRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartFirstStepAutomations',
        actions: ['ssm:StartAutomationExecution'],
        // Scoped to the documents this stack owns. `:*` is the version
        // qualifier, which `updateMethod: NewVersion` makes a moving target —
        // without it the grant stops matching the first time a document changes,
        // and the symptom is an alert that arrives with the automation missing.
        resources: specs.map(
          (spec) =>
            `arn:${this.partition}:ssm:${this.region}:${this.account}:automation-definition/` +
            `${firstStepDocumentName(envName, spec.key)}:*`,
        ),
      }),
    );
    enricherRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PassTheReadOnlyAutomationRole',
        actions: ['iam:PassRole'],
        resources: [this.automationRole.roleArn],
        // Without this condition the grant lets the enricher hand the automation
        // role to anything that will take it. With it, the only service that can
        // receive it is the one that runs the documents.
        conditions: { StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' } },
      }),
    );
    this.alertTopic.grantPublish(enricherRole);

    const runbookConfig = catalogue.map((runbook) => ({
      id: runbook.id,
      title: runbook.title,
      owner: runbook.owner,
      summary: runbook.summary,
      url: runbookUrl(runbook, docBaseUrl),
      patterns: runbook.alarmNamePatterns,
      firstStep: {
        documentName: firstStepDocumentName(envName, runbook.firstStep.documentKey),
        summary: runbook.firstStep.summary,
        alarmFilledParameters: runbook.firstStep.alarmFilledParameters,
      },
    }));

    this.enricher = new lambda.Function(this, 'RunbookEnricher', {
      functionName: `${envName}-runbook-enricher`,
      description: `Attaches the runbook to a ${envName} alarm and starts its first step`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: enricherRole,
      timeout: cdk.Duration.seconds(timeoutSeconds),
      // Alarms arrive in bursts — one incident is a dozen notifications in the
      // same second — and each one starts an automation. Ten is enough for that
      // burst and low enough that a notification storm cannot consume the
      // account's concurrency pool, which the application shares.
      reservedConcurrentExecutions: 10,
      environmentEncryption: encryptionKey,
      logGroup,
      deadLetterQueue: this.deadLetterQueue,
      environment: {
        RUNBOOKS: JSON.stringify(runbookConfig),
        ALERT_TOPIC_ARN: this.alertTopic.topicArn,
        ENV_NAME: envName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(RUNBOOK_ENRICHER_SOURCE),
    });

    (this.enricher.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls only the regional SSM and SNS APIs and touches no ' +
            'VPC resource. Attaching it would need a NAT gateway or interface endpoints to ' +
            'reach them, which puts a second failure domain on the path that delivers alerts ' +
            'about the first one.',
        },
      ],
    });

    for (const [index, topic] of props.alarmTopics.entries()) {
      // `addSubscription` on an imported topic would try to mutate the stack
      // that owns it. A Subscription resource here keeps the dependency pointing
      // one way: this stack reads their ARNs and nothing they own changes.
      new sns.Subscription(this, `AlarmTopicSubscription${index}`, {
        topic,
        endpoint: this.enricher.functionArn,
        protocol: sns.SubscriptionProtocol.LAMBDA,
      });
    }
    this.enricher.addPermission('AllowAlarmTopicsToInvoke', {
      principal: new iam.ServicePrincipal('sns.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      // Any topic in this account, because the grant has to cover topics owned
      // by eight other stacks and naming them here would make this stack
      // redeploy whenever one of them is renamed. The account condition is what
      // stops a topic in someone else's account invoking it.
      sourceAccount: this.account,
    });

    // ── The one alarm that is deliberately not enriched ───────────────────────
    const enricherErrors = new cloudwatch.Alarm(this, 'RunbookEnricherErrorsAlarm', {
      alarmName: `${envName}-runbook-enricher-errors`,
      alarmDescription:
        `The ${envName} runbook enricher is failing. Alerts are still being delivered to the ` +
        'topics they were always delivered to; what has stopped is the runbook link and the ' +
        'first step. Check the dead-letter queue for the notifications it could not enrich. ' +
        `Owner: platform-team. Runbook: ${docBaseUrl.replace(/\/+$/, '')}/docs/runbooks.md` +
        '#9-a-platform-component-has-stopped-reporting',
      metric: this.enricher.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // A function that is not being invoked is not failing: alarms are bursty
      // and most five-minute windows here have no datapoint at all.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    enricherErrors.addAlarmAction({
      bind: () => ({ alarmActionArn: this.alertTopic.topicArn }),
    });

    new cdk.CfnOutput(this, 'RunbookAlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'Enriched alerts — subscribe the rota here',
      exportName: `${envName}-runbook-alert-topic-arn`,
    });
    new cdk.CfnOutput(this, 'RunbookEnricherDlqUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'Notifications the enricher could not process after every retry',
    });
  }
}

/* ── First-step documents ─────────────────────────────────────────────────── */

const capitalise = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const pascalCase = (value: string): string => value.split('-').map(capitalise).join('');

/**
 * The documents, and the one question each of them answers.
 *
 * Every parameter carries a default except the ones the enricher fills from the
 * alarm, and that is the property that makes the step executable rather than a
 * form: a responder who follows the console link gets a button, not five fields
 * whose values are in a stack output somewhere.
 */
const documentSpecs = (props: RunbookStackProps): DocumentSpec[] => [
  {
    key: 'ecs-service-state',
    description:
      'Reads the ECS service behind the alarm: running against desired task count, and any ' +
      'deployment in progress. First step for a 5xx page and for a saturation ticket alike — ' +
      'both are usually "a deployment is halfway through" or "tasks are being killed".',
    iamService: 'ecs',
    apiService: 'ecs',
    api: 'DescribeServices',
    iamActions: ['DescribeServices'],
    parameters: [
      {
        name: 'ClusterName',
        description: 'ECS cluster holding the service',
        defaultValue: props.service.clusterName,
      },
      {
        name: 'ServiceName',
        description: 'ECS service the alarm is about',
        defaultValue: props.service.serviceName,
      },
    ],
    apiInputs: { cluster: '{{ ClusterName }}', services: ['{{ ServiceName }}'] },
    outputs: [
      { name: 'Status', selector: '$.services[0].status', type: 'String' },
      { name: 'RunningCount', selector: '$.services[0].runningCount', type: 'Integer' },
      { name: 'DesiredCount', selector: '$.services[0].desiredCount', type: 'Integer' },
      { name: 'PendingCount', selector: '$.services[0].pendingCount', type: 'Integer' },
      { name: 'Deployments', selector: '$.services[0].deployments', type: 'MapList' },
      { name: 'Events', selector: '$.services[0].events[0:5]', type: 'MapList' },
    ],
  },
  {
    key: 'environment-alarm-state',
    description:
      'Lists every alarm in this environment that is in ALARM right now. The first question ' +
      'behind an SLO page or a canary page is not "why is this one red" but "how many are", ' +
      'and that answer changes what the responder does next.',
    iamService: 'cloudwatch',
    apiService: 'cloudwatch',
    api: 'DescribeAlarms',
    iamActions: ['DescribeAlarms'],
    parameters: [
      {
        name: 'AlarmNamePrefix',
        description: 'Only alarms whose name starts with this',
        defaultValue: `${props.envName}-`,
      },
      {
        name: 'StateValue',
        description: 'Alarm state to list: ALARM, OK or INSUFFICIENT_DATA',
        defaultValue: 'ALARM',
      },
    ],
    apiInputs: {
      AlarmNamePrefix: '{{ AlarmNamePrefix }}',
      StateValue: '{{ StateValue }}',
      MaxRecords: 100,
    },
    outputs: [
      { name: 'MetricAlarms', selector: '$.MetricAlarms..AlarmName', type: 'StringList' },
      { name: 'CompositeAlarms', selector: '$.CompositeAlarms..AlarmName', type: 'StringList' },
    ],
  },
  {
    key: 'rds-instance-state',
    description:
      'Reads the PostgreSQL instance: class, status, Multi-AZ, and any pending modification. ' +
      'A connection ceiling is a property of the instance class, so the first step for ' +
      '"running out of connections" is finding out which class is actually deployed.',
    iamService: 'rds',
    apiService: 'rds',
    api: 'DescribeDBInstances',
    iamActions: ['DescribeDBInstances'],
    parameters: [
      {
        name: 'DBInstanceIdentifier',
        description: 'RDS instance the alarm is about',
        defaultValue: props.databaseInstanceIdentifier,
      },
    ],
    apiInputs: { DBInstanceIdentifier: '{{ DBInstanceIdentifier }}' },
    outputs: [
      { name: 'Status', selector: '$.DBInstances[0].DBInstanceStatus', type: 'String' },
      { name: 'InstanceClass', selector: '$.DBInstances[0].DBInstanceClass', type: 'String' },
      { name: 'MultiAz', selector: '$.DBInstances[0].MultiAZ', type: 'Boolean' },
      {
        name: 'PendingModifications',
        selector: '$.DBInstances[0].PendingModifiedValues',
        type: 'StringMap',
      },
    ],
  },
  {
    key: 'log-delivery-state',
    description:
      'Reads the Firehose delivery stream behind the log pipeline: its status, its ' +
      'destination, and whether a processor is attached. A destination with no processor is ' +
      'the shape of every Firehose example and the shape of an unscrubbed archive.',
    iamService: 'firehose',
    apiService: 'firehose',
    api: 'DescribeDeliveryStream',
    iamActions: ['DescribeDeliveryStream'],
    parameters: [
      {
        name: 'DeliveryStreamName',
        description: 'Firehose delivery stream the alarm is about',
        defaultValue: props.logDeliveryStreamName,
      },
    ],
    apiInputs: { DeliveryStreamName: '{{ DeliveryStreamName }}' },
    outputs: [
      {
        name: 'Status',
        selector: '$.DeliveryStreamDescription.DeliveryStreamStatus',
        type: 'String',
      },
      {
        name: 'Destinations',
        selector: '$.DeliveryStreamDescription.Destinations',
        type: 'MapList',
      },
    ],
  },
  {
    key: 'alarm-history',
    description:
      'Reads the state transitions of the alarm that fired. For a threshold whose healthy ' +
      'value is not zero — blocked requests, a sweep that fails occasionally — the first ' +
      'question is whether this is a spike or a threshold that has been wrong for a month.',
    iamService: 'cloudwatch',
    apiService: 'cloudwatch',
    api: 'DescribeAlarmHistory',
    iamActions: ['DescribeAlarmHistory'],
    parameters: [
      {
        name: 'AlarmName',
        description: 'Alarm whose history to read — filled from the notification by the enricher',
      },
    ],
    apiInputs: {
      AlarmName: '{{ AlarmName }}',
      HistoryItemType: 'StateUpdate',
      MaxRecords: 20,
      ScanBy: 'TimestampDescending',
    },
    outputs: [
      { name: 'Summaries', selector: '$.AlarmHistoryItems..HistorySummary', type: 'StringList' },
      { name: 'Timestamps', selector: '$.AlarmHistoryItems..Timestamp', type: 'StringList' },
    ],
  },
];

/** The SSM Automation document, as CloudFormation will hold it. */
const documentContent = (spec: DocumentSpec, automationRoleArn: string): Record<string, unknown> => {
  const parameters: Record<string, unknown> = {
    AutomationAssumeRole: {
      type: 'String',
      description: 'Read-only role the automation assumes',
      default: automationRoleArn,
    },
  };
  for (const parameter of spec.parameters) {
    parameters[parameter.name] = {
      type: 'String',
      description: parameter.description,
      ...(parameter.defaultValue === undefined ? {} : { default: parameter.defaultValue }),
    };
  }

  const stepName = `read${spec.api}`;

  return {
    schemaVersion: '0.3',
    description: spec.description,
    assumeRole: '{{ AutomationAssumeRole }}',
    parameters,
    mainSteps: [
      {
        name: stepName,
        action: 'aws:executeAwsApi',
        // A first step that hangs is a first step nobody waits for. Two attempts
        // and a minute: past that the responder is better served by the console.
        maxAttempts: 2,
        timeoutSeconds: 60,
        inputs: { Service: spec.apiService, Api: spec.api, ...spec.apiInputs },
        outputs: spec.outputs.map((output) => ({
          Name: output.name,
          Selector: output.selector,
          Type: output.type,
        })),
      },
    ],
    outputs: spec.outputs.map((output) => `${stepName}.${output.name}`),
  };
};

/* ── The enricher ─────────────────────────────────────────────────────────── */

/**
 * The enricher, shipped inline.
 *
 * Exported as a string so `test/runbook-enricher-handler.test.ts` can compile and
 * run it: `lambda.Code.fromInline` means nothing else in the build ever parses
 * it, so a matcher that silently matches nothing would first surface as a page
 * with no runbook on it, at 04:00, which is the one moment nobody is going to
 * notice that the *formatting* is wrong.
 *
 * Its contract is fail-open in one direction and fail-closed in the other. A
 * runbook that cannot be matched, or an automation that will not start, must
 * still produce an alert — the responder loses the link, not the page. A publish
 * that fails must throw, so SNS retries and the dead-letter queue records the
 * notification that reached nobody.
 */
export const RUNBOOK_ENRICHER_SOURCE = `
'use strict';
const { SSMClient, StartAutomationExecutionCommand } = require('@aws-sdk/client-ssm');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const ssm = new SSMClient({ region: process.env.AWS_REGION });
const sns = new SNSClient({ region: process.env.AWS_REGION });

const RUNBOOKS = JSON.parse(process.env.RUNBOOKS);
const ALERT_TOPIC_ARN = process.env.ALERT_TOPIC_ARN;
const ENV_NAME = process.env.ENV_NAME;

/** SNS rejects a subject over 100 characters, and rejects newlines in one. */
const SUBJECT_LIMIT = 100;

/**
 * Glob match, with the same two wildcards lib/runbooks.ts uses.
 *
 * Reimplemented rather than imported because this file is a string. The two are
 * held together by test/runbook-enricher-handler.test.ts, which runs both over
 * the same alarm names: a matcher that drifts here matches nothing, and an alert
 * with no runbook looks exactly like an alarm nobody wrote a runbook for.
 */
const matches = (pattern, value) => {
  let expression = '';
  for (const character of pattern) {
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else expression += character.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
  }
  return new RegExp('^' + expression + '$').test(value);
};

const runbookFor = (alarmName) =>
  RUNBOOKS.find((runbook) => runbook.patterns.some((pattern) => matches(pattern, alarmName)));

const consoleBase = (region) =>
  'https://' + region + '.console.aws.amazon.com/systems-manager/automation';

/**
 * Start the first step.
 *
 * Returns a result rather than throwing: every failure in here is a degraded
 * alert, and a degraded alert still has to be sent. The commonest one is not an
 * outage — it is a document that was renamed, which fails validation instantly
 * and would otherwise take the whole notification with it.
 */
async function startFirstStep(runbook, alarm) {
  const parameters = {};
  for (const name of runbook.firstStep.alarmFilledParameters) {
    if (name === 'AlarmName') parameters.AlarmName = [alarm.name];
  }

  try {
    const response = await ssm.send(
      new StartAutomationExecutionCommand({
        DocumentName: runbook.firstStep.documentName,
        Parameters: parameters,
      }),
    );
    return { started: true, executionId: response.AutomationExecutionId, parameters };
  } catch (error) {
    return { started: false, reason: error && error.message ? error.message : String(error), parameters };
  }
}

const parameterFlag = (parameters) => {
  const pairs = Object.keys(parameters).map((key) => key + '=' + parameters[key].join(','));
  return pairs.length === 0 ? '' : " --parameters '" + pairs.join("' '") + "'";
};

const body = (alarm, runbook, execution) => {
  const lines = [
    '[' + alarm.state + '] ' + alarm.name,
    '',
    alarm.reason || '(no reason given)',
    '',
    'Environment: ' + ENV_NAME,
    'Changed at:  ' + (alarm.at || 'unknown'),
  ];

  if (!runbook) {
    lines.push(
      '',
      'No runbook matches this alarm name.',
      'That is a gap in lib/runbooks.ts, not a property of the incident — add a pattern for it.',
    );
    return lines.join('\\n');
  }

  lines.push(
    '',
    'Runbook: ' + runbook.title + ' (' + runbook.owner + ')',
    runbook.summary,
    runbook.url,
    '',
    'First step — ' + runbook.firstStep.summary + '.',
  );

  if (execution && execution.started) {
    lines.push(
      'Already running: ' + execution.executionId,
      consoleBase(alarm.region) + '/execution/' + execution.executionId + '?region=' + alarm.region,
    );
  } else {
    lines.push(
      'Could not be started automatically: ' + ((execution && execution.reason) || 'not attempted') + '.',
      'Run it: aws ssm start-automation-execution --document-name ' +
        runbook.firstStep.documentName +
        ' --region ' +
        alarm.region +
        parameterFlag((execution && execution.parameters) || {}),
      consoleBase(alarm.region) +
        '/execute/' +
        runbook.firstStep.documentName +
        '?region=' +
        alarm.region,
    );
  }

  return lines.join('\\n');
};

const subjectFor = (alarm) => {
  const subject = '[' + alarm.state + '] ' + ENV_NAME + ' ' + alarm.name;
  const flat = subject.replace(/[\\r\\n]+/g, ' ');
  return flat.length > SUBJECT_LIMIT ? flat.slice(0, SUBJECT_LIMIT - 1) + '\\u2026' : flat;
};

/** Region out of an alarm ARN, falling back to the enricher's own. */
const regionOf = (alarmArn) => {
  const parts = typeof alarmArn === 'string' ? alarmArn.split(':') : [];
  return parts.length > 3 && parts[3] ? parts[3] : process.env.AWS_REGION;
};

exports.handler = async (event) => {
  const records = (event && event.Records) || [];
  let enriched = 0;
  let started = 0;
  let unmatched = 0;

  for (const record of records) {
    let message;
    try {
      message = JSON.parse(record.Sns.Message);
    } catch (error) {
      // Not a CloudWatch alarm notification. Something else publishes to a topic
      // an alarm also uses, and dropping it would be this function deciding what
      // the rota is allowed to see.
      message = { AlarmName: record.Sns.Subject || 'unparsed notification', NewStateReason: record.Sns.Message };
    }

    const alarm = {
      name: message.AlarmName || 'unnamed alarm',
      state: message.NewStateValue || 'ALARM',
      reason: message.NewStateReason,
      at: message.StateChangeTime,
      region: message.Region && /^[a-z]{2}-/.test(message.Region)
        ? message.Region
        : regionOf(message.AlarmArn),
    };

    const runbook = runbookFor(alarm.name);
    if (!runbook) unmatched += 1;

    // Only an ALARM transition runs anything. A recovery needs no diagnostics,
    // and starting one on every OK would double the executions while adding
    // nothing to the notification that says it is over.
    const execution =
      runbook && alarm.state === 'ALARM' ? await startFirstStep(runbook, alarm) : undefined;
    if (execution && execution.started) started += 1;

    await sns.send(
      new PublishCommand({
        TopicArn: ALERT_TOPIC_ARN,
        Subject: subjectFor(alarm),
        Message: body(alarm, runbook, execution),
      }),
    );
    enriched += 1;

    console.log(
      JSON.stringify({
        event: 'runbook.alert.enriched',
        alarm: alarm.name,
        state: alarm.state,
        runbook: runbook ? runbook.id : null,
        execution: execution && execution.started ? execution.executionId : null,
      }),
    );
  }

  return { enriched, started, unmatched };
};
`;
