import { ACCOUNT_SCOPE, RIGHT_SIZING_SWEEPER_SOURCE } from '../lib/right-sizing-stack';
import {
  ENROLMENT_ACTIVE,
  LAMBDA_MINIMUM_INVOCATIONS,
  LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB,
  RIGHT_SIZING_METRIC_NAMESPACE,
  SAVINGS_CURRENCY,
  sweeperCatalogue,
} from '../lib/right-sizing';
import { type SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Behavioural tests for the Compute Optimizer sweeper.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing in the build
 * parses it. That matters more here than for most handlers because every
 * interesting path through it ends in a *smaller* number — no proposals, no
 * findings, no gap — and a smaller number is what a right-sized account
 * publishes. A sweeper that silently stopped reading would be indistinguishable
 * from one reporting good news.
 */

type Handler = () => Promise<any>;

const ENV = {
  METRIC_NAMESPACE: RIGHT_SIZING_METRIC_NAMESPACE,
  SCOPE: ACCOUNT_SCOPE,
  LOG_SCHEMA_VERSION: '1',
  EXPECTED_ENROLMENT: ENROLMENT_ACTIVE,
  SAVINGS_CURRENCY,
  LAMBDA_MINIMUM_INVOCATIONS: String(LAMBDA_MINIMUM_INVOCATIONS),
  LAMBDA_MEMORY_CEILING_MIB: String(LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB),
  CATALOGUE: JSON.stringify(sweeperCatalogue()),
};

const serviceArn = (cluster: string, service: string) =>
  `arn:aws:ecs:us-east-1:123456789012:service/${cluster}/${service}`;

interface RecommendationOptions {
  readonly finding?: string;
  readonly cpu?: number;
  readonly memory?: number;
  readonly savingPercent?: number;
  readonly savingValue?: number;
  readonly currency?: string;
  readonly noOptions?: boolean;
}

const ecsRecommendation = (service: string, options: RecommendationOptions = {}) => ({
  serviceArn: serviceArn('production-cluster', service),
  finding: options.finding ?? 'Overprovisioned',
  currentServiceConfiguration: { cpu: 1024, memory: 2048 },
  serviceRecommendationOptions: options.noOptions
    ? []
    : [
        {
          rank: 1,
          cpu: options.cpu ?? 512,
          memory: options.memory ?? 1024,
          savingsOpportunity: {
            savingsOpportunityPercentage: options.savingPercent ?? 25,
            estimatedMonthlySavings: {
              currency: options.currency ?? SAVINGS_CURRENCY,
              value: options.savingValue ?? 12.5,
            },
          },
        },
      ],
});

interface LoadOptions {
  readonly enrolment?: Record<string, unknown>;
  readonly ecs?: readonly Record<string, unknown>[];
  readonly lambdas?: readonly Record<string, unknown>[];
  readonly env?: Record<string, string>;
}

const load = (options: LoadOptions = {}) => {
  const calls: SdkCall[] = [];
  const logs: string[] = [];

  const respond = (call: SdkCall): unknown => {
    if (call.command === 'GetEnrollmentStatusCommand') {
      return options.enrolment ?? { status: ENROLMENT_ACTIVE };
    }
    if (call.command === 'GetECSServiceRecommendationsCommand') {
      return { ecsServiceRecommendations: options.ecs ?? [] };
    }
    if (call.command === 'GetLambdaFunctionRecommendationsCommand') {
      return { lambdaFunctionRecommendations: options.lambdas ?? [] };
    }
    return {};
  };

  const handler = loadInlineHandler<Handler>({
    source: RIGHT_SIZING_SWEEPER_SOURCE,
    modules: {
      '@aws-sdk/client-compute-optimizer': makeSdkModule(
        [
          'GetEnrollmentStatusCommand',
          'GetECSServiceRecommendationsCommand',
          'GetLambdaFunctionRecommendationsCommand',
        ],
        ['ComputeOptimizerClient'],
        calls,
        respond,
      ),
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        respond,
      ),
    },
    env: { ...ENV, ...(options.env ?? {}) },
    logs,
  });

  return { handler, calls, logs };
};

/** Every metric datum published across every PutMetricData call. */
const published = (calls: readonly SdkCall[]) =>
  calls
    .filter((call) => call.command === 'PutMetricDataCommand')
    .flatMap((call) => call.input.MetricData as Record<string, any>[]);

const valueOf = (calls: readonly SdkCall[], name: string): number | undefined =>
  published(calls).find((datum) => datum.MetricName === name)?.Value;

const records = (logs: readonly string[]) => logs.map((line) => JSON.parse(line));
const recordsOf = (logs: readonly string[], event: string) =>
  records(logs).filter((record) => record.event === event);

describe('enrolment', () => {
  /**
   * The failure this handler is shaped around. Before the opt-in every
   * recommendation call answers `OptInRequiredException`, and a sweep that
   * caught that would publish a finding count of zero — the number an optimised
   * account publishes.
   */
  it('stops before any recommendation call when the account is not enrolled', async () => {
    const { handler, calls } = load({
      enrolment: { status: 'Inactive', statusReason: 'not opted in' },
      ecs: [ecsRecommendation('staging-bg-service')],
    });

    const result = await handler();

    expect(result).toEqual({ enrolled: false, status: 'Inactive' });
    expect(calls.map((call) => call.command)).not.toContain(
      'GetECSServiceRecommendationsCommand',
    );
    expect(calls.map((call) => call.command)).not.toContain(
      'GetLambdaFunctionRecommendationsCommand',
    );
  });

  it('publishes Enrolled: 0 and nothing that would read as a measurement', async () => {
    const { handler, calls } = load({ enrolment: { status: 'Pending' } });
    await handler();

    expect(valueOf(calls, 'Enrolled')).toBe(0);
    // No SweepSuccess, no FindingsRead, no CoverageGap: a zero beside
    // `Enrolled: 0` would be a number about an account nothing has read.
    for (const name of ['SweepSuccess', 'FindingsRead', 'Proposals', 'CoverageGap']) {
      expect(valueOf(calls, name)).toBeUndefined();
    }
  });

  it('publishes Enrolled: 1 and sweeps when the account is active', async () => {
    const { handler, calls } = load();
    await handler();

    expect(valueOf(calls, 'Enrolled')).toBe(1);
    expect(valueOf(calls, 'SweepSuccess')).toBe(1);
  });
});

describe('coverage', () => {
  /**
   * The point of the whole module. `GetECSServiceRecommendations` omits an
   * excluded service rather than reporting the exclusion, so a loop over
   * findings can only report what it was given.
   */
  it('counts a gap for a catalogued service with no finding', async () => {
    const { handler, calls, logs } = load({ ecs: [] });
    await handler();

    // blue-green (2) + canary stable (2) + canary canary (2) + otel (2) = 8.
    // The three uncovered entries are expected to be absent and are not gaps.
    expect(valueOf(calls, 'CoverageGap')).toBe(8);

    const expectedAbsences = recordsOf(logs, 'right-sizing-coverage').filter(
      (record) => record.expected === true,
    );
    expect(expectedAbsences.map((record) => record.workload).sort()).toEqual([
      'preview-pr-service',
      'production-application',
      'staging-application',
    ]);
  });

  it('counts a partial gap when only some of an entry answered', async () => {
    const { handler, calls } = load({
      ecs: [
        ecsRecommendation('staging-bg-service'),
        ecsRecommendation('staging-stable-service'),
        ecsRecommendation('production-stable-service'),
        ecsRecommendation('staging-canary-service'),
        ecsRecommendation('production-canary-service'),
        ecsRecommendation('staging-otel-sampler'),
        ecsRecommendation('production-otel-sampler'),
      ],
    });
    await handler();

    // Only one of blue-green's two services answered.
    expect(valueOf(calls, 'CoverageGap')).toBe(1);
  });

  it('reports a finding for a service the catalogue calls uncovered', async () => {
    const { handler, calls, logs } = load({
      ecs: [ecsRecommendation('production-service')],
    });
    await handler();

    expect(valueOf(calls, 'UnexpectedFinding')).toBe(1);
    const [record] = recordsOf(logs, 'right-sizing-unexpected-finding');
    expect(record).toMatchObject({
      workload: 'production-application',
      reason: 'dual-target-tracking',
    });
  });

  it('logs a service no entry claims rather than counting it as healthy', async () => {
    const { handler, calls, logs } = load({ ecs: [ecsRecommendation('some-new-service')] });
    await handler();

    const unclaimed = recordsOf(logs, 'right-sizing-finding').filter(
      (record) => record.serviceName === 'some-new-service',
    );
    expect(unclaimed).toHaveLength(1);
    expect(valueOf(calls, 'Proposals')).toBe(0);
  });
});

describe('proposals', () => {
  const bothBlueGreen = (options: RecommendationOptions = {}) => [
    ecsRecommendation('staging-bg-service', options),
    ecsRecommendation('production-bg-service', options),
  ];

  it('proposes a valid size when both copies agree', async () => {
    const { handler, calls, logs } = load({ ecs: bothBlueGreen() });
    await handler();

    expect(valueOf(calls, 'Proposals')).toBe(2);
    const proposals = recordsOf(logs, 'right-sizing-proposal');
    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({
      workload: 'blue-green-service',
      proposed: { cpu: 512, memoryMiB: 1024 },
      savingCurrency: SAVINGS_CURRENCY,
    });
  });

  it('blocks both copies when they disagree', async () => {
    const { handler, calls } = load({
      ecs: [
        ecsRecommendation('staging-bg-service', { cpu: 512, memory: 1024 }),
        ecsRecommendation('production-bg-service', { cpu: 1024, memory: 2048 }),
      ],
    });
    await handler();

    expect(valueOf(calls, 'Proposals')).toBe(0);
    const blocked = published(calls).filter((datum) => datum.MetricName === 'ProposalsBlocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].Value).toBe(2);
    expect(blocked[0].Dimensions).toEqual(
      expect.arrayContaining([{ Name: 'Reason', Value: 'peer-disagreement' }]),
    );
  });

  /**
   * One of two services produced a finding, so the recommendation agrees with
   * itself. A missing finding is not consent.
   */
  it('blocks a proposal when one copy produced no finding', async () => {
    const { handler, calls } = load({ ecs: [ecsRecommendation('staging-bg-service')] });
    await handler();

    expect(valueOf(calls, 'Proposals')).toBe(0);
    expect(
      published(calls).find((datum) => datum.MetricName === 'ProposalsBlocked')?.Dimensions,
    ).toEqual(expect.arrayContaining([{ Name: 'Reason', Value: 'peer-disagreement' }]));
  });

  it('blocks a size below the entry floor', async () => {
    const { handler, calls } = load({ ecs: bothBlueGreen({ cpu: 256, memory: 512 }) });
    await handler();

    expect(valueOf(calls, 'Proposals')).toBe(0);
    expect(
      published(calls).find((datum) => datum.MetricName === 'ProposalsBlocked')?.Dimensions,
    ).toEqual(expect.arrayContaining([{ Name: 'Reason', Value: 'below-floor' }]));
  });

  it('blocks a pair Fargate would not register', async () => {
    const { handler, calls } = load({ ecs: bothBlueGreen({ cpu: 1024, memory: 1024 }) });
    await handler();

    expect(
      published(calls).find((datum) => datum.MetricName === 'ProposalsBlocked')?.Dimensions,
    ).toEqual(expect.arrayContaining([{ Name: 'Reason', Value: 'size-invalid-for-fargate' }]));
  });

  it('blocks a size the Fargate table does not cover', async () => {
    const { handler, calls } = load({ ecs: bothBlueGreen({ cpu: 8192, memory: 16384 }) });
    await handler();

    expect(
      published(calls).find((datum) => datum.MetricName === 'ProposalsBlocked')?.Dimensions,
    ).toEqual(expect.arrayContaining([{ Name: 'Reason', Value: 'size-outside-catalogue' }]));
  });

  it('blocks every finding about a held workload', async () => {
    const { handler, calls } = load({
      ecs: [
        ecsRecommendation('staging-otel-sampler'),
        ecsRecommendation('production-otel-sampler'),
      ],
    });
    await handler();

    expect(valueOf(calls, 'Proposals')).toBe(0);
    const blocked = published(calls).find((datum) => datum.MetricName === 'ProposalsBlocked');
    expect(blocked?.Value).toBe(2);
    expect(blocked?.Dimensions).toEqual(
      expect.arrayContaining([{ Name: 'Reason', Value: 'posture-hold' }]),
    );
  });

  it('treats an Optimized finding with no option as a finding, not as an error', async () => {
    const { handler, calls, logs } = load({
      ecs: [
        ecsRecommendation('staging-bg-service', { finding: 'Optimized', noOptions: true }),
        ecsRecommendation('production-bg-service', { finding: 'Optimized', noOptions: true }),
      ],
    });
    await handler();

    expect(valueOf(calls, 'FindingsRead')).toBe(2);
    expect(valueOf(calls, 'Proposals')).toBe(0);
    // Blue/green answered, so it is covered — an Optimized finding is a finding.
    // The six services of the canary and otel entries did not, which is the gap.
    expect(valueOf(calls, 'CoverageGap')).toBe(6);
    expect(recordsOf(logs, 'right-sizing-finding')[0].note).toContain('No change recommended');
  });

  it('reads the rank-1 option rather than the first one returned', async () => {
    const unordered = {
      serviceArn: serviceArn('production-cluster', 'staging-bg-service'),
      finding: 'Overprovisioned',
      serviceRecommendationOptions: [
        { rank: 2, cpu: 1024, memory: 2048, savingsOpportunity: {} },
        { rank: 1, cpu: 512, memoryMiB: undefined, memory: 1024, savingsOpportunity: {} },
      ],
    };
    const { handler, logs } = load({
      ecs: [unordered, { ...unordered, serviceArn: serviceArn('production-cluster', 'production-bg-service') }],
    });
    await handler();

    expect(recordsOf(logs, 'right-sizing-proposal')[0].proposed).toEqual({
      cpu: 512,
      memoryMiB: 1024,
    });
  });
});

describe('savings', () => {
  it('sums the estimate across proposals', async () => {
    const { handler, calls } = load({
      ecs: [
        ecsRecommendation('staging-bg-service', { savingValue: 10 }),
        ecsRecommendation('production-bg-service', { savingValue: 10 }),
      ],
    });
    await handler();

    expect(valueOf(calls, 'EstimatedMonthlySaving')).toBe(20);
    expect(valueOf(calls, 'SavingUncountedCurrency')).toBe(0);
  });

  /**
   * A sum across currencies is a number in none of them that still renders as
   * money on a dashboard.
   */
  it('does not add a saving reported in another currency', async () => {
    const { handler, calls } = load({
      ecs: [
        ecsRecommendation('staging-bg-service', { savingValue: 10, currency: 'EUR' }),
        ecsRecommendation('production-bg-service', { savingValue: 10, currency: 'EUR' }),
      ],
    });
    await handler();

    expect(valueOf(calls, 'EstimatedMonthlySaving')).toBe(0);
    expect(valueOf(calls, 'SavingUncountedCurrency')).toBe(2);
  });
});

describe('the Lambda half', () => {
  it('reads the recommendations, counts the unavailable ones, and proposes nothing', async () => {
    const { handler, calls } = load({
      lambdas: [
        { finding: 'Unavailable', findingReasonCodes: ['InsufficientData'] },
        { finding: 'Unavailable', findingReasonCodes: ['InsufficientData'] },
        { finding: 'NotOptimized', findingReasonCodes: ['MemoryOverprovisioned'] },
      ],
    });
    await handler();

    expect(valueOf(calls, 'LambdaFindingsRead')).toBe(3);
    expect(valueOf(calls, 'LambdaUnavailable')).toBe(2);
    expect(valueOf(calls, 'Proposals')).toBe(0);
  });
});

describe('pagination', () => {
  it('follows nextToken on both reads', async () => {
    const calls: SdkCall[] = [];
    const logs: string[] = [];
    let ecsPage = 0;
    let lambdaPage = 0;

    const respond = (call: SdkCall): unknown => {
      if (call.command === 'GetEnrollmentStatusCommand') return { status: ENROLMENT_ACTIVE };
      if (call.command === 'GetECSServiceRecommendationsCommand') {
        ecsPage += 1;
        return ecsPage === 1
          ? { ecsServiceRecommendations: [ecsRecommendation('staging-otel-sampler')], nextToken: 'more' }
          : { ecsServiceRecommendations: [ecsRecommendation('staging-otel-sampler')] };
      }
      if (call.command === 'GetLambdaFunctionRecommendationsCommand') {
        lambdaPage += 1;
        return lambdaPage === 1
          ? { lambdaFunctionRecommendations: [{ finding: 'Unavailable' }], nextToken: 'more' }
          : { lambdaFunctionRecommendations: [{ finding: 'Unavailable' }] };
      }
      return {};
    };

    const handler = loadInlineHandler<Handler>({
      source: RIGHT_SIZING_SWEEPER_SOURCE,
      modules: {
        '@aws-sdk/client-compute-optimizer': makeSdkModule(
          [
            'GetEnrollmentStatusCommand',
            'GetECSServiceRecommendationsCommand',
            'GetLambdaFunctionRecommendationsCommand',
          ],
          ['ComputeOptimizerClient'],
          calls,
          respond,
        ),
        '@aws-sdk/client-cloudwatch': makeSdkModule(
          ['PutMetricDataCommand'],
          ['CloudWatchClient'],
          calls,
          respond,
        ),
      },
      env: ENV,
      logs,
    });

    await handler();

    expect(ecsPage).toBe(2);
    expect(lambdaPage).toBe(2);
    expect(valueOf(calls, 'FindingsRead')).toBe(2);
    expect(valueOf(calls, 'LambdaFindingsRead')).toBe(2);
    const second = calls.find(
      (call) => call.command === 'GetECSServiceRecommendationsCommand' && call.input.nextToken,
    );
    expect(second?.input.nextToken).toBe('more');
  });
});

describe('the metric envelope', () => {
  it('dimensions every datum by scope, and only the blocked counts by reason', async () => {
    const { handler, calls } = load({ ecs: [ecsRecommendation('staging-otel-sampler')] });
    await handler();

    for (const datum of published(calls)) {
      expect(datum.Dimensions[0]).toEqual({ Name: 'Scope', Value: ACCOUNT_SCOPE });
      const hasReason = datum.Dimensions.some(
        (dimension: { Name: string }) => dimension.Name === 'Reason',
      );
      expect(hasReason).toBe(datum.MetricName === 'ProposalsBlocked');
    }
  });

  it('publishes into the one namespace the role is scoped to', async () => {
    const { handler, calls } = load();
    await handler();

    for (const call of calls.filter((entry) => entry.command === 'PutMetricDataCommand')) {
      expect(call.input.Namespace).toBe(RIGHT_SIZING_METRIC_NAMESPACE);
    }
  });

  it('writes one summary line carrying the counts and the thresholds', async () => {
    const { handler, logs } = load({ ecs: [ecsRecommendation('staging-otel-sampler')] });
    await handler();

    const [summary] = recordsOf(logs, 'right-sizing-sweep');
    expect(summary).toMatchObject({
      schemaVersion: 1,
      scope: ACCOUNT_SCOPE,
      enrolled: true,
      findingsRead: 1,
      proposals: 0,
      lambdaMinimumInvocations: LAMBDA_MINIMUM_INVOCATIONS,
      lambdaMemoryCeilingMiB: LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB,
      savingsCurrency: SAVINGS_CURRENCY,
    });
  });
});
