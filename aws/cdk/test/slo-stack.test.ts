import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SloDefinition } from '../lib/slo-definitions';
import {
  SLO_METRICS,
  SLO_METRIC_NAMESPACE,
  SloStack,
  SloStackProps,
  SliMetricSource,
} from '../lib/slo-stack';
import { outputByExportName, resourceProps } from './support/cfn';

const LB_FULL_NAME = 'app/test-alb/1111111111111111';
const TG_FULL_NAME = 'targetgroup/test-tg/2222222222222222';

const ALB_SOURCE: SliMetricSource = {
  kind: 'alb',
  loadBalancerFullName: LB_FULL_NAME,
  targetGroupFullName: TG_FULL_NAME,
};

const AVAILABILITY: SloDefinition = {
  id: 'test-api-availability',
  service: 'api',
  envName: 'test',
  sli: { kind: 'availability', minimumEventsPerMinute: 15 },
  objective: 0.999,
  windowDays: 30,
  owner: 'platform-team',
  runbookUrl: 'https://runbooks.invalid/slo',
  description: 'Requests that did not fail',
  status: 'active',
};

const LATENCY: SloDefinition = {
  ...AVAILABILITY,
  id: 'test-api-latency',
  sli: { kind: 'latency', thresholdSeconds: 0.3, minimumEventsPerMinute: 15 },
  objective: 0.99,
  description: 'Requests served within 300ms',
};

const PROPOSED: SloDefinition = {
  ...AVAILABILITY,
  id: 'test-api-correctness',
  status: 'proposed',
  blockedOn: 'the application publishes no correctness counter yet',
};

const CATALOGUE = [AVAILABILITY, LATENCY, PROPOSED];

const makeStack = (overrides: Partial<SloStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new SloStack(app, 'TestSloStack', {
    envName: 'test',
    catalogue: CATALOGUE,
    slos: [{ sloId: AVAILABILITY.id, source: ALB_SOURCE }],
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

/** Alarms keyed by their `AlarmName`, for readable assertions. */
const alarmsByName = (template: Template): Record<string, Record<string, any>> =>
  Object.fromEntries(
    resourceProps(template, 'AWS::CloudWatch::Alarm').map((props) => [
      props.AlarmName as string,
      props,
    ]),
  );

/** The metric-math expression of the outermost query in an alarm. */
const expressionOf = (alarm: Record<string, any>): string =>
  (alarm.Metrics as Array<Record<string, any>>).find((m) => m.Expression && m.ReturnData)
    ?.Expression as string;

describe('SloStack burn-rate alarms', () => {
  it('creates a long and a short alarm plus a composite for every policy', () => {
    const { template } = makeStack();
    const names = Object.keys(alarmsByName(template));

    for (const policy of ['fast', 'medium', 'slow']) {
      expect(names).toContain(`test-api-availability-burn-${policy}-long`);
      expect(names).toContain(`test-api-availability-burn-${policy}-short`);
    }

    template.resourceCountIs('AWS::CloudWatch::CompositeAlarm', 3);
    expect(
      resourceProps(template, 'AWS::CloudWatch::CompositeAlarm').map((p) => p.AlarmName),
    ).toEqual([
      'test-api-availability-burn-fast',
      'test-api-availability-burn-medium',
      'test-api-availability-burn-slow',
    ]);
  });

  it('ANDs the two windows rather than alarming on either', () => {
    // Either alone is wrong in a specific direction: the long window keeps
    // paging about a recovered service, the short one pages about a blip.
    const { template } = makeStack();
    const composite = resourceProps(template, 'AWS::CloudWatch::CompositeAlarm')[0];
    expect(JSON.stringify(composite.AlarmRule)).toContain('AND');
  });

  it('floors each window on its own traffic, not on one shared count', () => {
    // 15 events/min: 75 over five minutes, 900 over an hour, 21600 over a day.
    const alarms = alarmsByName(makeStack().template);
    expect(expressionOf(alarms['test-api-availability-burn-fast-short'])).toContain('>= 75');
    expect(expressionOf(alarms['test-api-availability-burn-fast-long'])).toContain('>= 900');
    expect(expressionOf(alarms['test-api-availability-burn-slow-long'])).toContain('>= 21600');
  });

  it('divides by the error budget, written without float noise', () => {
    const alarms = alarmsByName(makeStack().template);
    const expression = expressionOf(alarms['test-api-availability-burn-fast-long']);
    expect(expression).toContain('/ 0.001,');
    expect(expression).not.toContain('0.0010000000000000009');
  });

  it('guards the denominator independently of the traffic floor', () => {
    // `IF` is element-wise over both branches, so a window with zero events would
    // divide by zero inside the branch that is about to be discarded, and
    // CloudWatch returns no data for that datapoint rather than the floor's zero.
    const alarms = alarmsByName(makeStack().template);
    expect(expressionOf(alarms['test-api-availability-burn-fast-long'])).toMatch(
      /IF\(valid_fast_Long > 0, valid_fast_Long, 1\)/,
    );
  });

  it('counts ELB-generated 5xx as well as target 5xx', () => {
    // A deployment with a broken image produces 502/503 at the load balancer; the
    // request never reaches a target, so the target-scoped metric stays clean and
    // an SLI reading only that metric would be perfect through a total outage.
    const alarm = alarmsByName(makeStack().template)['test-api-availability-burn-fast-long'];
    const metricNames = (alarm.Metrics as Array<Record<string, any>>)
      .filter((m) => m.MetricStat)
      .map((m) => m.MetricStat.Metric.MetricName);
    expect(metricNames).toEqual(
      expect.arrayContaining([
        'RequestCount',
        'HTTPCode_Target_5XX_Count',
        'HTTPCode_ELB_5XX_Count',
      ]),
    );
  });

  it('fills every input, because a quiet target group publishes no datapoint', () => {
    const alarm = alarmsByName(makeStack().template)['test-api-availability-burn-fast-long'];
    const expressions = (alarm.Metrics as Array<Record<string, any>>)
      .filter((m) => m.Expression)
      .map((m) => m.Expression as string)
      .join(' ');
    expect(expressions).toContain('FILL(rc_fast_Long, 0)');
    expect(expressions).toContain('FILL(t5_fast_Long, 0) + FILL(e5_fast_Long, 0)');
  });

  it('gives every metric-math id a unique name so policies can share a graph', () => {
    // CDK flattens nested expressions into one id namespace per alarm or widget,
    // and rejects two different metrics sharing an id. Two policies graphed
    // together both want to call their denominator `valid`.
    const { template } = makeStack();
    for (const alarm of resourceProps(template, 'AWS::CloudWatch::Alarm')) {
      const ids = ((alarm.Metrics as Array<Record<string, any>>) ?? []).map((m) => m.Id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('treats missing burn-rate data as not breaching', () => {
    // A window below its floor already evaluates to zero, so absence here means
    // the metric stopped arriving — a CloudWatch outage, not a service outage.
    const alarms = alarmsByName(makeStack().template);
    for (const name of Object.keys(alarms).filter((n) => n.includes('-burn-'))) {
      expect(alarms[name].TreatMissingData).toBe('notBreaching');
    }
  });

  it('puts the owner and the runbook in every alarm description', () => {
    const alarms = alarmsByName(makeStack().template);
    for (const props of Object.values(alarms)) {
      if (!(props.AlarmName as string).includes('test-api-availability')) continue;
      expect(props.AlarmDescription).toContain('platform-team');
      expect(props.AlarmDescription).toContain('https://runbooks.invalid/slo');
    }
  });
});

describe('SloStack severity routing', () => {
  const topicArnRefs = (template: Template) =>
    Object.fromEntries(
      Object.entries(template.findResources('AWS::SNS::Topic')).map(([logicalId, resource]) => [
        (resource.Properties as Record<string, unknown>).TopicName as string,
        logicalId,
      ]),
    );

  it('sends page policies to the page topic and ticket policies to the ticket topic', () => {
    const { template } = makeStack();
    const topics = topicArnRefs(template);
    const composites = Object.fromEntries(
      resourceProps(template, 'AWS::CloudWatch::CompositeAlarm').map((p) => [
        p.AlarmName as string,
        JSON.stringify(p.AlarmActions),
      ]),
    );

    expect(composites['test-api-availability-burn-fast']).toContain(topics['test-slo-page']);
    expect(composites['test-api-availability-burn-medium']).toContain(topics['test-slo-page']);
    expect(composites['test-api-availability-burn-slow']).toContain(topics['test-slo-ticket']);
  });

  it('downgrades every page to a ticket when asked', () => {
    // Staging evaluates the same policies and wakes nobody: a boilerplate that
    // pages on staging noise gets its alarms muted, and a muted alarm is worse
    // than no alarm.
    const { template } = makeStack({ downgradePagesToTickets: true });
    const topics = topicArnRefs(template);
    const actions = resourceProps(template, 'AWS::CloudWatch::CompositeAlarm').map((p) =>
      JSON.stringify(p.AlarmActions),
    );
    for (const action of actions) {
      expect(action).toContain(topics['test-slo-ticket']);
      expect(action).not.toContain(topics['test-slo-page']);
    }
  });

  it('says in the alarm description whether it pages', () => {
    const paging = resourceProps(makeStack().template, 'AWS::CloudWatch::CompositeAlarm');
    expect(paging[0].AlarmDescription).toContain('Pages');
    const downgraded = resourceProps(
      makeStack({ downgradePagesToTickets: true }).template,
      'AWS::CloudWatch::CompositeAlarm',
    );
    expect(downgraded[0].AlarmDescription).toContain('Raises a ticket');
  });

  it('subscribes the supplied addresses to the right topic', () => {
    const { template } = makeStack({
      pageEmails: ['rota@runbooks.invalid'],
      ticketEmails: ['tickets@runbooks.invalid'],
    });
    template.resourceCountIs('AWS::SNS::Subscription', 2);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'rota@runbooks.invalid',
    });
  });
});

describe('SloStack error-budget alarms', () => {
  it('alarms on the republished budget, which is the only way a 30-day window can be alarmed on', () => {
    const alarms = alarmsByName(makeStack().template);
    const low = alarms['test-api-availability-budget-low'];
    expect(low.Namespace).toBe(SLO_METRIC_NAMESPACE);
    expect(low.MetricName).toBe(SLO_METRICS.budgetRemainingPercent);
    expect(low.Threshold).toBe(25);
    expect(low.ComparisonOperator).toBe('LessThanThreshold');
    // The reporter republishes the same rolling window several times an hour, so
    // `Sum` would multiply it. `Minimum` takes the worst view of the hour.
    expect(low.Statistic).toBe('Minimum');
    expect(low.Period).toBe(3600);
  });

  it('honours a per-objective budget alert threshold', () => {
    const tight = { ...AVAILABILITY, id: 'tight-api-availability', budgetAlertThresholdPercent: 60 };
    const { template } = makeStack({
      catalogue: [tight],
      slos: [{ sloId: tight.id, source: ALB_SOURCE }],
    });
    expect(alarmsByName(template)['tight-api-availability-budget-low'].Threshold).toBe(60);
  });

  it('pages when the budget is gone and tickets before it is', () => {
    const { template } = makeStack();
    const alarms = alarmsByName(template);
    const topics = Object.fromEntries(
      Object.entries(template.findResources('AWS::SNS::Topic')).map(([logicalId, resource]) => [
        (resource.Properties as Record<string, unknown>).TopicName as string,
        logicalId,
      ]),
    );

    const exhausted = alarms['test-api-availability-budget-exhausted'];
    expect(exhausted.Threshold).toBe(0);
    expect(exhausted.ComparisonOperator).toBe('LessThanOrEqualToThreshold');
    expect(JSON.stringify(exhausted.AlarmActions)).toContain(topics['test-slo-page']);
    expect(JSON.stringify(alarms['test-api-availability-budget-low'].AlarmActions)).toContain(
      topics['test-slo-ticket'],
    );
  });

  it('is the no-data alarm, and only the no-data alarm, that treats absence as breaching', () => {
    // Every other signal degrades quietly to green when the SLI stops arriving:
    // a burn rate over zero requests is zero and an unspent budget is a full one.
    const alarms = alarmsByName(makeStack().template);
    const breaching = Object.entries(alarms)
      .filter(([, props]) => props.TreatMissingData === 'breaching')
      .map(([name]) => name);
    expect(breaching).toEqual(['test-api-availability-no-data']);

    const noData = alarms['test-api-availability-no-data'];
    expect(noData.MetricName).toBe(SLO_METRICS.eventsObserved);
    expect(noData.Statistic).toBe('Maximum');
    expect(noData.ComparisonOperator).toBe('LessThanOrEqualToThreshold');
    expect(noData.Threshold).toBe(0);
  });

  it('alarms on the reporter failing, which no no-data alarm would show', () => {
    // A reporter that throws on one objective and succeeds on the rest leaves no
    // gap in any of the metrics the no-data alarms read.
    const alarms = alarmsByName(makeStack().template);
    const errors = alarms['test-slo-budget-reporter-errors'];
    expect(errors.MetricName).toBe('Errors');
    expect(errors.Namespace).toBe('AWS/Lambda');
    expect(errors.Threshold).toBe(0);
  });

  it('dimensions the budget metrics by objective, service and environment', () => {
    const alarms = alarmsByName(makeStack().template);
    expect(alarms['test-api-availability-budget-low'].Dimensions).toEqual(
      expect.arrayContaining([
        { Name: 'Slo', Value: 'test-api-availability' },
        { Name: 'Service', Value: 'api' },
        { Name: 'Environment', Value: 'test' },
      ]),
    );
  });
});

describe('SloStack budget reporter', () => {
  const reporterProps = (template: Template) =>
    resourceProps(template, 'AWS::Lambda::Function').find(
      (props) => props.FunctionName === 'test-slo-budget-reporter',
    ) as Record<string, any>;

  it('ships one normalised spec per objective', () => {
    const specs = JSON.parse(reporterProps(makeStack().template).Environment.Variables.SLO_SPECS);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      id: 'test-api-availability',
      service: 'api',
      envName: 'test',
      objective: 0.999,
      windowDays: 30,
      errorBudget: 0.001,
      namespace: 'AWS/ApplicationELB',
      statistic: 'Sum',
      totalMetricName: 'RequestCount',
      badMetricNames: ['HTTPCode_Target_5XX_Count', 'HTTPCode_ELB_5XX_Count'],
    });
    expect(specs[0].dimensions).toEqual({
      LoadBalancer: LB_FULL_NAME,
      TargetGroup: TG_FULL_NAME,
    });
  });

  it('runs on a schedule and retries twice rather than harder', () => {
    // A retried run republishes an increasingly stale window; the next tick is
    // fifteen minutes away.
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'test-slo-budget-report',
      ScheduleExpression: 'rate(15 minutes)',
    });
    const rule = resourceProps(template, 'AWS::Events::Rule')[0];
    expect((rule.Targets as Array<Record<string, any>>)[0].RetryPolicy).toEqual({
      MaximumRetryAttempts: 2,
    });
  });

  it('honours a custom report interval', () => {
    const { template } = makeStack({ reportIntervalMinutes: 5 });
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
  });

  it('narrows PutMetricData to its own namespace', () => {
    // Metrics are not resources, so neither call takes an ARN. Without the
    // condition the role could overwrite any metric in the account, including the
    // AWS/* series other alarms read.
    const { template } = makeStack();
    const statements = resourceProps(template, 'AWS::IAM::Policy').flatMap(
      (props) => (props.PolicyDocument as Record<string, any>).Statement as Array<Record<string, any>>,
    );
    const put = statements.find((s) => s.Sid === 'PublishErrorBudgetMetrics');
    expect(put?.Condition).toEqual({
      StringEquals: { 'cloudwatch:namespace': SLO_METRIC_NAMESPACE },
    });
    const read = statements.find((s) => s.Sid === 'ReadSliMetrics');
    expect(read?.Action).toBe('cloudwatch:GetMetricData');
    expect(read?.Condition).toBeUndefined();
  });

  it('caps its own concurrency at one', () => {
    expect(reporterProps(makeStack().template).ReservedConcurrentExecutions).toBe(1);
  });

  it('records why it has no DLQ and is not in a VPC, on the resource', () => {
    const { template } = makeStack();
    const fn = Object.values(template.findResources('AWS::Lambda::Function')).find(
      (resource) =>
        (resource.Properties as Record<string, unknown>).FunctionName ===
        'test-slo-budget-reporter',
    ) as Record<string, any>;
    const skipped = (fn.Metadata.checkov.skip as Array<Record<string, string>>).map((s) => s.id);
    expect(skipped).toEqual(['CKV_AWS_116', 'CKV_AWS_117']);
    for (const skip of fn.Metadata.checkov.skip as Array<Record<string, string>>) {
      expect(skip.comment.length).toBeGreaterThan(40);
    }
  });

  it('encrypts its log group and its configuration with a customer-managed key', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/test-slo-budget-reporter',
      KmsKeyId: Match.anyValue(),
    });
    expect(reporterProps(makeStack().template).KmsKeyArn).toBeDefined();
  });
});

describe('SloStack ratio sources', () => {
  const ratioSource = (overrides: Record<string, unknown> = {}): SliMetricSource =>
    ({
      kind: 'ratio',
      namespace: 'AppSlo',
      totalMetricName: 'Requests',
      goodMetricName: 'RequestsFast',
      dimensionsMap: { Service: 'api', Environment: 'test' },
      ...overrides,
    }) as SliMetricSource;

  it('derives bad events from good ones with an element-wise clamp', () => {
    // The two series are published independently and can arrive a datapoint
    // apart. Unclamped that is a negative bad count and a budget above 100%.
    // `MAX` cannot be used: it reduces a series to a scalar, so `MAX(tot-good, 0)`
    // would compare the whole window against zero and return one number.
    const { template } = makeStack({
      slos: [{ sloId: LATENCY.id, source: ratioSource() }],
    });
    const alarm = alarmsByName(template)['test-api-latency-burn-fast-long'];
    const expressions = (alarm.Metrics as Array<Record<string, any>>)
      .filter((m) => m.Expression)
      .map((m) => m.Expression as string)
      .join(' ');
    expect(expressions).toContain(
      'IF(tot_fast_Long - good_fast_Long > 0, tot_fast_Long - good_fast_Long, 0)',
    );
  });

  it('uses a bad-event metric directly when that is what the emitter counts', () => {
    const { template } = makeStack({
      slos: [
        {
          sloId: LATENCY.id,
          source: ratioSource({ goodMetricName: undefined, badMetricName: 'RequestsSlow' }),
        },
      ],
    });
    const specs = JSON.parse(
      (
        resourceProps(template, 'AWS::Lambda::Function').find(
          (p) => p.FunctionName === 'test-slo-budget-reporter',
        ) as Record<string, any>
      ).Environment.Variables.SLO_SPECS,
    );
    expect(specs[0].badMetricNames).toEqual(['RequestsSlow']);
    expect(specs[0].goodMetricName).toBeUndefined();
  });

  it('rejects a source that counts both good and bad, or neither', () => {
    expect(() =>
      makeStack({
        slos: [{ sloId: LATENCY.id, source: ratioSource({ badMetricName: 'RequestsSlow' }) }],
      }),
    ).toThrow(/exactly one of goodMetricName or badMetricName \(got both\)/);

    expect(() =>
      makeStack({
        slos: [{ sloId: LATENCY.id, source: ratioSource({ goodMetricName: undefined }) }],
      }),
    ).toThrow(/\(got neither\)/);
  });

  it('rejects an undimensioned ratio source', () => {
    // An undimensioned metric in a shared namespace aggregates every service that
    // publishes it, so the SLI would measure the whole account.
    expect(() =>
      makeStack({ slos: [{ sloId: LATENCY.id, source: ratioSource({ dimensionsMap: {} }) }] }),
    ).toThrow(/has no dimensions/);
  });
});

describe('SloStack guards', () => {
  it('refuses an ALB source for a latency objective', () => {
    // ALB publishes no count of requests under a threshold, and a
    // TargetResponseTime percentile cannot be aggregated over a window into one.
    // The approximation — an alarm on p99 — reads in review exactly like an SLO.
    expect(() => makeStack({ slos: [{ sloId: LATENCY.id, source: ALB_SOURCE }] })).toThrow(
      /cannot use an 'alb' source[\s\S]*TargetResponseTime/,
    );
  });

  it('refuses to wire a proposed objective', () => {
    expect(() => makeStack({ slos: [{ sloId: PROPOSED.id, source: ALB_SOURCE }] })).toThrow(
      /status 'proposed' and must not be wired[\s\S]*correctness counter/,
    );
  });

  it('refuses an objective belonging to another environment', () => {
    // The alarm name would be right and the traffic behind it would be another
    // environment's — a mistake with no symptom until someone trusts the number.
    expect(() => makeStack({ envName: 'production' })).toThrow(
      /defined for environment 'test' but this stack is 'production'/,
    );
  });

  it('refuses an unknown objective id', () => {
    expect(() => makeStack({ slos: [{ sloId: 'not-an-slo', source: ALB_SOURCE }] })).toThrow(
      /No SLO definition with id 'not-an-slo'/,
    );
  });

  it('refuses the same objective twice', () => {
    expect(() =>
      makeStack({
        slos: [
          { sloId: AVAILABILITY.id, source: ALB_SOURCE },
          { sloId: AVAILABILITY.id, source: ALB_SOURCE },
        ],
      }),
    ).toThrow(/wired twice/);
  });

  it('refuses a stack with no objectives', () => {
    expect(() => makeStack({ slos: [] })).toThrow(/at least one objective/);
  });

  it('refuses a nonsensical report interval', () => {
    expect(() => makeStack({ reportIntervalMinutes: 0 })).toThrow(/positive whole number/);
    expect(() => makeStack({ reportIntervalMinutes: 2.5 })).toThrow(/positive whole number/);
  });

  it('refuses an invalid objective before it can synthesise an unreachable alarm', () => {
    const broken: SloDefinition = { ...AVAILABILITY, id: 'broken-slo', objective: 99.9 };
    expect(() =>
      makeStack({ catalogue: [broken], slos: [{ sloId: broken.id, source: ALB_SOURCE }] }),
    ).toThrow(/objective-out-of-range/);
  });
});

describe('SloStack dashboard, tags and outputs', () => {
  it('publishes a dashboard carrying the catalogue and the budget', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'test-slo',
    });
    const body = resourceProps(template, 'AWS::CloudWatch::Dashboard')[0].DashboardBody as string;
    const rendered = JSON.stringify(body);
    expect(rendered).toContain('test-api-availability');
    expect(rendered).toContain('platform-team');
    expect(rendered).toContain(SLO_METRICS.budgetRemainingPercent);
    // Valid and bad event counts are on the budget graph because the first
    // question about any budget number is how much traffic produced it.
    expect(rendered).toContain(SLO_METRICS.eventsObserved);
    expect(rendered).toContain(SLO_METRICS.badEvents);
  });

  it('exports the composite alarm names as readable strings', () => {
    // The names are exported so they can be pasted into a CodeDeploy deployment
    // group's alarm configuration; `alarm.alarmName` would export a Ref.
    const { template } = makeStack();
    const output = outputByExportName(template, 'test-slo-burn-alarm-names');
    expect(output?.Value).toBe(
      'test-api-availability-burn-fast,test-api-availability-burn-medium,test-api-availability-burn-slow',
    );
  });

  it('exports the objectives it measures', () => {
    const output = outputByExportName(makeStack().template, 'test-slo-objectives');
    expect(output?.Value).toBe('test-api-availability=99.9%/30d');
  });

  it('tags every resource with the environment and the stack id', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::SNS::Topic', {
      Tags: Match.arrayWith([
        { Key: 'Environment', Value: 'test' },
        { Key: 'Stack', Value: 'TestSloStack' },
      ]),
    });
  });

  it('builds alarms for several objectives in one stack', () => {
    const { template, stack } = makeStack({
      slos: [
        { sloId: AVAILABILITY.id, source: ALB_SOURCE },
        {
          sloId: LATENCY.id,
          source: {
            kind: 'ratio',
            namespace: 'AppSlo',
            totalMetricName: 'Requests',
            goodMetricName: 'RequestsFast',
            dimensionsMap: { Service: 'api' },
          },
        },
      ],
    });
    expect(stack.definitions.map((slo) => slo.id)).toEqual([AVAILABILITY.id, LATENCY.id]);
    expect(stack.burnRateAlarms).toHaveLength(6);
    // Three budget alarms per objective, six window alarms per objective, plus
    // the single reporter-errors alarm.
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2 * (6 + 3) + 1);
  });
});
