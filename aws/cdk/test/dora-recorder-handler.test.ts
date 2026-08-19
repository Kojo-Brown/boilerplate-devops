import {
  DEPLOYMENT_EVENT_DETAIL_TYPE,
  DEPLOYMENT_EVENT_SOURCE,
  DORA_RECORDER_SOURCE,
} from '../lib/dora-metrics-stack';

/**
 * Behavioural tests for the inline recorder.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing else in the build
 * parses it: `tsc` sees a template literal and `cdk synth` embeds it verbatim.
 * Every mistake available inside it is silent and flattering — a lead time read
 * from the squash commit, a duplicate event counted twice, an incident blamed on
 * a deployment six hours older than it — and each produces a dashboard that
 * looks fine. So the handler is compiled and run against recording stubs rather
 * than asserted on as text.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = (event: unknown) => Promise<any>;

class ConditionalCheckFailed extends Error {
  override readonly name = 'ConditionalCheckFailedException';
}

const makeSdkModule = (
  commandNames: string[],
  clientNames: string[],
  calls: SdkCall[],
  responder: (call: SdkCall) => unknown,
) => {
  const module: Record<string, unknown> = {};

  for (const name of commandNames) {
    module[name] = class {
      readonly __name = name;
      constructor(readonly input: Record<string, any>) {}
    };
  }

  for (const clientName of clientNames) {
    module[clientName] = class {
      async send(command: { __name: string; input: Record<string, any> }) {
        const call = { command: command.__name, input: command.input };
        calls.push(call);
        const result = responder(call);
        if (result instanceof Error) throw result;
        return result;
      }
    };
  }

  return module;
};

const ENV = {
  AWS_REGION: 'us-east-1',
  TABLE_NAME: 'dora-events',
  METRIC_NAMESPACE: 'DORA',
  REPOSITORY: 'example-org/example-repo',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_TOKEN_SECRET_ARN:
    'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-dora-github-token',
  ATTRIBUTION_WINDOW_MINUTES: '60',
  FLAP_WINDOW_SECONDS: '300',
  RETENTION_DAYS: '400',
  INCIDENT_ALARMS: JSON.stringify({
    'production-alb-5xx-elb': { environment: 'production', service: 'api' },
    'production-api-latency': { environment: 'production', service: 'api' },
    'staging-checkout-errors': { environment: 'staging', service: 'checkout' },
  }),
};

const S = (value: string) => ({ S: value });
const N = (value: number) => ({ N: String(value) });

/** A DynamoDB deployment record, as the handler writes and reads them. */
const deployRecord = (overrides: Record<string, any> = {}) => ({
  pk: S('DEPLOY#production#api'),
  sk: S('2026-08-17T12:00:00.000Z#deploy-1'),
  recordType: S('deployment'),
  deploymentId: S('deploy-1'),
  environment: S('production'),
  service: S('api'),
  outcome: S('succeeded'),
  deployedAt: N(Date.parse('2026-08-17T12:00:00.000Z')),
  failureAttributed: { BOOL: false },
  ...overrides,
});

const incidentRecord = (overrides: Record<string, any> = {}) => ({
  pk: S('INCIDENT#production#api'),
  sk: S('2026-08-17T12:10:00.000Z#production-alb-5xx-elb'),
  recordType: S('incident'),
  alarmName: S('production-alb-5xx-elb'),
  environment: S('production'),
  service: S('api'),
  status: S('open'),
  startedAt: N(Date.parse('2026-08-17T12:10:00.000Z')),
  attribution: S('deployment'),
  ...overrides,
});

interface RunOptions {
  /** Items returned by every Query, in the order the handler issues them. */
  readonly queryResults?: Record<string, any>[][];
  /** Make the next PutItem fail its condition, i.e. the key already exists. */
  readonly putConflicts?: boolean;
  /** Responses keyed by request path; an Error value is thrown. */
  readonly github?: Record<string, unknown>;
  /** Fail every GitHub call. */
  readonly githubDown?: boolean;
  readonly env?: Partial<typeof ENV>;
}

interface RunResult {
  readonly result: any;
  readonly calls: SdkCall[];
  readonly fetches: string[];
  readonly puts: SdkCall[];
  readonly updates: SdkCall[];
  /** Every metric datum published, flattened across PutMetricData calls. */
  readonly metrics: {
    name: string;
    value: number;
    unit: string;
    dimensions: Record<string, string>;
    timestamp: Date;
  }[];
}

const run = async (event: unknown, options: RunOptions = {}): Promise<RunResult> => {
  const calls: SdkCall[] = [];
  const queryResults = [...(options.queryResults ?? [])];
  const fetches: string[] = [];

  const responder = (call: SdkCall): unknown => {
    switch (call.command) {
      case 'QueryCommand':
        return { Items: queryResults.shift() ?? [] };
      case 'PutItemCommand':
        return options.putConflicts ? new ConditionalCheckFailed('exists') : {};
      case 'UpdateItemCommand':
        return {};
      case 'PutMetricDataCommand':
        return {};
      case 'GetSecretValueCommand':
        return { SecretString: JSON.stringify({ token: 'mock-github-token' }) };
      default:
        throw new Error(`unstubbed command ${call.command}`);
    }
  };

  const modules: Record<string, unknown> = {
    '@aws-sdk/client-dynamodb': makeSdkModule(
      ['PutItemCommand', 'QueryCommand', 'UpdateItemCommand'],
      ['DynamoDBClient'],
      calls,
      responder,
    ),
    '@aws-sdk/client-cloudwatch': makeSdkModule(
      ['PutMetricDataCommand'],
      ['CloudWatchClient'],
      calls,
      responder,
    ),
    '@aws-sdk/client-secrets-manager': makeSdkModule(
      ['GetSecretValueCommand'],
      ['SecretsManagerClient'],
      calls,
      responder,
    ),
  };

  const fakeFetch = async (url: string) => {
    const path = url.replace(ENV.GITHUB_API_URL, '');
    fetches.push(path);
    if (options.githubDown) return { ok: false, status: 503, json: async () => ({}) };
    const body = (options.github ?? {})[path];
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };

  const exports_: Record<string, any> = {};
  const factory = new Function(
    'exports',
    'require',
    'process',
    'console',
    'fetch',
    DORA_RECORDER_SOURCE,
  );
  factory(
    exports_,
    (name: string) => {
      const module = modules[name];
      if (!module) throw new Error(`unstubbed module ${name}`);
      return module;
    },
    { env: { ...ENV, ...options.env } },
    { info: () => undefined, warn: () => undefined, error: () => undefined },
    fakeFetch,
  );

  const handler = exports_.handler as Handler;
  const result = await handler(event);

  const metrics = calls
    .filter((call) => call.command === 'PutMetricDataCommand')
    .flatMap((call) => call.input.MetricData as Record<string, any>[])
    .map((datum) => ({
      name: datum.MetricName as string,
      value: datum.Value as number,
      unit: datum.Unit as string,
      dimensions: Object.fromEntries(
        ((datum.Dimensions ?? []) as { Name: string; Value: string }[]).map((d) => [
          d.Name,
          d.Value,
        ]),
      ),
      timestamp: datum.Timestamp as Date,
    }));

  return {
    result,
    calls,
    fetches,
    metrics,
    puts: calls.filter((c) => c.command === 'PutItemCommand'),
    updates: calls.filter((c) => c.command === 'UpdateItemCommand'),
  };
};

const deploymentEvent = (detail: Record<string, unknown> = {}) => ({
  source: DEPLOYMENT_EVENT_SOURCE,
  'detail-type': DEPLOYMENT_EVENT_DETAIL_TYPE,
  time: '2026-08-17T12:00:00Z',
  detail: {
    environment: 'production',
    service: 'api',
    commitSha: '9f1c0de5b4a37821cc6d1ee4b0f9a2d3c5e78190',
    deploymentId: 'deploy-1',
    outcome: 'succeeded',
    ...detail,
  },
});

const alarmEvent = (state: 'ALARM' | 'OK', overrides: Record<string, unknown> = {}) => ({
  source: 'aws.cloudwatch',
  'detail-type': 'CloudWatch Alarm State Change',
  time: '2026-08-17T12:10:00Z',
  detail: {
    alarmName: 'production-alb-5xx-elb',
    state: { value: state, timestamp: '2026-08-17T12:10:00.000Z' },
    ...overrides,
  },
});

/** Pull request commits, oldest first, as the GitHub API returns them. */
const prCommits = (...authorDates: string[]) =>
  authorDates.map((date) => ({ commit: { author: { date } } }));

const PR_COMMITS_PATH = '/repos/example-org/example-repo/pulls/42/commits?per_page=100';
const HEAD_COMMIT_PATH =
  '/repos/example-org/example-repo/commits/9f1c0de5b4a37821cc6d1ee4b0f9a2d3c5e78190';

describe('DORA recorder — deployments', () => {
  it('records the deployment and counts it', async () => {
    const { puts, metrics } = await run(deploymentEvent(), {
      github: { [HEAD_COMMIT_PATH]: { commit: { author: { date: '2026-08-17T11:00:00Z' } } } },
    });

    expect(puts).toHaveLength(1);
    expect(puts[0].input.Item.pk.S).toBe('DEPLOY#production#api');
    expect(puts[0].input.Item.outcome.S).toBe('succeeded');

    const deployments = metrics.filter((m) => m.name === 'Deployments');
    expect(deployments).toHaveLength(1);
    expect(deployments[0].dimensions).toEqual({
      Environment: 'production',
      Service: 'api',
      Outcome: 'succeeded',
    });
  });

  // EventBridge delivers at least once, and the retry path can redeliver after
  // a partial failure. Deployment frequency is a count, so one duplicate is one
  // phantom deploy.
  it('ignores a redelivered deployment event instead of counting it twice', async () => {
    const { result, metrics } = await run(deploymentEvent(), {
      putConflicts: true,
      github: { [HEAD_COMMIT_PATH]: { commit: { author: { date: '2026-08-17T11:00:00Z' } } } },
    });

    expect(result).toEqual({ duplicate: true });
    expect(metrics).toHaveLength(0);
  });

  // Stamping a late redelivery with the current clock would report this
  // morning's deployment as happening now, and its lead time as hours longer.
  it('uses the event timestamp rather than the clock', async () => {
    const { puts, metrics } = await run(
      deploymentEvent({ deployedAt: '2026-08-17T09:30:00.000Z' }),
      { github: { [HEAD_COMMIT_PATH]: { commit: { author: { date: '2026-08-17T09:00:00Z' } } } } },
    );

    expect(puts[0].input.Item.deployedAt.N).toBe(String(Date.parse('2026-08-17T09:30:00.000Z')));
    expect(puts[0].input.Item.sk.S).toBe('2026-08-17T09:30:00.000Z#deploy-1');
    expect(metrics[0].timestamp).toEqual(new Date('2026-08-17T09:30:00.000Z'));
  });

  it('rejects an unparseable timestamp rather than recording a deployment at NaN', async () => {
    await expect(run(deploymentEvent({ deployedAt: 'yesterday' }))).rejects.toThrow(
      /unparseable timestamp/,
    );
  });

  it('sets a TTL beyond the reporting window', async () => {
    const { puts } = await run(deploymentEvent(), { githubDown: true });
    const deployedAt = Date.parse('2026-08-17T12:00:00Z') / 1000;
    expect(Number(puts[0].input.Item.expiresAt.N)).toBe(deployedAt + 400 * 24 * 60 * 60);
  });
});

describe('DORA recorder — lead time', () => {
  // The whole point. Under squash merge the deployed commit is authored at
  // merge time, so measuring from it turns lead time into pipeline duration.
  it('measures from the first commit on the branch, not the squash commit', async () => {
    const { metrics, fetches } = await run(deploymentEvent({ pullRequestNumber: 42 }), {
      github: {
        [PR_COMMITS_PATH]: prCommits(
          '2026-08-14T12:00:00Z',
          '2026-08-15T09:00:00Z',
          '2026-08-16T17:00:00Z',
        ),
      },
    });

    expect(fetches).toContain(PR_COMMITS_PATH);
    const leadTime = metrics.find((m) => m.name === 'LeadTimeSeconds');
    expect(leadTime).toBeDefined();
    // 2026-08-14T12:00 → 2026-08-17T12:00 is three days, not the minutes the
    // squashed commit would have given.
    expect(leadTime!.value).toBe(3 * 24 * 60 * 60);
    expect(leadTime!.dimensions.Source).toBe('pullRequest');
    expect(leadTime!.unit).toBe('Seconds');
  });

  it('never falls back to the deployed commit when a pull request answered', async () => {
    const { fetches } = await run(deploymentEvent({ pullRequestNumber: 42 }), {
      github: { [PR_COMMITS_PATH]: prCommits('2026-08-16T12:00:00Z') },
    });
    expect(fetches).not.toContain(HEAD_COMMIT_PATH);
  });

  // Kept as a distinct series so a team that squash-merges without sending the
  // pull request number can see that its "lead time" is a deploy duration.
  it('labels a head-commit measurement as such instead of merging the series', async () => {
    const { metrics } = await run(deploymentEvent(), {
      github: { [HEAD_COMMIT_PATH]: { commit: { author: { date: '2026-08-17T11:45:00Z' } } } },
    });

    const leadTime = metrics.find((m) => m.name === 'LeadTimeSeconds');
    expect(leadTime!.dimensions.Source).toBe('headCommit');
    expect(leadTime!.value).toBe(15 * 60);
  });

  // A zero lead time is the best score the metric can take, so an unknown one
  // must never be published as zero.
  it('reports an unmeasurable lead time rather than a zero one', async () => {
    const { metrics } = await run(deploymentEvent(), { githubDown: true });

    expect(metrics.find((m) => m.name === 'LeadTimeSeconds')).toBeUndefined();
    const unmeasurable = metrics.find((m) => m.name === 'LeadTimeUnmeasurable');
    expect(unmeasurable).toBeDefined();
    expect(unmeasurable!.value).toBe(1);
    // The deployment itself still counts — three of the four keys do not need
    // GitHub at all.
    expect(metrics.find((m) => m.name === 'Deployments')).toBeDefined();
  });

  it('records the deployment even when GitHub is unreachable', async () => {
    const { puts, result } = await run(deploymentEvent({ pullRequestNumber: 42 }), {
      githubDown: true,
    });
    expect(puts).toHaveLength(1);
    expect(result.recorded).toBe(true);
    expect(puts[0].input.Item.leadTimeSeconds).toBeUndefined();
  });

  it('treats a commit authored after its own deployment as unmeasurable', async () => {
    const { metrics } = await run(deploymentEvent({ pullRequestNumber: 42 }), {
      github: { [PR_COMMITS_PATH]: prCommits('2026-08-18T12:00:00Z') },
    });

    expect(metrics.find((m) => m.name === 'LeadTimeSeconds')).toBeUndefined();
    expect(metrics.find((m) => m.name === 'LeadTimeUnmeasurable')).toBeDefined();
  });

  it('skips GitHub entirely when no token secret is configured', async () => {
    const { fetches, metrics } = await run(deploymentEvent({ pullRequestNumber: 42 }), {
      env: { GITHUB_TOKEN_SECRET_ARN: '' },
    });

    expect(fetches).toHaveLength(0);
    expect(metrics.find((m) => m.name === 'LeadTimeUnmeasurable')).toBeDefined();
  });

  // A failed deployment did not reach production, so there is nothing whose
  // lead time could have elapsed.
  it('does not compute a lead time for a failed deployment', async () => {
    const { metrics, fetches } = await run(deploymentEvent({ outcome: 'failed' }), {
      github: { [HEAD_COMMIT_PATH]: { commit: { author: { date: '2026-08-17T11:00:00Z' } } } },
    });

    expect(fetches).toHaveLength(0);
    expect(metrics.find((m) => m.name === 'LeadTimeSeconds')).toBeUndefined();
    expect(metrics.find((m) => m.name === 'LeadTimeUnmeasurable')).toBeUndefined();
    expect(metrics.find((m) => m.name === 'Deployments')!.dimensions.Outcome).toBe('failed');
  });
});

describe('DORA recorder — incident attribution', () => {
  it('blames the deployment that preceded the incident and marks it failed', async () => {
    const { result, updates, metrics } = await run(alarmEvent('ALARM'), {
      queryResults: [
        [], // no previous incident for this alarm
        [deployRecord()], // deployed at 12:00, alarm at 12:10
      ],
    });

    expect(result.attribution).toBe('deployment');
    expect(updates).toHaveLength(1);
    expect(updates[0].input.Key.sk.S).toBe('2026-08-17T12:00:00.000Z#deploy-1');
    expect(updates[0].input.UpdateExpression).toContain('failureAttributed');

    const incident = metrics.find((m) => m.name === 'Incidents');
    expect(incident!.dimensions.Attribution).toBe('deployment');
  });

  // A certificate that expires on a Sunday is an incident, not a failed
  // deployment. Counting all incidents against deployments makes change failure
  // rate rise when the deploy cadence falls.
  it('does not blame a deployment older than the attribution window', async () => {
    const { result, updates, metrics } = await run(alarmEvent('ALARM'), {
      queryResults: [
        [],
        [
          deployRecord({
            sk: S('2026-08-17T04:00:00.000Z#deploy-0'),
            deploymentId: S('deploy-0'),
            deployedAt: N(Date.parse('2026-08-17T04:00:00.000Z')),
          }),
        ],
      ],
    });

    expect(result.attribution).toBe('unattributed');
    expect(updates).toHaveLength(0);
    expect(metrics.find((m) => m.name === 'Incidents')!.dimensions.Attribution).toBe(
      'unattributed',
    );
  });

  it('records an incident with no deployment behind it at all', async () => {
    const { result, puts } = await run(alarmEvent('ALARM'), { queryResults: [[], []] });

    expect(result.attribution).toBe('unattributed');
    expect(puts[0].input.Item.deploymentId).toBeUndefined();
  });

  // A deployment that failed never reached production, so the code running is
  // still the previous release's.
  it('skips past failed deployments to the last one that actually shipped', async () => {
    const { result, updates } = await run(alarmEvent('ALARM'), {
      queryResults: [
        [],
        [
          deployRecord({
            sk: S('2026-08-17T12:05:00.000Z#deploy-2'),
            deploymentId: S('deploy-2'),
            outcome: S('failed'),
            deployedAt: N(Date.parse('2026-08-17T12:05:00.000Z')),
          }),
          deployRecord(),
        ],
      ],
    });

    expect(result.attribution).toBe('deployment');
    expect(updates[0].input.Key.sk.S).toBe('2026-08-17T12:00:00.000Z#deploy-1');
  });

  // The flag lives on the deployment, so a bad deploy that trips three alarms
  // is one change failure. Change failure rate asks what fraction of
  // deployments failed, not how many alarms rang.
  it('marks the deployment rather than counting alarms', async () => {
    const { updates } = await run(alarmEvent('ALARM', { alarmName: 'production-api-latency' }), {
      queryResults: [[], [deployRecord({ failureAttributed: { BOOL: true } })]],
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].input.UpdateExpression).toBe('SET failureAttributed = :true');
  });

  it('ignores a redelivered ALARM transition', async () => {
    const { result, updates } = await run(alarmEvent('ALARM'), {
      queryResults: [[], [deployRecord()]],
      putConflicts: true,
    });

    expect(result).toEqual({ duplicate: true });
    expect(updates).toHaveLength(0);
  });
});

describe('DORA recorder — recovery time', () => {
  it('measures recovery from the incident start to the alarm clearing', async () => {
    const { result, metrics } = await run(alarmEvent('OK', { state: { value: 'OK', timestamp: '2026-08-17T12:40:00.000Z' } }), {
      queryResults: [[incidentRecord()]],
    });

    expect(result.resolved).toBe(true);
    const recovery = metrics.find((m) => m.name === 'RecoveryTimeSeconds');
    expect(recovery!.value).toBe(30 * 60);
    expect(recovery!.dimensions.Attribution).toBe('deployment');
    expect(recovery!.unit).toBe('Seconds');
  });

  it('keeps unattributed recovery on its own series', async () => {
    const { metrics } = await run(
      alarmEvent('OK', { state: { value: 'OK', timestamp: '2026-08-17T12:40:00.000Z' } }),
      { queryResults: [[incidentRecord({ attribution: S('unattributed') })]] },
    );

    expect(metrics.find((m) => m.name === 'RecoveryTimeSeconds')!.dimensions.Attribution).toBe(
      'unattributed',
    );
  });

  // Recording a recovery here would invent an incident whose start is unknown,
  // and an invented start produces an arbitrary duration.
  it('does nothing when an alarm clears with no open incident behind it', async () => {
    const { result, metrics, updates } = await run(alarmEvent('OK'), { queryResults: [[]] });

    expect(result).toEqual({ noOpenIncident: true });
    expect(updates).toHaveLength(0);
    expect(metrics).toHaveLength(0);
  });

  it('ignores an OK for an alarm whose incident is already resolved', async () => {
    const { result } = await run(alarmEvent('OK'), {
      queryResults: [[incidentRecord({ status: S('resolved') })]],
    });
    expect(result).toEqual({ noOpenIncident: true });
  });

  // A service usually has several alarms, and they overlap. Closing whichever
  // incident happens to be newest would leave the other open forever.
  it('closes the incident raised by the same alarm, not merely the newest one', async () => {
    const { updates } = await run(
      alarmEvent('OK', {
        alarmName: 'production-api-latency',
        state: { value: 'OK', timestamp: '2026-08-17T12:40:00.000Z' },
      }),
      {
        queryResults: [
          [
            incidentRecord({
              sk: S('2026-08-17T12:20:00.000Z#production-api-alb-5xx'),
              alarmName: S('production-alb-5xx-elb'),
            }),
            incidentRecord({
              sk: S('2026-08-17T12:05:00.000Z#production-api-latency'),
              alarmName: S('production-api-latency'),
              startedAt: N(Date.parse('2026-08-17T12:05:00.000Z')),
            }),
          ],
        ],
      },
    );

    expect(updates[0].input.Key.sk.S).toBe('2026-08-17T12:05:00.000Z#production-api-latency');
  });
});

describe('DORA recorder — flapping alarms', () => {
  // Six oscillations in five minutes would otherwise report six failures each
  // recovering in seconds, pushing change failure rate up and recovery time
  // down at the same time.
  it('continues the incident an alarm just closed rather than opening a new one', async () => {
    const { result, puts, updates, metrics } = await run(
      alarmEvent('ALARM', { state: { value: 'ALARM', timestamp: '2026-08-17T12:42:00.000Z' } }),
      {
        queryResults: [
          [
            incidentRecord({
              status: S('resolved'),
              resolvedAt: N(Date.parse('2026-08-17T12:40:00.000Z')),
              recoveryTimeSeconds: N(1800),
            }),
          ],
        ],
      },
    );

    expect(result.reopened).toBe(true);
    expect(puts).toHaveLength(0);
    expect(updates[0].input.UpdateExpression).toContain('REMOVE resolvedAt');
    // No second Incidents datapoint: it is the same incident.
    expect(metrics).toHaveLength(0);
  });

  it('opens a new incident once the alarm has been quiet past the flap window', async () => {
    const { result, puts } = await run(
      alarmEvent('ALARM', { state: { value: 'ALARM', timestamp: '2026-08-17T12:50:00.000Z' } }),
      {
        queryResults: [
          [
            incidentRecord({
              status: S('resolved'),
              resolvedAt: N(Date.parse('2026-08-17T12:40:00.000Z')),
            }),
          ],
          [deployRecord()],
        ],
      },
    );

    expect(result.opened).toBe(true);
    expect(puts).toHaveLength(1);
  });

  // The documented artefact of merging retroactively: the close that is about
  // to be undone already published its datapoint, and CloudWatch cannot retract
  // one. Pinned so the behaviour stays a disclosed limitation rather than
  // becoming a surprise — see docs/dora-metrics.md.
  it('leaves the superseded short recovery reading behind but not a second incident', async () => {
    const firstClose = await run(
      alarmEvent('OK', { state: { value: 'OK', timestamp: '2026-08-17T12:12:00.000Z' } }),
      { queryResults: [[incidentRecord()]] },
    );
    expect(firstClose.metrics.map((m) => m.name)).toEqual(['RecoveryTimeSeconds']);

    const reopen = await run(
      alarmEvent('ALARM', { state: { value: 'ALARM', timestamp: '2026-08-17T12:13:00.000Z' } }),
      {
        queryResults: [
          [
            incidentRecord({
              status: S('resolved'),
              resolvedAt: N(Date.parse('2026-08-17T12:12:00.000Z')),
            }),
          ],
        ],
      },
    );
    // The count the change failure rate is built on stays correct: no second
    // incident, and no second deployment marked failed.
    expect(reopen.metrics).toHaveLength(0);
    expect(reopen.puts).toHaveLength(0);
  });

  // Reopening reruns the clock from the original start, so the recovery time
  // covers the whole episode rather than the last oscillation.
  it('measures recovery of a reopened incident from its original start', async () => {
    const { metrics } = await run(
      alarmEvent('OK', { state: { value: 'OK', timestamp: '2026-08-17T13:10:00.000Z' } }),
      {
        queryResults: [
          [incidentRecord({ status: S('open'), reopenCount: N(1) })],
        ],
      },
    );

    expect(metrics.find((m) => m.name === 'RecoveryTimeSeconds')!.value).toBe(60 * 60);
  });
});

describe('DORA recorder — routing', () => {
  it('files the incident under the service the alarm is declared against', async () => {
    const { puts } = await run(
      alarmEvent('ALARM', { alarmName: 'staging-checkout-errors' }),
      { queryResults: [[], []] },
    );

    expect(puts[0].input.Item.pk.S).toBe('INCIDENT#staging#checkout');
  });

  // A prefix rule would read "production-alb-5xx-elb" as a service called
  // "alb", which matches no deployment — so nothing is ever attributed and the
  // change failure rate reads zero forever.
  it('does not derive the service from the alarm name', async () => {
    const { puts } = await run(alarmEvent('ALARM'), { queryResults: [[], []] });

    expect(puts[0].input.Item.pk.S).toBe('INCIDENT#production#api');
    expect(puts[0].input.Item.service.S).toBe('api');
  });

  // Filing it under a guessed service moves two teams' numbers at once and
  // neither will recognise the incident as theirs. Reaching here means the
  // EventBridge rule and the mapping drifted apart.
  it('fails loudly on an alarm that is not in the mapping', async () => {
    await expect(
      run(alarmEvent('ALARM', { alarmName: 'some-other-alarm' }), { queryResults: [[], []] }),
    ).rejects.toThrow(/is not in incidentAlarms/);
  });

  it('ignores alarm states other than ALARM and OK', async () => {
    const { result, calls } = await run(
      alarmEvent('ALARM', { state: { value: 'INSUFFICIENT_DATA', timestamp: '2026-08-17T12:10:00.000Z' } }),
    );

    expect(result).toEqual({ ignored: 'INSUFFICIENT_DATA' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an event it does not recognise', async () => {
    await expect(run({ 'detail-type': 'Something Else', detail: {} })).rejects.toThrow(
      /unrecognised event/,
    );
  });

  it('rejects a deployment event with no service', async () => {
    await expect(run(deploymentEvent({ service: undefined }))).rejects.toThrow(
      /missing environment or service/,
    );
  });
});
