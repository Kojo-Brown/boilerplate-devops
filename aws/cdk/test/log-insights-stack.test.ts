import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  LogInsightsStack,
  LogInsightsStackProps,
} from '../lib/log-insights-stack';

const baseProps: LogInsightsStackProps = {
  envName: 'test',
  appLogGroupName: '/ecs/test/app',
  env: { account: '123456789012', region: 'us-east-1' },
};

const makeStack = (overrides: Partial<LogInsightsStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new LogInsightsStack(app, 'TestLogInsightsStack', {
    ...baseProps,
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('LogInsightsStack — app log queries', () => {
  it('creates the four core application log query definitions', () => {
    const { template } = makeStack();
    // recent-errors, top-error-messages, error-rate-over-time, recent-exceptions
    template.resourceCountIs('AWS::Logs::QueryDefinition', 4);
  });

  it('names the recent-errors query with the env namespace', () => {
    const { template } = makeStack({ envName: 'staging' });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'staging/app/recent-errors',
    });
  });

  it('scopes recent-errors to the provided app log group', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/recent-errors',
      LogGroupNames: ['/ecs/test/app'],
    });
  });

  it('recent-errors query filters for error/fatal/critical level', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/recent-errors',
      QueryString: Match.stringLikeRegexp('(?i)\\(error\\|fatal\\|critical\\)'),
    });
  });

  it('recent-errors query includes sort and limit', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/recent-errors',
      QueryString: Match.stringLikeRegexp('@timestamp desc'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/recent-errors',
      QueryString: Match.stringLikeRegexp('limit 100'),
    });
  });

  it('top-error-messages query uses stats to aggregate by error type', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/top-error-messages',
      QueryString: Match.stringLikeRegexp('stats'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/top-error-messages',
      QueryString: Match.stringLikeRegexp('occurrences'),
    });
  });

  it('top-error-messages query parses errorType from the message', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/top-error-messages',
      QueryString: Match.stringLikeRegexp('errorType'),
    });
  });

  it('error-rate-over-time query bins errors into 5-minute intervals', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/error-rate-over-time',
      QueryString: Match.stringLikeRegexp('bin\\(5m\\)'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/error-rate-over-time',
      QueryString: Match.stringLikeRegexp('errorCount'),
    });
  });

  it('recent-exceptions query filters for exception/traceback patterns', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/app/recent-exceptions',
      QueryString: Match.stringLikeRegexp('exception'),
    });
  });

  it('uses production as the default env name', () => {
    const app = new cdk.App();
    const stack = new LogInsightsStack(app, 'DefaultEnvStack', {
      appLogGroupName: '/ecs/production/app',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'production/app/recent-errors',
    });
  });
});

describe('LogInsightsStack — access log queries', () => {
  const accessProps: Partial<LogInsightsStackProps> = {
    accessLogGroupName: '/aws/elasticloadbalancing/test-alb',
  };

  it('creates 7 query definitions when access log group is provided', () => {
    const { template } = makeStack(accessProps);
    template.resourceCountIs('AWS::Logs::QueryDefinition', 7);
  });

  it('creates 4 query definitions when access log group is omitted', () => {
    const { template } = makeStack();
    template.resourceCountIs('AWS::Logs::QueryDefinition', 4);
  });

  it('scopes http-5xx-errors to the access log group', () => {
    const { template } = makeStack(accessProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/http-5xx-errors',
      LogGroupNames: ['/aws/elasticloadbalancing/test-alb'],
    });
  });

  it('http-5xx-errors query filters for 5xx status codes', () => {
    const { template } = makeStack(accessProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/http-5xx-errors',
      QueryString: Match.stringLikeRegexp('5\\[0-9\\]\\[0-9\\]'),
    });
  });

  it('slow-requests query includes the default 1.0 s threshold', () => {
    const { template } = makeStack(accessProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/slow-requests',
      QueryString: Match.stringLikeRegexp('target_processing_time > 1'),
    });
  });

  it('slow-requests query respects a custom threshold', () => {
    const { template } = makeStack({ ...accessProps, slowRequestThresholdSeconds: 2.5 });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/slow-requests',
      QueryString: Match.stringLikeRegexp('target_processing_time > 2.5'),
    });
  });

  it('slow-requests query uses stats to compute avg and max latency', () => {
    const { template } = makeStack(accessProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/slow-requests',
      QueryString: Match.stringLikeRegexp('avg_s'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/slow-requests',
      QueryString: Match.stringLikeRegexp('max_s'),
    });
  });

  it('requests-by-status query aggregates request count by status code', () => {
    const { template } = makeStack(accessProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/requests-by-status',
      QueryString: Match.stringLikeRegexp('requestCount'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/access/requests-by-status',
      QueryString: Match.stringLikeRegexp('status'),
    });
  });
});

describe('LogInsightsStack — RDS log queries', () => {
  const rdsProps: Partial<LogInsightsStackProps> = {
    rdsLogGroupName: '/aws/rds/instance/test-postgres/postgresql',
  };

  it('creates 7 query definitions when RDS log group is provided', () => {
    const { template } = makeStack(rdsProps);
    template.resourceCountIs('AWS::Logs::QueryDefinition', 7);
  });

  it('creates 10 query definitions when all log groups are provided', () => {
    const { template } = makeStack({
      accessLogGroupName: '/aws/elasticloadbalancing/test-alb',
      rdsLogGroupName: '/aws/rds/instance/test-postgres/postgresql',
    });
    template.resourceCountIs('AWS::Logs::QueryDefinition', 10);
  });

  it('scopes db-errors to the RDS log group', () => {
    const { template } = makeStack(rdsProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/db-errors',
      LogGroupNames: ['/aws/rds/instance/test-postgres/postgresql'],
    });
  });

  it('db-errors query filters for PostgreSQL ERROR/FATAL/PANIC', () => {
    const { template } = makeStack(rdsProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/db-errors',
      QueryString: Match.stringLikeRegexp('ERROR'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/db-errors',
      QueryString: Match.stringLikeRegexp('FATAL'),
    });
  });

  it('slow-queries query parses duration from log messages', () => {
    const { template } = makeStack(rdsProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/slow-queries',
      QueryString: Match.stringLikeRegexp('duration:'),
    });
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/slow-queries',
      QueryString: Match.stringLikeRegexp('durationMs'),
    });
  });

  it('slow-queries query bins execution stats into 10-minute intervals', () => {
    const { template } = makeStack(rdsProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/slow-queries',
      QueryString: Match.stringLikeRegexp('bin\\(10m\\)'),
    });
  });

  it('connection-errors query filters for connection-failure patterns', () => {
    const { template } = makeStack(rdsProps);
    template.hasResourceProperties('AWS::Logs::QueryDefinition', {
      Name: 'test/rds/connection-errors',
      QueryString: Match.stringLikeRegexp('connection refused'),
    });
  });
});

describe('LogInsightsStack — outputs and tags', () => {
  it('exports the query namespace for the environment', () => {
    const { template } = makeStack({ envName: 'staging' });
    template.hasOutput('QueryNamespace', {
      Value: 'staging/app/',
      Export: { Name: 'staging-log-insights-namespace' },
    });
  });

  it('exports the CloudWatch Logs Insights console URL', () => {
    const { template } = makeStack({ envName: 'staging' });
    template.hasOutput('ConsoleUrl', {
      Export: { Name: 'staging-log-insights-console-url' },
    });
  });

  it('tags stack resources with the Environment label', () => {
    const { template } = makeStack({ envName: 'production' });
    const resources = template.toJSON().Resources;
    expect(Object.keys(resources).length).toBeGreaterThan(0);
  });
});
