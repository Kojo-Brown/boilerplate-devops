import * as cdk from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LogInsightsStackProps extends cdk.StackProps {
  /** Environment name used for resource naming */
  readonly envName?: string;
  /**
   * CloudWatch log group name for ECS application logs.
   * Typically auto-created by the awslogs driver as /ecs/{envName}/{serviceName}.
   */
  readonly appLogGroupName: string;
  /**
   * CloudWatch log group name for ALB access logs (optional).
   * Enable by setting access_logs.s3.enabled on the ALB, then stream to CloudWatch
   * via a Kinesis Firehose subscription, or point the awslogs driver at this group.
   */
  readonly accessLogGroupName?: string;
  /**
   * CloudWatch log group name for RDS PostgreSQL logs (optional).
   * Enable error / slow-query logging in the RDS Parameter Group:
   *   log_min_duration_statement = 1000
   *   log_connections            = on
   *   log_disconnections         = on
   * RDS publishes these to /aws/rds/instance/{identifier}/postgresql by default.
   */
  readonly rdsLogGroupName?: string;
  /**
   * Slow-request threshold used in the slow-requests query, in seconds (default: 1.0).
   * ALB access logs record target_processing_time as a decimal number of seconds.
   */
  readonly slowRequestThresholdSeconds?: number;
}

/**
 * CloudWatch Logs Insights saved queries for error analysis.
 *
 * Query groups:
 *   Application logs (always created, scoped to appLogGroupName):
 *     {envName}/app/recent-errors          — latest ERROR/FATAL/CRITICAL entries
 *     {envName}/app/top-error-messages     — error count grouped by extracted type
 *     {envName}/app/error-rate-over-time   — error frequency per 5-minute bucket
 *     {envName}/app/recent-exceptions      — stack traces / unhandled exceptions
 *
 *   Access logs (created when accessLogGroupName is supplied):
 *     {envName}/access/http-5xx-errors     — ALB responses with status 5xx
 *     {envName}/access/slow-requests       — responses above slowRequestThresholdSeconds
 *     {envName}/access/requests-by-status  — request count bucketed by status code
 *
 *   RDS logs (created when rdsLogGroupName is supplied):
 *     {envName}/rds/db-errors              — PostgreSQL ERROR / FATAL messages
 *     {envName}/rds/slow-queries           — duration-logged slow SQL statements
 *     {envName}/rds/connection-errors      — failed connection attempts
 */
export class LogInsightsStack extends cdk.Stack {
  public readonly queries: {
    readonly recentErrors: logs.QueryDefinition;
    readonly topErrorMessages: logs.QueryDefinition;
    readonly errorRateOverTime: logs.QueryDefinition;
    readonly recentExceptions: logs.QueryDefinition;
    readonly http5xxErrors?: logs.QueryDefinition;
    readonly slowRequests?: logs.QueryDefinition;
    readonly requestsByStatus?: logs.QueryDefinition;
    readonly dbErrors?: logs.QueryDefinition;
    readonly slowQueries?: logs.QueryDefinition;
    readonly connectionErrors?: logs.QueryDefinition;
  };

  constructor(scope: Construct, id: string, props: LogInsightsStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const slowThreshold = props.slowRequestThresholdSeconds ?? 1.0;

    const appLogGroup = logs.LogGroup.fromLogGroupName(
      this,
      'AppLogGroup',
      props.appLogGroupName,
    );

    // ── Application log queries ────────────────────────────────────────────────

    const recentErrors = new logs.QueryDefinition(this, 'RecentErrors', {
      queryDefinitionName: `${envName}/app/recent-errors`,
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@logStream', '@message'],
        filterStatements: [
          '@message like /(?i)(error|fatal|critical)/ or level = "error" or level = "fatal"',
        ],
        sort: '@timestamp desc',
        limit: 100,
      }),
      logGroups: [appLogGroup],
    });

    const topErrorMessages = new logs.QueryDefinition(this, 'TopErrorMessages', {
      queryDefinitionName: `${envName}/app/top-error-messages`,
      queryString: new logs.QueryString({
        filterStatements: [
          '@message like /(?i)(error|exception|fatal|critical)/',
        ],
        parseStatements: [
          '@message /(?<errorType>[A-Za-z]+(?:Error|Exception|Fault))/',
        ],
        statsStatements: ['count(*) as occurrences by errorType'],
        sort: 'occurrences desc',
        limit: 25,
      }),
      logGroups: [appLogGroup],
    });

    const errorRateOverTime = new logs.QueryDefinition(this, 'ErrorRateOverTime', {
      queryDefinitionName: `${envName}/app/error-rate-over-time`,
      queryString: new logs.QueryString({
        filterStatements: [
          '@message like /(?i)(error|fatal|critical)/ or level = "error" or level = "fatal"',
        ],
        statsStatements: ['count(*) as errorCount by bin(5m)'],
        sort: '@timestamp asc',
      }),
      logGroups: [appLogGroup],
    });

    const recentExceptions = new logs.QueryDefinition(this, 'RecentExceptions', {
      queryDefinitionName: `${envName}/app/recent-exceptions`,
      queryString: new logs.QueryString({
        fields: ['@timestamp', '@logStream', '@message'],
        filterStatements: [
          '@message like /(?i)(exception|traceback|stack trace|unhandled|uncaught)/',
        ],
        sort: '@timestamp desc',
        limit: 50,
      }),
      logGroups: [appLogGroup],
    });

    // ── Access log queries (optional) ─────────────────────────────────────────

    let http5xxErrors: logs.QueryDefinition | undefined;
    let slowRequests: logs.QueryDefinition | undefined;
    let requestsByStatus: logs.QueryDefinition | undefined;

    if (props.accessLogGroupName !== undefined) {
      const accessLogGroup = logs.LogGroup.fromLogGroupName(
        this,
        'AccessLogGroup',
        props.accessLogGroupName,
      );

      http5xxErrors = new logs.QueryDefinition(this, 'Http5xxErrors', {
        queryDefinitionName: `${envName}/access/http-5xx-errors`,
        queryString: new logs.QueryString({
          fields: ['@timestamp', '@message'],
          filterStatements: ['@message like / 5[0-9][0-9] /'],
          sort: '@timestamp desc',
          limit: 100,
        }),
        logGroups: [accessLogGroup],
      });

      slowRequests = new logs.QueryDefinition(this, 'SlowRequests', {
        queryDefinitionName: `${envName}/access/slow-requests`,
        queryString: new logs.QueryString({
          parseStatements: [
            `@message /(?P<target_processing_time>\\d+\\.\\d+) (?P<elb_status>\\d{3}) (?P<target_status>\\d{3})/`,
          ],
          filterStatements: [`target_processing_time > ${slowThreshold}`],
          statsStatements: [
            'avg(target_processing_time) as avg_s, max(target_processing_time) as max_s, count(*) as requests by bin(5m)',
          ],
          sort: 'max_s desc',
        }),
        logGroups: [accessLogGroup],
      });

      requestsByStatus = new logs.QueryDefinition(this, 'RequestsByStatus', {
        queryDefinitionName: `${envName}/access/requests-by-status`,
        queryString: new logs.QueryString({
          parseStatements: [
            '@message / (?P<status>[0-9]{3}) [0-9]/',
          ],
          statsStatements: ['count(*) as requestCount by status'],
          sort: 'requestCount desc',
          limit: 20,
        }),
        logGroups: [accessLogGroup],
      });
    }

    // ── RDS log queries (optional) ────────────────────────────────────────────

    let dbErrors: logs.QueryDefinition | undefined;
    let slowQueries: logs.QueryDefinition | undefined;
    let connectionErrors: logs.QueryDefinition | undefined;

    if (props.rdsLogGroupName !== undefined) {
      const rdsLogGroup = logs.LogGroup.fromLogGroupName(
        this,
        'RdsLogGroup',
        props.rdsLogGroupName,
      );

      dbErrors = new logs.QueryDefinition(this, 'DbErrors', {
        queryDefinitionName: `${envName}/rds/db-errors`,
        queryString: new logs.QueryString({
          fields: ['@timestamp', '@message'],
          filterStatements: [
            '@message like /(?i)(ERROR|FATAL|PANIC)/',
          ],
          sort: '@timestamp desc',
          limit: 100,
        }),
        logGroups: [rdsLogGroup],
      });

      slowQueries = new logs.QueryDefinition(this, 'SlowQueries', {
        queryDefinitionName: `${envName}/rds/slow-queries`,
        queryString: new logs.QueryString({
          fields: ['@timestamp', '@message'],
          filterStatements: [
            '@message like /duration:/',
          ],
          parseStatements: [
            '@message /duration: (?P<durationMs>[0-9]+\\.[0-9]+) ms/',
          ],
          statsStatements: [
            'avg(durationMs) as avg_ms, max(durationMs) as max_ms, count(*) as executions by bin(10m)',
          ],
          sort: 'max_ms desc',
          limit: 50,
        }),
        logGroups: [rdsLogGroup],
      });

      connectionErrors = new logs.QueryDefinition(this, 'ConnectionErrors', {
        queryDefinitionName: `${envName}/rds/connection-errors`,
        queryString: new logs.QueryString({
          fields: ['@timestamp', '@message'],
          filterStatements: [
            '@message like /(?i)(connection refused|too many clients|remaining connection slots|authentication failed)/',
          ],
          sort: '@timestamp desc',
          limit: 50,
        }),
        logGroups: [rdsLogGroup],
      });
    }

    this.queries = {
      recentErrors,
      topErrorMessages,
      errorRateOverTime,
      recentExceptions,
      http5xxErrors,
      slowRequests,
      requestsByStatus,
      dbErrors,
      slowQueries,
      connectionErrors,
    };

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'QueryNamespace', {
      value: `${envName}/app/`,
      description: `CloudWatch Logs Insights query namespace — search for "${envName}/" in the console`,
      exportName: `${envName}-log-insights-namespace`,
    });

    new cdk.CfnOutput(this, 'ConsoleUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#logsV2:logs-insights`,
      description: 'Direct link to CloudWatch Logs Insights in the AWS Console',
      exportName: `${envName}-log-insights-console-url`,
    });
  }
}
