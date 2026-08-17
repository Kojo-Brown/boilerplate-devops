import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

/** CloudWatch namespace the sweep publishes into. */
export const DEFAULT_METRIC_NAMESPACE = 'FeatureFlags';

/** Label applied to every issue the sweep opens, so it can find its own work again. */
export const DEFAULT_ISSUE_LABEL = 'feature-flag-lifecycle';

/**
 * Why a flag was reported. These are the metric's `Reason` dimension and the
 * vocabulary of the issues the sweep opens, so they are exported rather than
 * spelled out twice.
 */
export type StaleReason = 'expired' | 'expiring' | 'readyToRemove' | 'abandoned';

export const STALE_REASONS: readonly StaleReason[] = [
  'expired',
  'expiring',
  'readyToRemove',
  'abandoned',
];

/** One AppConfig environment the sweep reads. */
export interface FeatureFlagEnvironment {
  /** Name used in metric dimensions and issue titles, e.g. `production`. */
  readonly name: string;
  /** AppConfig environment ID — `AppConfigStack.environments[name].environmentId`. */
  readonly environmentId: string;
}

export interface FeatureFlagLifecycleStackProps extends cdk.StackProps {
  /** The AppConfig application whose flags are swept (from `AppConfigStack`). */
  readonly application: appconfig.IApplication;
  /** Configuration profile holding the flag manifest — `AppConfigStack.featureFlagsConfig`. */
  readonly configurationProfileId: string;
  /** Environments to sweep. Every one is read on every run. */
  readonly environments: readonly FeatureFlagEnvironment[];
  /** `owner/name` of the repository whose backlog tracks flag removal. */
  readonly repository: string;
  /**
   * Secrets Manager ARN of a secret whose `token` field is a GitHub token with
   * `issues: write`. Omit and the sweep still measures and notifies — it simply
   * cannot open the issue that turns a measurement into somebody's work.
   */
  readonly githubTokenSecretArn?: string;
  /** GitHub API base URL — override for GitHub Enterprise Server. */
  readonly githubApiUrl?: string;
  /** Label applied to every issue the sweep opens (default: `feature-flag-lifecycle`). */
  readonly issueLabel?: string;
  /** Report a temporary flag this many days before its removal date (default: 14). */
  readonly warnWithinDays?: number;
  /**
   * Report a temporary flag that has never been rolled out and is this many days
   * old (default: 30). A flag created a month ago and still off is not a rollout
   * in progress; it is a code path in production that nothing has ever taken.
   */
  readonly abandonedAfterDays?: number;
  /** How often the sweep runs (default: daily at 09:00 UTC). */
  readonly schedule?: events.Schedule;
  /** Classify and report without opening any issue (default: false). */
  readonly dryRun?: boolean;
  /** Existing SNS topic for the summary. A new one is created when omitted. */
  readonly notificationTopic?: sns.ITopic;
}

/**
 * Feature flag lifecycle: the part that runs after the pull request is merged.
 *
 * The manifest in `aws/appconfig/` covers creation — every flag arrives with an
 * owner, a kind, a ticket, and a removal date, and `npm run audit:flags` refuses
 * a flag that arrives without them. That is the easy half. The hard half is that
 * a flag's removal date passes silently: the deadline is a string in a JSON file
 * that nothing reads once it has been deployed, the rollout finished weeks ago,
 * the person who set the date has moved on, and the flag stays because removing
 * it is the only task in the project that nobody is blocked by.
 *
 * This stack is the thing that reads the date afterwards. Once a day it takes
 * the configuration that is *actually deployed* to each environment — via the
 * runtime Data API, the same call the application makes, rather than the latest
 * version in the profile, because a version that was never deployed guards
 * nothing and a version that was deployed and rolled back still does — and
 * classifies every flag in it:
 *
 *   expired        past its removal date and still shipping
 *   expiring       inside `warnWithinDays` of that date
 *   readyToRemove  a temporary flag at 100%: the rollout is over, and what is
 *                  left is not a rollout but an unremoved branch
 *   abandoned      older than `abandonedAfterDays` and never turned on
 *
 * Each classification becomes a CloudWatch metric (so it can be alarmed and
 * graphed next to everything else), a line in an SNS summary, and — for
 * everything except `expiring` — a GitHub issue assigned to the flag's owner.
 * The issue is the point. A metric tells you the debt exists; an issue in the
 * owning team's backlog with the flag key, the environment, and the ticket that
 * introduced it is the smallest unit of work someone can pick up.
 *
 * ## What it deliberately does not do
 *
 * It does not delete flags. Removing a flag means removing the code that reads
 * it, and those happen in that order: delete the configuration first and every
 * running process falls back to whatever its client library does with a missing
 * key — usually `undefined`, which is falsy, which silently takes the branch the
 * rollout was moving *away* from. An automated cleanup that turned a finished
 * 100% rollout back off in production would be the most damaging thing in this
 * repository. So the sweep escalates and never mutates.
 *
 * ## When it cannot read the configuration
 *
 * A manifest it cannot parse, or one in a version it does not understand, is
 * reported as `ManifestUnreadable` and does not count as zero stale flags. The
 * distinction matters for the same reason it does in the preview reaper: a
 * sweep that cannot see is not a sweep that found nothing, and an alarm wired to
 * "stale flags = 0" would read a broken sweep as a clean one.
 */
export class FeatureFlagLifecycleStack extends cdk.Stack {
  public readonly sweepFunction: lambda.Function;
  public readonly notificationTopic: sns.ITopic;
  /** Fires when any environment is serving a flag past its removal date. */
  public readonly expiredFlagsAlarm: cloudwatch.Alarm;
  /** Fires when the sweep ran but could not read the deployed configuration. */
  public readonly unreadableManifestAlarm: cloudwatch.Alarm;
  public readonly metricNamespace: string;

  constructor(scope: Construct, id: string, props: FeatureFlagLifecycleStackProps) {
    super(scope, id, props);

    if (props.environments.length === 0) {
      throw new Error(
        'FeatureFlagLifecycleStack needs at least one environment to sweep; with none it ' +
          'would report zero stale flags forever.',
      );
    }

    const issueLabel = props.issueLabel ?? DEFAULT_ISSUE_LABEL;
    const warnWithinDays = props.warnWithinDays ?? 14;
    const abandonedAfterDays = props.abandonedAfterDays ?? 30;
    const dryRun = props.dryRun ?? false;
    this.metricNamespace = DEFAULT_METRIC_NAMESPACE;

    // ── Notifications ─────────────────────────────────────────────────────────
    this.notificationTopic =
      props.notificationTopic ??
      new sns.Topic(this, 'FeatureFlagLifecycleTopic', {
        topicName: `${this.stackName}-flag-lifecycle`,
        displayName: 'Feature flag lifecycle sweep',
        enforceSSL: true,
        // The AWS-managed SNS key rather than a CMK, for the same reason as the
        // preview reaper's topic: encryption at rest with no key to rotate, and
        // the contents are flag keys and dates.
        masterKey: kms.Alias.fromAliasName(this, 'FlagLifecycleSnsKey', 'alias/aws/sns'),
      });

    // ── Log group ─────────────────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'FeatureFlagSweepLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-flag-sweep`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    (logGroup.node.defaultChild as logs.CfnLogGroup).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_158',
          comment:
            'No CMK on the log group: AWS-managed encryption at rest is already in force, and ' +
            'the contents are the sweep naming which flags are overdue. The flag manifest is ' +
            'deployed configuration, not a secret.',
        },
      ],
    });

    // ── Role ──────────────────────────────────────────────────────────────────
    const sweepRole = new iam.Role(this, 'FeatureFlagSweepRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Reads deployed feature flags and reports the ones past their lifecycle',
    });
    logGroup.grantWrite(sweepRole);

    sweepRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'StartConfigurationSession',
        actions: ['appconfig:StartConfigurationSession'],
        resources: [`${props.application.applicationArn}/environment/*`],
      }),
    );
    sweepRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GetLatestConfiguration',
        // The session token returned by StartConfigurationSession is what
        // actually scopes this call — it names the application, environment and
        // profile, and the statement above is what decides which sessions can
        // be started. The resource wildcard here cannot widen that.
        actions: ['appconfig:GetLatestConfiguration'],
        resources: [`arn:${this.partition}:appconfig:${this.region}:${this.account}:configuration/*`],
      }),
    );
    sweepRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PublishFlagMetrics',
        // PutMetricData has no resource-level permissions — the API rejects any
        // resource other than `*` — so the namespace condition is the only
        // available scope, and it is the one that matters: this role can write
        // to the feature flag namespace and nowhere else.
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': this.metricNamespace } },
      }),
    );
    this.notificationTopic.grantPublish(sweepRole);

    if (props.githubTokenSecretArn) {
      sweepRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ReadGitHubToken',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.githubTokenSecretArn],
        }),
      );
    }

    // ── Sweep function ────────────────────────────────────────────────────────
    this.sweepFunction = new lambda.Function(this, 'FeatureFlagSweepFunction', {
      functionName: `${this.stackName}-flag-sweep`,
      description: 'Reports deployed feature flags that are expired, finished, or abandoned',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: sweepRole,
      logGroup,
      timeout: cdk.Duration.minutes(5),
      // One sweep at a time. Two concurrent runs would race on the
      // already-open-issue check and file the same removal twice.
      reservedConcurrentExecutions: 1,
      environment: {
        APPLICATION_ID: props.application.applicationId,
        CONFIGURATION_PROFILE_ID: props.configurationProfileId,
        ENVIRONMENTS: JSON.stringify(
          props.environments.map((e) => ({ name: e.name, id: e.environmentId })),
        ),
        METRIC_NAMESPACE: this.metricNamespace,
        SNS_TOPIC_ARN: this.notificationTopic.topicArn,
        REPOSITORY: props.repository,
        GITHUB_API_URL: props.githubApiUrl ?? 'https://api.github.com',
        GITHUB_TOKEN_SECRET_ARN: props.githubTokenSecretArn ?? '',
        ISSUE_LABEL: issueLabel,
        WARN_WITHIN_DAYS: String(warnWithinDays),
        ABANDONED_AFTER_DAYS: String(abandonedAfterDays),
        DRY_RUN: String(dryRun),
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      code: lambda.Code.fromInline(FEATURE_FLAG_SWEEP_SOURCE),
    });

    (this.sweepFunction.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: the invoker is a schedule, and a failed sweep is superseded by the next ' +
            'one rather than resumed. Every run re-reads the deployed configuration from ' +
            'scratch, so there is no partial state worth replaying.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler talks to AppConfig, CloudWatch, SNS, Secrets Manager ' +
            'and the GitHub API. Attaching it to a VPC would require a NAT gateway or four ' +
            'interface endpoints to reach services it is no closer to.',
        },
        {
          id: 'CKV_AWS_173',
          comment:
            'No KMS key on the environment variables: they hold AppConfig identifiers, day ' +
            'thresholds, and a repository name. The GitHub token is read from Secrets Manager ' +
            'at invocation and never placed in the environment.',
        },
      ],
    });

    new events.Rule(this, 'FeatureFlagSweepSchedule', {
      ruleName: `${this.stackName}-flag-sweep-schedule`,
      description: 'Daily sweep for expired, finished, and abandoned feature flags',
      schedule: props.schedule ?? events.Schedule.cron({ minute: '0', hour: '9' }),
      targets: [new targets.LambdaFunction(this.sweepFunction)],
    });

    // ── Alarms ────────────────────────────────────────────────────────────────
    // An expired flag is not an incident, so this alarm is deliberately slow:
    // it needs the condition to hold across three consecutive daily sweeps
    // before it fires. One overdue day is somebody merging the removal tomorrow;
    // three is a flag nobody picked up.
    this.expiredFlagsAlarm = new cloudwatch.Alarm(this, 'ExpiredFlagsAlarm', {
      alarmName: `${this.stackName}-expired-feature-flags`,
      alarmDescription:
        'A deployed feature flag is past its declared removal date. Every code path it ' +
        'guards is still live and still untested in combination with the others.',
      metric: this.staleFlagMetric('expired'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      // A sweep that did not run leaves no datapoint. Treating that as breaching
      // would alarm on the sweep being broken under the name "expired flags",
      // which is the wrong alarm; `unreadableManifestAlarm` and the schedule's
      // own failure metric cover that.
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.expiredFlagsAlarm.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));

    this.unreadableManifestAlarm = new cloudwatch.Alarm(this, 'UnreadableManifestAlarm', {
      alarmName: `${this.stackName}-unreadable-flag-manifest`,
      alarmDescription:
        'The sweep reached AppConfig but could not read the deployed flag manifest. Until ' +
        'this clears, "zero stale flags" means "nothing was measured".',
      metric: new cloudwatch.Metric({
        namespace: this.metricNamespace,
        metricName: 'ManifestUnreadable',
        statistic: cloudwatch.Stats.MAXIMUM,
        period: cdk.Duration.days(1),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.unreadableManifestAlarm.addAlarmAction(new cw_actions.SnsAction(this.notificationTopic));

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'FlagSweepFunctionName', {
      value: this.sweepFunction.functionName,
      description: 'Invoke manually to sweep on demand: aws lambda invoke --function-name <this>',
      exportName: `${this.stackName}-flag-sweep-function`,
    });

    new cdk.CfnOutput(this, 'FlagLifecycleTopicArn', {
      value: this.notificationTopic.topicArn,
      description: 'Subscribe to receive the daily flag lifecycle summary',
      exportName: `${this.stackName}-flag-lifecycle-topic`,
    });

    new cdk.CfnOutput(this, 'FlagMetricNamespace', {
      value: this.metricNamespace,
      description: 'CloudWatch namespace carrying StaleFlags, DeployedFlags and ManifestUnreadable',
      exportName: `${this.stackName}-flag-metric-namespace`,
    });
  }

  /**
   * Stale flag count for one reason, summed across environments.
   *
   * Exposed so a dashboard can graph the same series the alarm watches instead
   * of re-deriving the dimensions and quietly disagreeing with it.
   */
  public staleFlagMetric(reason: StaleReason, environmentName?: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace: this.metricNamespace,
      metricName: 'StaleFlags',
      dimensionsMap: {
        Reason: reason,
        ...(environmentName ? { Environment: environmentName } : {}),
      },
      statistic: cloudwatch.Stats.MAXIMUM,
      period: cdk.Duration.days(1),
    });
  }
}

/**
 * The sweep, shipped inline.
 *
 * Exported as a string so `test/feature-flag-lifecycle-handler.test.ts` can
 * compile and run it. `lambda.Code.fromInline` means nothing else in the build
 * parses it — `tsc` sees a template literal and `cdk synth` embeds it verbatim —
 * and every mistake available in here fails quietly: a classification that is
 * always empty reports a clean estate that is not clean, and one that fires on
 * healthy flags files issues until the label is muted, which is the same
 * outcome by a longer route.
 */
export const FEATURE_FLAG_SWEEP_SOURCE = `
'use strict';
const {
  AppConfigDataClient,
  StartConfigurationSessionCommand,
  GetLatestConfigurationCommand,
} = require('@aws-sdk/client-appconfigdata');
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

const region = process.env.AWS_REGION;
const appConfigData = new AppConfigDataClient({ region });
const cloudwatch = new CloudWatchClient({ region });
const sns = new SNSClient({ region });
const secretsManager = new SecretsManagerClient({ region });

const APPLICATION_ID = process.env.APPLICATION_ID;
const CONFIGURATION_PROFILE_ID = process.env.CONFIGURATION_PROFILE_ID;
const ENVIRONMENTS = JSON.parse(process.env.ENVIRONMENTS);
const METRIC_NAMESPACE = process.env.METRIC_NAMESPACE;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const REPOSITORY = process.env.REPOSITORY;
const GITHUB_API_URL = process.env.GITHUB_API_URL;
const GITHUB_TOKEN_SECRET_ARN = process.env.GITHUB_TOKEN_SECRET_ARN;
const ISSUE_LABEL = process.env.ISSUE_LABEL;
const WARN_WITHIN_DAYS = parseFloat(process.env.WARN_WITHIN_DAYS);
const ABANDONED_AFTER_DAYS = parseFloat(process.env.ABANDONED_AFTER_DAYS);
const DRY_RUN = process.env.DRY_RUN === 'true';

const MANIFEST_VERSION = '1';
const TEMPORARY_KINDS = ['release', 'experiment'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** Reasons that become an issue. 'expiring' is a heads-up, not yet work. */
const ACTIONABLE_REASONS = ['expired', 'readyToRemove', 'abandoned'];

const ALL_REASONS = ['expired', 'expiring', 'readyToRemove', 'abandoned'];

/** Issues per page when listing. Also the signal that a page was the last one. */
const ISSUE_PAGE_SIZE = 100;

/** Decode the configuration body, which the SDK hands back as bytes. */
function decode(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (typeof body.transformToString === 'function') return body.transformToString();
  return new TextDecoder('utf-8').decode(body);
}

const isoDay = (date) => date.toISOString().slice(0, 10);

/**
 * Parse an ISO calendar day at UTC midnight. Returns undefined for anything
 * that is not one, rather than letting Date roll 2026-02-30 into March — a
 * deadline that silently moves is worse than one that fails to parse.
 */
function parseDay(value) {
  if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return undefined;
  const parsed = new Date(value + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime())) return undefined;
  if (isoDay(parsed) !== value) return undefined;
  return parsed;
}

const daysBetween = (from, to) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

/**
 * The UTC calendar day an instant falls on, at midnight.
 *
 * Expiry is a date, not a moment. A flag due on the 15th is due at the end of
 * the 15th, and comparing a timestamp against midnight would report it overdue
 * for the twenty-four hours it still has — and file the issue a day early,
 * every day, for the rest of the rollout.
 */
function startOfUtcDay(instant) {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

/**
 * Read what is deployed to one environment.
 *
 * This is the runtime path — StartConfigurationSession then
 * GetLatestConfiguration, the same two calls the application makes — and not
 * the profile's latest hosted version, because the latest version is what
 * someone uploaded and this is what is being served.
 */
async function readDeployedConfiguration(environment) {
  const session = await appConfigData.send(
    new StartConfigurationSessionCommand({
      ApplicationIdentifier: APPLICATION_ID,
      EnvironmentIdentifier: environment.id,
      ConfigurationProfileIdentifier: CONFIGURATION_PROFILE_ID,
    }),
  );

  const response = await appConfigData.send(
    new GetLatestConfigurationCommand({
      ConfigurationToken: session.InitialConfigurationToken,
    }),
  );

  const body = await decode(response.Configuration);
  if (body.trim() === '') {
    throw new Error('AppConfig returned an empty configuration for ' + environment.name);
  }

  const manifest = JSON.parse(body);
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('the deployed configuration is not a JSON object');
  }
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      'unsupported manifest version ' +
        JSON.stringify(manifest.version) +
        '; this sweep reads version ' +
        MANIFEST_VERSION,
    );
  }
  if (manifest.flags === null || typeof manifest.flags !== 'object') {
    throw new Error('the deployed configuration has no flags object');
  }

  return manifest;
}

/**
 * Classify one flag, or return undefined when there is nothing to say about it.
 *
 * Order matters: a flag can be both expired and fully rolled out, and the
 * overdue deadline is the more urgent of the two, so it wins. Operational
 * flags — kill switches, limits — are controls rather than unfinished work and
 * are never stale; they carry no removal date to be past.
 */
function classify(key, flag, now) {
  if (flag === null || typeof flag !== 'object') return undefined;
  if (!TEMPORARY_KINDS.includes(flag.kind)) return undefined;

  const today = startOfUtcDay(now);
  const expiresOn = parseDay(flag.expiresOn);
  const createdOn = parseDay(flag.createdOn);
  const rollout = typeof flag.rolloutPercentage === 'number' ? flag.rolloutPercentage : 100;
  const live = flag.enabled === true && rollout > 0;

  if (expiresOn !== undefined && today.getTime() > expiresOn.getTime()) {
    return {
      key: key,
      reason: 'expired',
      detail:
        'due for removal on ' +
        isoDay(expiresOn) +
        ', ' +
        daysBetween(expiresOn, today) +
        ' day(s) ago',
    };
  }

  // Never turned on, and old enough that "still rolling out" is not the
  // explanation. Checked before readyToRemove because a flag at 0% cannot also
  // be finished.
  if (!live && createdOn !== undefined && daysBetween(createdOn, today) >= ABANDONED_AFTER_DAYS) {
    return {
      key: key,
      reason: 'abandoned',
      detail:
        'created ' +
        daysBetween(createdOn, today) +
        ' day(s) ago on ' +
        isoDay(createdOn) +
        ' and has never been rolled out',
    };
  }

  if (live && rollout >= 100) {
    return {
      key: key,
      reason: 'readyToRemove',
      detail:
        'fully rolled out; what is left is not a rollout but an unremoved branch' +
        (expiresOn === undefined ? '' : ', due ' + isoDay(expiresOn)),
    };
  }

  if (expiresOn !== undefined && daysBetween(today, expiresOn) <= WARN_WITHIN_DAYS) {
    return {
      key: key,
      reason: 'expiring',
      detail:
        'due for removal on ' + isoDay(expiresOn) + ', in ' + daysBetween(today, expiresOn) + ' day(s)',
    };
  }

  return undefined;
}

async function githubToken() {
  if (!GITHUB_TOKEN_SECRET_ARN) return undefined;

  try {
    const secret = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: GITHUB_TOKEN_SECRET_ARN }),
    );
    if (!secret.SecretString) return undefined;
    const parsed = JSON.parse(secret.SecretString);
    return parsed.token || undefined;
  } catch (error) {
    console.error('could not read the GitHub token:', error.message);
    return undefined;
  }
}

const githubHeaders = (token) => ({
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + token,
  'content-type': 'application/json',
  'user-agent': 'feature-flag-lifecycle-sweep',
  'x-github-api-version': '2022-11-28',
});

/**
 * The marker that makes an issue findable again on the next sweep.
 *
 * It is in the title rather than the body because the issue list API returns
 * titles, and searching bodies means either the search API — eventually
 * consistent, so a sweep an hour after the last one can miss its own issue and
 * file a duplicate — or fetching every issue.
 */
const issueMarker = (environmentName, key) => '[flag:' + key + '@' + environmentName + ']';

/** Open issues the sweep has already filed, by marker. */
async function openIssueMarkers(token) {
  const markers = new Set();
  let page = 1;

  // Paginated: a backlog that has been ignored for a while is exactly the case
  // where reading only the first page starts filing duplicates of the oldest
  // issues, which are the ones that most need not to be duplicated.
  for (;;) {
    const url =
      GITHUB_API_URL +
      '/repos/' +
      REPOSITORY +
      '/issues?state=open&per_page=' +
      ISSUE_PAGE_SIZE +
      '&labels=' +
      encodeURIComponent(ISSUE_LABEL) +
      '&page=' +
      page;
    const response = await fetch(url, { headers: githubHeaders(token) });

    if (!response.ok) {
      throw new Error('listing open issues failed with HTTP ' + response.status);
    }

    const issues = await response.json();
    if (!Array.isArray(issues) || issues.length === 0) return markers;

    for (const issue of issues) {
      const match = /\\[flag:[^\\]]+\\]/.exec(issue.title || '');
      if (match) markers.add(match[0]);
    }

    if (issues.length < ISSUE_PAGE_SIZE) return markers;
    page += 1;
  }
}

function issueBody(environmentName, finding, flag) {
  const lines = [
    'The daily feature flag sweep found this flag in **' + environmentName + '**: ' + finding.detail + '.',
    '',
    '| | |',
    '|---|---|',
    '| Flag | \`' + finding.key + '\` |',
    '| Environment | ' + environmentName + ' |',
    '| Kind | ' + flag.kind + ' |',
    '| Owner | ' + flag.owner + ' |',
    '| Introduced | ' + (flag.createdOn || 'unknown') + ' |',
    '| Due | ' + (flag.expiresOn || 'n/a') + ' |',
    '| Ticket | ' + (flag.ticket || 'n/a') + ' |',
    '| Rollout | ' + (flag.rolloutPercentage === undefined ? '100' : flag.rolloutPercentage) + '% |',
    '',
    'Removing a flag is three changes, in this order:',
    '',
    '1. Delete the branch the flag guards, keeping the side that is live, and ship it.',
    '2. Once that is deployed everywhere, remove the flag from the manifest.',
    '3. Deploy the manifest.',
    '',
    'The order is not a style preference. Deleting the configuration first leaves running ' +
      'code reading a key that is no longer there, which resolves to falsy and silently takes ' +
      'the branch the rollout moved away from.',
    '',
    'This issue was opened by the feature flag lifecycle sweep and will not be reopened if ' +
      'you close it. Closing it without removing the flag means the next sweep files it again.',
  ];
  return lines.join('\\n');
}

async function openIssue(token, environmentName, finding, flag) {
  const title =
    issueMarker(environmentName, finding.key) +
    ' Remove feature flag ' +
    finding.key +
    ' (' +
    finding.reason +
    ')';

  const response = await fetch(GITHUB_API_URL + '/repos/' + REPOSITORY + '/issues', {
    method: 'POST',
    headers: githubHeaders(token),
    body: JSON.stringify({
      title: title,
      body: issueBody(environmentName, finding, flag),
      labels: [ISSUE_LABEL],
    }),
  });

  if (!response.ok) {
    throw new Error('creating an issue for ' + finding.key + ' failed with HTTP ' + response.status);
  }

  const issue = await response.json();
  return issue.number;
}

async function publishMetrics(metrics) {
  if (metrics.length === 0) return;

  // PutMetricData takes at most 1000 metrics per call; chunking keeps a large
  // estate from failing the whole publish on the request size.
  for (let i = 0; i < metrics.length; i += 1000) {
    await cloudwatch.send(
      new PutMetricDataCommand({
        Namespace: METRIC_NAMESPACE,
        MetricData: metrics.slice(i, i + 1000),
      }),
    );
  }
}

exports.handler = async () => {
  const now = new Date();
  const token = await githubToken();
  const metrics = [];
  const summary = [];
  const opened = [];
  const unreadable = [];

  let markers = new Set();
  let canFileIssues = token !== undefined && !DRY_RUN;

  if (canFileIssues) {
    try {
      markers = await openIssueMarkers(token);
    } catch (error) {
      // Not knowing which issues are already open is not a reason to file none;
      // it is a reason to file none *this run*, because the alternative is
      // duplicating every issue in the backlog.
      console.error('could not list open issues, skipping issue creation:', error.message);
      canFileIssues = false;
    }
  }

  for (const environment of ENVIRONMENTS) {
    let manifest;
    try {
      manifest = await readDeployedConfiguration(environment);
    } catch (error) {
      // A sweep that cannot see is not a sweep that found nothing. Reported as
      // its own metric so an alarm on stale flags never reads a broken sweep as
      // a clean estate.
      console.error('could not read ' + environment.name + ':', error.message);
      unreadable.push(environment.name + ': ' + error.message);
      metrics.push({
        MetricName: 'ManifestUnreadable',
        Dimensions: [{ Name: 'Environment', Value: environment.name }],
        Value: 1,
        Unit: 'Count',
        Timestamp: now,
      });
      continue;
    }

    metrics.push({
      MetricName: 'ManifestUnreadable',
      Dimensions: [{ Name: 'Environment', Value: environment.name }],
      Value: 0,
      Unit: 'Count',
      Timestamp: now,
    });

    const flags = manifest.flags;
    const findings = [];

    for (const key of Object.keys(flags)) {
      const finding = classify(key, flags[key], now);
      if (finding) findings.push(finding);
    }

    metrics.push({
      MetricName: 'DeployedFlags',
      Dimensions: [{ Name: 'Environment', Value: environment.name }],
      Value: Object.keys(flags).length,
      Unit: 'Count',
      Timestamp: now,
    });

    // Every reason is published every run, including the zeroes. A metric that
    // is only emitted when it is non-zero cannot distinguish "none today" from
    // "the sweep did not run", and the alarm needs that distinction.
    for (const reason of ALL_REASONS) {
      const matching = findings.filter((f) => f.reason === reason);
      metrics.push({
        MetricName: 'StaleFlags',
        Dimensions: [
          { Name: 'Environment', Value: environment.name },
          { Name: 'Reason', Value: reason },
        ],
        Value: matching.length,
        Unit: 'Count',
        Timestamp: now,
      });
      metrics.push({
        MetricName: 'StaleFlags',
        Dimensions: [{ Name: 'Reason', Value: reason }],
        Value: matching.length,
        Unit: 'Count',
        Timestamp: now,
      });
    }

    for (const finding of findings) {
      summary.push(environment.name + '  ' + finding.key + '  [' + finding.reason + ']  ' + finding.detail);

      if (!ACTIONABLE_REASONS.includes(finding.reason)) continue;
      if (!canFileIssues) continue;
      if (markers.has(issueMarker(environment.name, finding.key))) continue;

      try {
        const number = await openIssue(token, environment.name, finding, flags[finding.key]);
        markers.add(issueMarker(environment.name, finding.key));
        opened.push('#' + number + ' ' + finding.key + ' (' + environment.name + ')');
      } catch (error) {
        console.error('could not open an issue for ' + finding.key + ':', error.message);
      }
    }
  }

  // The undimensioned series, published every run including the zero. A
  // datapoint carrying dimensions is a different series from one without, so an
  // alarm on the estate as a whole has nothing to read unless this is emitted
  // alongside the per-environment values.
  metrics.push({
    MetricName: 'ManifestUnreadable',
    Value: unreadable.length,
    Unit: 'Count',
    Timestamp: now,
  });

  await publishMetrics(metrics);

  const report = {
    checked: ENVIRONMENTS.length,
    findings: summary.length,
    issuesOpened: opened.length,
    unreadable: unreadable.length,
    dryRun: DRY_RUN,
  };
  console.log(JSON.stringify(report));

  if (summary.length > 0 || unreadable.length > 0) {
    const lines = [];
    if (unreadable.length > 0) {
      lines.push('Environments the sweep could not read:', ...unreadable, '');
    }
    if (summary.length > 0) {
      lines.push('Feature flags past their lifecycle:', ...summary, '');
    }
    if (opened.length > 0) {
      lines.push('Issues opened:', ...opened, '');
    }
    if (!canFileIssues && !DRY_RUN) {
      lines.push('No issue was filed: the sweep has no usable GitHub token.', '');
    }

    await sns.send(
      new PublishCommand({
        TopicArn: SNS_TOPIC_ARN,
        Subject:
          'Feature flags: ' +
          summary.length +
          ' past lifecycle' +
          (unreadable.length > 0 ? ', ' + unreadable.length + ' unreadable' : ''),
        Message: lines.join('\\n'),
      }),
    );
  }

  return report;
};
`;
