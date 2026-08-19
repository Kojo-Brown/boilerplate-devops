import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  DEPLOYMENT_EVENT_DETAIL_TYPE,
  DEPLOYMENT_EVENT_SOURCE,
  DORA_METRIC_NAMESPACE,
  DoraMetricsStack,
  DoraMetricsStackProps,
} from '../lib/dora-metrics-stack';
import { flattenIntrinsic, outputByExportName, resourceProps } from './support/cfn';

const makeStack = (overrides: Partial<DoraMetricsStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new DoraMetricsStack(app, 'TestDoraStack', {
    services: [
      { environment: 'production', service: 'api' },
      { environment: 'staging', service: 'api' },
    ],
    repository: 'example-org/example-repo',
    incidentAlarms: [
      { alarmName: 'production-alb-5xx-elb', environment: 'production', service: 'api' },
      { alarmName: 'production-ecs-cpu-high', environment: 'production', service: 'api' },
    ],
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

interface DashboardWidget {
  readonly type?: string;
  readonly properties?: {
    readonly title?: string;
    readonly markdown?: string;
    readonly metrics?: unknown[][];
    readonly annotations?: { horizontal?: { value?: number; label?: string }[] };
  };
}

/**
 * A dashboard body synthesizes as an Fn::Join because it embeds the region, so
 * Match.serializedJson can never match it. Flatten the join, then parse.
 */
const dashboardBody = (template: Template): { widgets: DashboardWidget[] } => {
  const bodies = resourceProps(template, 'AWS::CloudWatch::Dashboard').map(
    (props) => props.DashboardBody,
  );
  expect(bodies).toHaveLength(1);
  return JSON.parse(flattenIntrinsic(bodies[0]));
};

const widgetTitled = (template: Template, fragment: string): DashboardWidget => {
  const match = dashboardBody(template).widgets.find((w) =>
    (w.properties?.title ?? '').includes(fragment),
  );
  if (!match) throw new Error(`no widget titled like "${fragment}"`);
  return match;
};

/** Every `[namespace, metricName, ...dimensions]` tuple in one widget. */
const metricNames = (widget: DashboardWidget): string[] =>
  (widget.properties?.metrics ?? []).map((tuple) => String(tuple[1]));

describe('DoraMetricsStack', () => {
  describe('configuration guards', () => {
    it('refuses to build with no services', () => {
      expect(() => makeStack({ services: [] })).toThrow(/at least one service/);
    });

    // An empty resources list in an EventBridge pattern matches every alarm in
    // the account, which is the opposite of what an empty list looks like it
    // means. Failing at synth is the only place this is visible.
    it('refuses to build with no incident alarms rather than matching every alarm', () => {
      expect(() => makeStack({ incidentAlarms: [] })).toThrow(/at least one incident alarm/);
    });

    // The second mapping silently wins, so half the incidents land under a
    // service that never sees them.
    it('refuses to map one alarm to two services', () => {
      expect(() =>
        makeStack({
          incidentAlarms: [
            { alarmName: 'production-alb-5xx-elb', environment: 'production', service: 'api' },
            { alarmName: 'production-alb-5xx-elb', environment: 'production', service: 'worker' },
          ],
        }),
      ).toThrow(/mapped to more than one service/);
    });

    it('refuses a retention window shorter than the reporting window', () => {
      expect(() => makeStack({ windowDays: 90, retentionDays: 30 })).toThrow(
        /must exceed windowDays/,
      );
    });
  });

  describe('record store', () => {
    it('keys deployments and incidents by service and orders them by time', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('enables point-in-time recovery and TTL', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        SSESpecification: { SSEEnabled: true },
      });
    });

    // The attribution state is not reconstructible — the events that produced it
    // expired from EventBridge long ago.
    it('retains the table when the stack is deleted', () => {
      const { template } = makeStack();
      template.hasResource('AWS::DynamoDB::Table', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });
  });

  describe('event ingestion', () => {
    it('listens for deployment events from the deploy pipeline, not from ECS', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: [DEPLOYMENT_EVENT_SOURCE],
          'detail-type': [DEPLOYMENT_EVENT_DETAIL_TYPE],
        },
      });

      // aws.ecs and aws.codedeploy events carry no commit, and three of the four
      // keys are about the commit. Subscribing to them would look like more
      // coverage and produce lead times of zero.
      const patterns = resourceProps(template, 'AWS::Events::Rule').map((props) =>
        JSON.stringify(props.EventPattern ?? {}),
      );
      expect(patterns.some((p) => p.includes('aws.ecs'))).toBe(false);
      expect(patterns.some((p) => p.includes('aws.codedeploy'))).toBe(false);
    });

    it('scopes incident events to the named alarms', () => {
      const { template } = makeStack();
      const rules = resourceProps(template, 'AWS::Events::Rule');
      const incidentRule = rules.find((props) =>
        JSON.stringify(props.EventPattern ?? {}).includes('aws.cloudwatch'),
      );
      expect(incidentRule).toBeDefined();

      const pattern = incidentRule!.EventPattern as {
        resources: unknown[];
        detail: { state: { value: string[] } };
      };
      expect(pattern.resources).toHaveLength(2);
      expect(flattenIntrinsic(pattern.resources[0])).toContain('alarm:production-alb-5xx-elb');

      // INSUFFICIENT_DATA is deliberately absent: an alarm that lost its metric
      // is broken, not recovered, and treating it as OK would close incidents
      // that are still running.
      expect(pattern.detail.state.value).toEqual(['ALARM', 'OK']);
    });

    // A deployment event that fails to record is a permanently missing
    // datapoint. The aggregator, whose next run recomputes everything, does not
    // need one — and asserting the asymmetry keeps someone from "tidying" it.
    it('gives the recorder a dead letter queue and the aggregator none', () => {
      const { template } = makeStack();
      const functions = resourceProps(template, 'AWS::Lambda::Function');

      const recorder = functions.find((f) => String(f.Description).includes('deployment and incident'));
      const aggregator = functions.find((f) => String(f.Description).includes('deployment frequency'));
      expect(recorder).toBeDefined();
      expect(aggregator).toBeDefined();

      expect(recorder!.DeadLetterConfig).toBeDefined();
      expect(aggregator!.DeadLetterConfig).toBeUndefined();

      // KMS rather than SSE-SQS: both encrypt at rest, but only KmsMasterKeyId
      // satisfies CKV_AWS_27, and the alias means there is no key to rotate.
      const queues = resourceProps(template, 'AWS::SQS::Queue');
      expect(queues).toHaveLength(1);
      expect(flattenIntrinsic(queues[0].KmsMasterKeyId)).toContain('alias/aws/sqs');
    });

    it('retries the recorder and dead-letters the event when it still fails', () => {
      const { template } = makeStack();
      const rules = template.findResources('AWS::Events::Rule');
      const targets = Object.values(rules).flatMap(
        (rule) => (rule.Properties as { Targets?: Record<string, unknown>[] }).Targets ?? [],
      );
      const withRetry = targets.filter((t) => t.RetryPolicy !== undefined);
      expect(withRetry.length).toBe(2);
      for (const target of withRetry) {
        expect(target.RetryPolicy).toEqual({ MaximumRetryAttempts: 3 });
        expect(target.DeadLetterConfig).toBeDefined();
      }
    });
  });

  describe('permissions', () => {
    it('confines both roles to the DORA metric namespace', () => {
      const { template } = makeStack();
      const statements = resourceProps(template, 'AWS::IAM::Policy').flatMap(
        (props) =>
          (props.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement ?? [],
      );
      const putMetric = statements.filter((s) =>
        JSON.stringify(s.Action ?? '').includes('cloudwatch:PutMetricData'),
      );
      expect(putMetric).toHaveLength(2);
      for (const statement of putMetric) {
        expect(statement.Condition).toEqual({
          StringEquals: { 'cloudwatch:namespace': DORA_METRIC_NAMESPACE },
        });
      }
    });

    // Deleting a deployment record is how a change failure rate gets quietly
    // improved, and neither handler has a reason to. `grantReadWriteData` would
    // have handed over DeleteItem and Scan along with the rest.
    it('grants each handler only the DynamoDB actions it calls', () => {
      const { template } = makeStack();
      const byStatement = new Map<string, string[]>();
      for (const props of resourceProps(template, 'AWS::IAM::Policy')) {
        const doc = props.PolicyDocument as { Statement: Record<string, unknown>[] };
        for (const statement of doc.Statement ?? []) {
          if (typeof statement.Sid !== 'string') continue;
          const actions = statement.Action;
          byStatement.set(statement.Sid, Array.isArray(actions) ? actions : [String(actions)]);
        }
      }

      expect(byStatement.get('RecordDoraEvents')).toEqual([
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:Query',
      ]);
      // The aggregator derives the rates; a bug in that arithmetic must not be
      // able to rewrite the history it derives them from.
      expect(byStatement.get('ReadDoraEvents')).toEqual(['dynamodb:Query']);

      const allDynamoActions = resourceProps(template, 'AWS::IAM::Policy')
        .flatMap(
          (props) =>
            (props.PolicyDocument as { Statement: Record<string, unknown>[] }).Statement ?? [],
        )
        .flatMap((statement) => {
          const actions = statement.Action;
          return Array.isArray(actions) ? actions.map(String) : [String(actions)];
        })
        .filter((action) => action.startsWith('dynamodb:'));
      expect(allDynamoActions).not.toContain('dynamodb:DeleteItem');
      expect(allDynamoActions).not.toContain('dynamodb:Scan');
    });

    it('grants Secrets Manager access only when a token secret is configured', () => {
      const withoutToken = makeStack().template;
      expect(JSON.stringify(withoutToken.toJSON())).not.toContain('secretsmanager:GetSecretValue');

      const withToken = makeStack({
        githubTokenSecretArn:
          'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-dora-github-token',
      }).template;
      withToken.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'secretsmanager:GetSecretValue',
              Resource:
                'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-dora-github-token',
            }),
          ]),
        }),
      });
    });
  });

  describe('handler configuration', () => {
    it('passes the attribution window to both handlers so they cannot disagree', () => {
      const { template } = makeStack({ attributionWindowMinutes: 45 });
      const environments = resourceProps(template, 'AWS::Lambda::Function')
        .map((props) => props.Environment as { Variables?: Record<string, unknown> } | undefined)
        .filter((env): env is { Variables: Record<string, unknown> } => env?.Variables !== undefined)
        .map((env) => env.Variables);

      const windows = environments
        .map((vars) => vars.ATTRIBUTION_WINDOW_MINUTES)
        .filter((value) => value !== undefined);
      expect(windows).toEqual(['45', '45']);
    });

    // An empty string rather than an absent variable: the handler branches on
    // truthiness, and an undefined lookup and an empty one must behave alike.
    it('leaves the token variable empty rather than unset when no secret is given', () => {
      const { template } = makeStack();
      const recorder = resourceProps(template, 'AWS::Lambda::Function').find((f) =>
        String(f.Description).includes('deployment and incident'),
      );
      const vars = (recorder!.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(vars.GITHUB_TOKEN_SECRET_ARN).toBe('');
      expect(vars.REPOSITORY).toBe('example-org/example-repo');
    });

    it('serialises the service list for the aggregator', () => {
      const { template } = makeStack();
      const aggregator = resourceProps(template, 'AWS::Lambda::Function').find((f) =>
        String(f.Description).includes('deployment frequency'),
      );
      const vars = (aggregator!.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(JSON.parse(String(vars.SERVICES))).toEqual([
        { environment: 'production', service: 'api' },
        { environment: 'staging', service: 'api' },
      ]);
    });
  });

  describe('measurement-health alarm', () => {
    // The failure mode this guards is not a bad score but a score that stopped
    // being a measurement. A missing line on a graph reads as "nothing
    // happened".
    it('alarms when lead time stops being resolvable', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'LeadTimeUnmeasurable',
        Namespace: DORA_METRIC_NAMESPACE,
        ComparisonOperator: 'GreaterThanThreshold',
        Threshold: 0,
        EvaluationPeriods: 2,
        DatapointsToAlarm: 2,
        TreatMissingData: 'notBreaching',
      });
    });

    it('publishes the alarm to a topic', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
      const alarms = resourceProps(template, 'AWS::CloudWatch::Alarm');
      expect(alarms).toHaveLength(1);
      expect(alarms[0].AlarmActions).toHaveLength(1);
    });
  });

  describe('dashboard', () => {
    it('graphs all four keys', () => {
      const { template } = makeStack();
      const titles = dashboardBody(template)
        .widgets.map((w) => w.properties?.title ?? '')
        .filter(Boolean);

      expect(titles.some((t) => t.startsWith('Deployment frequency'))).toBe(true);
      expect(titles.some((t) => t.startsWith('Lead time for changes'))).toBe(true);
      expect(titles.some((t) => t.startsWith('Change failure rate'))).toBe(true);
      expect(titles.some((t) => t.startsWith('Failed deployment recovery time'))).toBe(true);
    });

    // A lead time series built from the deployed commit alone is a deploy
    // duration. Showing it beside the real measurement is the only way a team
    // that squash-merges without sending the PR number ever finds out.
    it('keeps the two lead-time sources as separate series', () => {
      const { template } = makeStack();
      const widget = widgetTitled(template, 'Lead time for changes');
      const sources = (widget.properties?.metrics ?? []).map((tuple) => {
        const index = tuple.indexOf('Source');
        return index === -1 ? undefined : tuple[index + 1];
      });
      expect(sources).toContain('pullRequest');
      expect(sources).toContain('headCommit');
    });

    it('graphs lead time and recovery at p50 and p90 rather than as a mean', () => {
      const { template } = makeStack();
      for (const title of ['Lead time for changes', 'Failed deployment recovery time']) {
        const widget = widgetTitled(template, title);
        const stats = (widget.properties?.metrics ?? []).map(
          (tuple) => (tuple[tuple.length - 1] as { stat?: string }).stat,
        );
        expect(stats).toContain('p50');
        expect(stats).toContain('p90');
        expect(stats).not.toContain('Average');
      }
    });

    // 0% over two ripe deployments and 0% over two hundred render identically.
    it('shows the sample size the change failure rate is computed over', () => {
      const { template } = makeStack();
      const widget = widgetTitled(template, 'Measurement coverage');
      expect(metricNames(widget)).toEqual(
        expect.arrayContaining(['RipeDeployments', 'UnripeDeployments', 'Incidents']),
      );
    });

    it('annotates each key with its elite threshold', () => {
      const { template } = makeStack();
      const annotationValues = (title: string) =>
        (widgetTitled(template, title).properties?.annotations?.horizontal ?? []).map(
          (a) => a.value,
        );

      expect(annotationValues('Deployment frequency')).toEqual([1]);
      expect(annotationValues('Lead time for changes')).toEqual([86400]);
      expect(annotationValues('Change failure rate')).toEqual([5]);
      expect(annotationValues('Failed deployment recovery time')).toEqual([3600]);
    });

    it('lets a team draw its own targets instead of the industry cohort', () => {
      const { template } = makeStack({
        thresholds: {
          eliteDeploymentsPerDay: 4,
          eliteLeadTimeSeconds: 3600,
          eliteChangeFailurePercent: 2,
          eliteRecoveryTimeSeconds: 900,
        },
      });
      const values = (title: string) =>
        (widgetTitled(template, title).properties?.annotations?.horizontal ?? []).map(
          (a) => a.value,
        );
      expect(values('Deployment frequency')).toEqual([4]);
      expect(values('Lead time for changes')).toEqual([3600]);
      expect(values('Change failure rate')).toEqual([2]);
      expect(values('Failed deployment recovery time')).toEqual([900]);
    });

    it('states the exclusions on the dashboard itself', () => {
      const { template } = makeStack({ attributionWindowMinutes: 90 });
      const notes = dashboardBody(template).widgets.find((w) => w.type === 'text');
      expect(notes).toBeDefined();
      const markdown = notes!.properties?.markdown ?? '';
      expect(markdown).toContain('older than 90 minutes');
      expect(markdown).toContain('no rate is');
    });
  });

  describe('outputs', () => {
    it('publishes the event source the deploy pipeline has to use', () => {
      const { template } = makeStack();
      const output = outputByExportName(template, 'TestDoraStack-deployment-event-source');
      expect(output?.Value).toBe(DEPLOYMENT_EVENT_SOURCE);
    });

    it('publishes the dead letter queue as the place holes in the metrics land', () => {
      const { template } = makeStack();
      expect(outputByExportName(template, 'TestDoraStack-recorder-dlq')).toBeDefined();
    });
  });

  describe('portability', () => {
    // Everything in this repository is copied into someone else's account.
    it('embeds no literal account id or region in the alarm ARNs', () => {
      const app = new cdk.App();
      const stack = new DoraMetricsStack(app, 'PortableDoraStack', {
        services: [{ environment: 'production', service: 'api' }],
        repository: 'example-org/example-repo',
        incidentAlarms: [
          { alarmName: 'production-alb-5xx-elb', environment: 'production', service: 'api' },
        ],
      });
      const rendered = JSON.stringify(Template.fromStack(stack).toJSON());
      expect(rendered).not.toMatch(/\d{12}/);
    });
  });
});
