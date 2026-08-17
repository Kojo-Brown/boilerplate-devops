import { FEATURE_FLAG_SWEEP_SOURCE } from '../lib/feature-flag-lifecycle-stack';

/**
 * Behavioural tests for the inline sweep handler.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing else in the build
 * ever parses it: `tsc` sees a template literal and `cdk synth` embeds it
 * verbatim. Both directions of failure are silent. A classification that never
 * matches reports a clean estate that is not clean, and one that fires on
 * healthy flags files issues until somebody mutes the label — which produces
 * the same clean-looking estate by a longer route. So the handler is compiled
 * and run against recording stubs rather than asserted on as text.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = () => Promise<any>;

const makeSdkModule = (
  commandNames: string[],
  calls: SdkCall[],
  responder: (call: SdkCall) => unknown,
  clientNames: string[],
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
        return responder(call);
      }
    };
  }

  return module;
};

const ENV = {
  AWS_REGION: 'us-east-1',
  APPLICATION_ID: 'abc1234',
  CONFIGURATION_PROFILE_ID: 'def5678',
  ENVIRONMENTS: JSON.stringify([
    { name: 'production', id: 'env-prod' },
    { name: 'staging', id: 'env-stg' },
  ]),
  METRIC_NAMESPACE: 'FeatureFlags',
  SNS_TOPIC_ARN: 'arn:aws:sns:us-east-1:123456789012:flag-lifecycle',
  REPOSITORY: 'example-org/example-repo',
  GITHUB_API_URL: 'https://api.github.com',
  GITHUB_TOKEN_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:mock-github-token',
  ISSUE_LABEL: 'feature-flag-lifecycle',
  WARN_WITHIN_DAYS: '14',
  ABANDONED_AFTER_DAYS: '30',
  DRY_RUN: 'false',
};

const NOW = Date.parse('2026-08-17T09:00:00Z');

/** A flag mid-rollout, well inside its deadline — nothing to report. */
const healthyFlag = (overrides: Record<string, unknown> = {}) => ({
  description: 'Rebuilt dashboard shell.',
  kind: 'release',
  owner: '@web-platform',
  ticket: 'WEB-1421',
  createdOn: '2026-08-10',
  expiresOn: '2026-10-15',
  enabled: true,
  rolloutPercentage: 25,
  ...overrides,
});

const manifest = (flags: Record<string, unknown>, version = '1') => ({ version, flags });

interface RunOptions {
  /** Deployed configuration per environment name. A string is sent verbatim. */
  readonly configurations?: Record<string, unknown>;
  /** Environments whose StartConfigurationSession call fails outright. */
  readonly sessionFailures?: string[];
  readonly env?: Partial<typeof ENV>;
  /** Existing open issue titles the GitHub stub reports. */
  readonly openIssues?: string[];
  /** Fail the issue listing call. */
  readonly issueListStatus?: number;
  /** Fail issue creation for these flag keys. */
  readonly createFailures?: string[];
  /** Return no token at all, as an unconfigured sweep would. */
  readonly githubUnavailable?: boolean;
}

interface RunResult {
  readonly report: any;
  readonly calls: SdkCall[];
  readonly requests: { url: string; method: string; body?: any }[];
  readonly metrics: Record<string, any>[];
  readonly published: Record<string, any>[];
  readonly logs: string[];
  readonly errors: string[];
}

const run = async (options: RunOptions = {}): Promise<RunResult> => {
  const calls: SdkCall[] = [];
  const requests: { url: string; method: string; body?: any }[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const environments: { name: string; id: string }[] = JSON.parse(
    options.env?.ENVIRONMENTS ?? ENV.ENVIRONMENTS,
  );
  const byId = new Map(environments.map((e) => [e.id, e.name]));
  const tokensToEnvironment = new Map<string, string>();

  const responder = (call: SdkCall): unknown => {
    switch (call.command) {
      case 'StartConfigurationSessionCommand': {
        const name = byId.get(call.input.EnvironmentIdentifier) ?? 'unknown';
        if ((options.sessionFailures ?? []).includes(name)) {
          throw new Error('AccessDeniedException: not authorized to start a session');
        }
        const token = `token-${name}`;
        tokensToEnvironment.set(token, name);
        return { InitialConfigurationToken: token };
      }
      case 'GetLatestConfigurationCommand': {
        const name = tokensToEnvironment.get(call.input.ConfigurationToken) ?? 'unknown';
        const configuration = (options.configurations ?? {})[name];
        const body =
          typeof configuration === 'string' ? configuration : JSON.stringify(configuration ?? {});
        // The real SDK hands back bytes, not a string.
        return { Configuration: new TextEncoder().encode(body) };
      }
      case 'GetSecretValueCommand':
        return options.githubUnavailable
          ? {}
          : { SecretString: JSON.stringify({ token: 'mock-github-token' }) };
      default:
        return {};
    }
  };

  const modules: Record<string, unknown> = {
    '@aws-sdk/client-appconfigdata': makeSdkModule(
      ['StartConfigurationSessionCommand', 'GetLatestConfigurationCommand'],
      calls,
      responder,
      ['AppConfigDataClient'],
    ),
    '@aws-sdk/client-cloudwatch': makeSdkModule(
      ['PutMetricDataCommand'],
      calls,
      responder,
      ['CloudWatchClient'],
    ),
    '@aws-sdk/client-sns': makeSdkModule(['PublishCommand'], calls, responder, ['SNSClient']),
    '@aws-sdk/client-secrets-manager': makeSdkModule(
      ['GetSecretValueCommand'],
      calls,
      responder,
      ['SecretsManagerClient'],
    ),
  };

  let created = 0;
  const fetchStub = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, body });

    if (method === 'GET') {
      if (options.issueListStatus) {
        return { ok: false, status: options.issueListStatus, json: async () => ({}) };
      }

      const titles = options.openIssues ?? [];
      // Paged exactly as GitHub pages it: `per_page` items until a short page
      // ends the listing. A handler that stops after the first page sees only
      // the newest hundred issues and duplicates everything older.
      const perPage = Number(new URL(url).searchParams.get('per_page'));
      const page = Number(new URL(url).searchParams.get('page'));
      const slice = titles.slice((page - 1) * perPage, page * perPage);
      return { ok: true, status: 200, json: async () => slice.map((title) => ({ title })) };
    }

    const failing = (options.createFailures ?? []).some((key) => body?.title?.includes(key));
    if (failing) return { ok: false, status: 422, json: async () => ({}) };

    created += 1;
    return { ok: true, status: 201, json: async () => ({ number: 100 + created }) };
  };

  const module = { exports: {} as { handler?: Handler } };
  const requireStub = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`);
    return modules[id];
  };

  const factory = new Function(
    'require',
    'module',
    'exports',
    'process',
    'console',
    'fetch',
    'Date',
    FEATURE_FLAG_SWEEP_SOURCE,
  );

  // A fixed clock. Every threshold in the handler is measured against `now`,
  // and a test that depended on the wall clock would change verdict by the day
  // it ran — which is exactly the class of bug being tested for.
  class FixedDate extends Date {
    constructor(...args: any[]) {
      // @ts-expect-error — forwarding a variadic Date constructor
      super(...(args.length ? args : [NOW]));
    }
    static now() {
      return NOW;
    }
  }

  factory(
    requireStub,
    module,
    module.exports,
    { env: { ...ENV, ...options.env } },
    {
      log: (...args: unknown[]) => logs.push(args.join(' ')),
      error: (...args: unknown[]) => errors.push(args.join(' ')),
    },
    fetchStub,
    FixedDate,
  );

  const report = await module.exports.handler!();

  const metrics = calls
    .filter((c) => c.command === 'PutMetricDataCommand')
    .flatMap((c) => c.input.MetricData as Record<string, any>[]);
  const published = calls
    .filter((c) => c.command === 'PublishCommand')
    .map((c) => c.input as Record<string, any>);

  return { report, calls, requests, metrics, published, logs, errors };
};

/** The value of one metric series, by name and dimensions. */
const metricValue = (
  metrics: Record<string, any>[],
  name: string,
  dimensions: Record<string, string> = {},
): number | undefined => {
  const wanted = Object.entries(dimensions);
  const match = metrics.find((metric) => {
    if (metric.MetricName !== name) return false;
    const actual: { Name: string; Value: string }[] = metric.Dimensions ?? [];
    if (actual.length !== wanted.length) return false;
    return wanted.every(([key, value]) =>
      actual.some((d) => d.Name === key && d.Value === value),
    );
  });
  return match?.Value;
};

const createdTitles = (result: RunResult): string[] =>
  result.requests.filter((r) => r.method === 'POST').map((r) => r.body.title);

describe('the feature flag sweep handler', () => {
  describe('reading what is deployed', () => {
    it('reads every environment through the runtime data path', async () => {
      const result = await run({
        configurations: {
          production: manifest({ newDashboard: healthyFlag() }),
          staging: manifest({ newDashboard: healthyFlag() }),
        },
      });

      const sessions = result.calls.filter((c) => c.command === 'StartConfigurationSessionCommand');
      expect(sessions.map((c) => c.input.EnvironmentIdentifier)).toEqual(['env-prod', 'env-stg']);
      expect(sessions.every((c) => c.input.ApplicationIdentifier === 'abc1234')).toBe(true);
      expect(sessions.every((c) => c.input.ConfigurationProfileIdentifier === 'def5678')).toBe(true);
      expect(result.report).toMatchObject({ checked: 2, findings: 0, unreadable: 0 });
    });

    it('uses the token from the session it just started', async () => {
      const result = await run({
        configurations: { production: manifest({}), staging: manifest({}) },
      });
      const gets = result.calls.filter((c) => c.command === 'GetLatestConfigurationCommand');
      expect(gets.map((c) => c.input.ConfigurationToken)).toEqual([
        'token-production',
        'token-staging',
      ]);
    });

    it('says nothing and files nothing about a healthy estate', async () => {
      const result = await run({
        configurations: {
          production: manifest({
            newDashboard: healthyFlag(),
            maintenanceMode: {
              description: 'Stop serving writes.',
              kind: 'operational',
              owner: '@sre',
              createdOn: '2024-02-11',
              enabled: false,
            },
          }),
          staging: manifest({ newDashboard: healthyFlag() }),
        },
      });

      expect(result.report.findings).toBe(0);
      expect(result.published).toEqual([]);
      expect(createdTitles(result)).toEqual([]);
    });
  });

  describe('an environment it cannot read', () => {
    it.each([
      ['a session it cannot start', undefined],
      ['a body that is not JSON', 'not json at all'],
      ['a body that is not an object', '[]'],
      ['an empty body', '   '],
      ['a manifest version it does not parse', JSON.stringify({ version: '2', flags: {} })],
      ['a manifest with no flags', JSON.stringify({ version: '1' })],
    ])('reports %s as unreadable rather than as clean', async (_label, configuration) => {
      const result = await run({
        sessionFailures: configuration === undefined ? ['production'] : [],
        configurations: {
          production: configuration,
          staging: manifest({ newDashboard: healthyFlag() }),
        },
      });

      expect(result.report.unreadable).toBe(1);
      expect(metricValue(result.metrics, 'ManifestUnreadable', { Environment: 'production' })).toBe(
        1,
      );
      // The undimensioned series is what the alarm reads; a dimensioned
      // datapoint is a different series and would never reach it.
      expect(metricValue(result.metrics, 'ManifestUnreadable')).toBe(1);
      expect(result.published).toHaveLength(1);
      expect(result.published[0].Message).toContain('could not read');
    });

    it('keeps sweeping the environments it can read', async () => {
      const result = await run({
        sessionFailures: ['production'],
        configurations: {
          staging: manifest({ oldFlag: healthyFlag({ expiresOn: '2026-08-01' }) }),
        },
      });

      expect(result.report.unreadable).toBe(1);
      expect(result.report.findings).toBe(1);
      expect(createdTitles(result)).toEqual([
        expect.stringContaining('[flag:oldFlag@staging]'),
      ]);
    });

    it('publishes a zero when it could read everything, so the alarm can tell', async () => {
      const result = await run({
        configurations: { production: manifest({}), staging: manifest({}) },
      });
      expect(metricValue(result.metrics, 'ManifestUnreadable')).toBe(0);
      expect(metricValue(result.metrics, 'ManifestUnreadable', { Environment: 'production' })).toBe(
        0,
      );
    });
  });

  describe('classification', () => {
    const classifyOne = async (flag: Record<string, unknown>) => {
      const result = await run({
        configurations: { production: manifest({ subject: flag }), staging: manifest({}) },
      });
      const line = result.published[0]?.Message ?? '';
      const match = /subject {2}\[(\w+)\]/.exec(line);
      return { reason: match?.[1], result };
    };

    it('reports a flag past its removal date as expired', async () => {
      const { reason, result } = await classifyOne(healthyFlag({ expiresOn: '2026-08-10' }));
      expect(reason).toBe('expired');
      expect(result.published[0].Message).toContain('7 day(s) ago');
    });

    it('does not report a flag on its own deadline', async () => {
      // The deadline is a date, not a moment: a flag due today has today.
      const { reason } = await classifyOne(healthyFlag({ expiresOn: '2026-08-17' }));
      expect(reason).toBe('expiring');
    });

    it('reports a flag inside the warning window as expiring', async () => {
      const { reason, result } = await classifyOne(healthyFlag({ expiresOn: '2026-08-25' }));
      expect(reason).toBe('expiring');
      expect(result.published[0].Message).toContain('in 8 day(s)');
    });

    it('says nothing about a deadline beyond the warning window', async () => {
      const { reason } = await classifyOne(healthyFlag({ expiresOn: '2026-09-30' }));
      expect(reason).toBeUndefined();
    });

    it('reports a finished rollout as ready to remove', async () => {
      const { reason, result } = await classifyOne(healthyFlag({ rolloutPercentage: 100 }));
      expect(reason).toBe('readyToRemove');
      expect(result.published[0].Message).toContain('unremoved branch');
    });

    it('treats a flag with no percentage as fully rolled out', async () => {
      const flag = healthyFlag();
      delete (flag as Record<string, unknown>).rolloutPercentage;
      expect((await classifyOne(flag)).reason).toBe('readyToRemove');
    });

    it('reports an old flag that was never turned on as abandoned', async () => {
      const { reason, result } = await classifyOne(
        healthyFlag({ createdOn: '2026-06-01', enabled: false, rolloutPercentage: 0 }),
      );
      expect(reason).toBe('abandoned');
      expect(result.published[0].Message).toContain('never been rolled out');
    });

    it('counts a flag on at zero percent as never rolled out', async () => {
      const { reason } = await classifyOne(
        healthyFlag({ createdOn: '2026-06-01', enabled: true, rolloutPercentage: 0 }),
      );
      expect(reason).toBe('abandoned');
    });

    it('leaves a recently created flag that is still off alone', async () => {
      const { reason } = await classifyOne(
        healthyFlag({ createdOn: '2026-08-14', enabled: false, rolloutPercentage: 0 }),
      );
      expect(reason).toBeUndefined();
    });

    it('prefers the overdue deadline over the finished rollout', async () => {
      // A flag can be both. The deadline is the more urgent of the two and the
      // one that decides how loudly it is reported.
      const { reason } = await classifyOne(
        healthyFlag({ expiresOn: '2026-08-01', rolloutPercentage: 100 }),
      );
      expect(reason).toBe('expired');
    });

    it('never reports an operational flag, whatever state it is in', async () => {
      // Kill switches and rate limits are controls, not unfinished work. A
      // sweep that nagged about them would be nagging about every one of them
      // forever, which is how a label gets muted.
      const result = await run({
        configurations: {
          production: manifest({
            maintenanceMode: {
              description: 'Stop serving writes.',
              kind: 'operational',
              owner: '@sre',
              createdOn: '2019-01-01',
              enabled: false,
            },
            rateLimitRequestsPerMinute: {
              description: 'Per-client request budget.',
              kind: 'operational',
              owner: '@sre',
              createdOn: '2019-01-01',
              enabled: true,
              value: 100,
            },
          }),
          staging: manifest({}),
        },
      });
      expect(result.report.findings).toBe(0);
    });

    it('ignores an entry that is not a flag declaration', async () => {
      const result = await run({
        configurations: {
          production: manifest({ broken: 'true', fine: healthyFlag() }),
          staging: manifest({}),
        },
      });
      expect(result.report.findings).toBe(0);
    });
  });

  describe('metrics', () => {
    it('publishes every reason every run, including the zeroes', async () => {
      // A metric emitted only when non-zero cannot distinguish "none today"
      // from "the sweep did not run", and the alarm needs that distinction.
      const result = await run({
        configurations: {
          production: manifest({ oldFlag: healthyFlag({ expiresOn: '2026-08-01' }) }),
          staging: manifest({}),
        },
      });

      for (const reason of ['expired', 'expiring', 'readyToRemove', 'abandoned']) {
        expect(
          metricValue(result.metrics, 'StaleFlags', { Environment: 'staging', Reason: reason }),
        ).toBe(0);
      }
      expect(
        metricValue(result.metrics, 'StaleFlags', { Environment: 'production', Reason: 'expired' }),
      ).toBe(1);
    });

    it('publishes the per-reason series the alarm watches', async () => {
      const result = await run({
        configurations: {
          production: manifest({ oldFlag: healthyFlag({ expiresOn: '2026-08-01' }) }),
          staging: manifest({}),
        },
      });
      expect(metricValue(result.metrics, 'StaleFlags', { Reason: 'expired' })).toBe(1);
    });

    it('counts the flags deployed to each environment', async () => {
      const result = await run({
        configurations: {
          production: manifest({ a: healthyFlag(), b: healthyFlag() }),
          staging: manifest({ a: healthyFlag() }),
        },
      });
      expect(metricValue(result.metrics, 'DeployedFlags', { Environment: 'production' })).toBe(2);
      expect(metricValue(result.metrics, 'DeployedFlags', { Environment: 'staging' })).toBe(1);
    });

    it('publishes into the configured namespace only', async () => {
      const result = await run({
        configurations: { production: manifest({}), staging: manifest({}) },
      });
      const puts = result.calls.filter((c) => c.command === 'PutMetricDataCommand');
      expect(puts.length).toBeGreaterThan(0);
      expect(puts.every((c) => c.input.Namespace === 'FeatureFlags')).toBe(true);
    });
  });

  describe('filing the work', () => {
    const expired = manifest({ oldFlag: healthyFlag({ expiresOn: '2026-08-01' }) });

    it('opens one issue per actionable flag, tagged so it can be found again', async () => {
      const result = await run({ configurations: { production: expired, staging: manifest({}) } });

      const posts = result.requests.filter((r) => r.method === 'POST');
      expect(posts).toHaveLength(1);
      expect(posts[0].url).toBe('https://api.github.com/repos/example-org/example-repo/issues');
      expect(posts[0].body.title).toContain('[flag:oldFlag@production]');
      expect(posts[0].body.labels).toEqual(['feature-flag-lifecycle']);
      expect(result.report.issuesOpened).toBe(1);
    });

    it('puts the flag, its owner, and its ticket in the issue body', async () => {
      const result = await run({ configurations: { production: expired, staging: manifest({}) } });
      const body: string = result.requests.find((r) => r.method === 'POST')!.body.body;

      expect(body).toContain('@web-platform');
      expect(body).toContain('WEB-1421');
      expect(body).toContain('2026-08-01');
      // The removal order is the part that is easy to get wrong and expensive
      // to get wrong, so it travels with the request rather than in a wiki.
      expect(body).toContain('Delete the branch the flag guards');
    });

    it('does not file a second issue for a flag it has already filed', async () => {
      const result = await run({
        configurations: { production: expired, staging: manifest({}) },
        openIssues: ['[flag:oldFlag@production] Remove feature flag oldFlag (expired)'],
      });
      expect(createdTitles(result)).toEqual([]);
      expect(result.report.issuesOpened).toBe(0);
    });

    it('files per environment, since a flag can be overdue in one and not the other', async () => {
      const result = await run({
        configurations: { production: expired, staging: expired },
        openIssues: ['[flag:oldFlag@production] Remove feature flag oldFlag (expired)'],
      });
      expect(createdTitles(result)).toEqual([
        expect.stringContaining('[flag:oldFlag@staging]'),
      ]);
    });

    it('reads every page of the open issues before deciding what is new', async () => {
      // The repository that most needs this is the one with a backlog, so the
      // already-filed issue is put on the second page, behind a full first one.
      const filler = Array.from(
        { length: 100 },
        (_, i) => `[flag:other${i}@production] Remove feature flag other${i} (expired)`,
      );
      const result = await run({
        configurations: { production: expired, staging: manifest({}) },
        openIssues: [
          ...filler,
          '[flag:oldFlag@production] Remove feature flag oldFlag (expired)',
        ],
      });

      expect(result.requests.filter((r) => r.method === 'GET')).toHaveLength(2);
      expect(createdTitles(result)).toEqual([]);
    });

    it('does not file for a flag that is only approaching its deadline', async () => {
      // `expiring` is a heads-up. Filing on it would put an issue in the
      // backlog two weeks before anyone can act on it.
      const result = await run({
        configurations: {
          production: manifest({ soonFlag: healthyFlag({ expiresOn: '2026-08-25' }) }),
          staging: manifest({}),
        },
      });
      expect(createdTitles(result)).toEqual([]);
      expect(result.published[0].Message).toContain('expiring');
    });

    it('files nothing at all when it could not list what is already open', async () => {
      // Not knowing which issues exist is a reason to file none this run. The
      // alternative is duplicating every issue in the backlog.
      const result = await run({
        configurations: { production: expired, staging: manifest({}) },
        issueListStatus: 502,
      });
      expect(createdTitles(result)).toEqual([]);
      expect(result.published[0].Message).toContain('no usable GitHub token');
      expect(result.errors.join(' ')).toContain('502');
    });

    it('still measures and notifies without a GitHub token', async () => {
      const result = await run({
        configurations: { production: expired, staging: manifest({}) },
        githubUnavailable: true,
      });
      expect(result.requests).toEqual([]);
      expect(metricValue(result.metrics, 'StaleFlags', { Reason: 'expired' })).toBe(1);
      expect(result.published).toHaveLength(1);
    });

    it('carries on when one issue cannot be created', async () => {
      const result = await run({
        configurations: {
          production: manifest({
            oldFlag: healthyFlag({ expiresOn: '2026-08-01' }),
            otherFlag: healthyFlag({ expiresOn: '2026-08-02' }),
          }),
          staging: manifest({}),
        },
        createFailures: ['oldFlag'],
      });

      // Both are attempted — the point is that the second one is not skipped
      // because the first failed — and only the one that succeeded is counted.
      expect(createdTitles(result)).toEqual([
        expect.stringContaining('oldFlag'),
        expect.stringContaining('otherFlag'),
      ]);
      expect(result.report.issuesOpened).toBe(1);
      expect(result.errors.join(' ')).toContain('oldFlag');
    });

    it('authenticates with the token from Secrets Manager', async () => {
      const result = await run({ configurations: { production: expired, staging: manifest({}) } });
      const secretReads = result.calls.filter((c) => c.command === 'GetSecretValueCommand');
      expect(secretReads).toHaveLength(1);
      expect(secretReads[0].input.SecretId).toBe(ENV.GITHUB_TOKEN_SECRET_ARN);
    });
  });

  describe('dry run', () => {
    it('classifies and notifies without touching GitHub', async () => {
      const result = await run({
        configurations: {
          production: manifest({ oldFlag: healthyFlag({ expiresOn: '2026-08-01' }) }),
          staging: manifest({}),
        },
        env: { DRY_RUN: 'true' },
      });

      expect(result.requests).toEqual([]);
      expect(result.report).toMatchObject({ findings: 1, issuesOpened: 0, dryRun: true });
      expect(metricValue(result.metrics, 'StaleFlags', { Reason: 'expired' })).toBe(1);
      expect(result.published).toHaveLength(1);
      // The "no token" line would be wrong here: the token is fine, the run is
      // deliberately not filing.
      expect(result.published[0].Message).not.toContain('no usable GitHub token');
    });
  });

  describe('thresholds', () => {
    it('respects a wider warning window', async () => {
      const result = await run({
        configurations: {
          production: manifest({ soonFlag: healthyFlag({ expiresOn: '2026-09-10' }) }),
          staging: manifest({}),
        },
        env: { WARN_WITHIN_DAYS: '30' },
      });
      expect(result.report.findings).toBe(1);
    });

    it('respects a shorter abandonment threshold', async () => {
      const result = await run({
        configurations: {
          production: manifest({
            quiet: healthyFlag({ createdOn: '2026-08-05', enabled: false, rolloutPercentage: 0 }),
          }),
          staging: manifest({}),
        },
        env: { ABANDONED_AFTER_DAYS: '7' },
      });
      expect(result.published[0].Message).toContain('abandoned');
    });
  });
});
