import {
  AgentConfigSpec,
  CollectorConfig,
  ConfigValue,
  DEFAULT_TAIL_SAMPLING,
  HEALTH_CHECK_PORT,
  OTLP_GRPC_PORT,
  OTLP_HTTP_PORT,
  PUBLISHED_COLLECTOR_METRICS,
  SELF_TELEMETRY_PORT,
  SamplerConfigSpec,
  TailSamplingSpec,
  buildAgentConfig,
  buildSamplerConfig,
  metricNamespace,
  renderCollectorConfig,
  validateSamplingSpec,
} from '../lib/otel-collector-config';

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const AGENT_SPEC: AgentConfigSpec = {
  envName: 'test',
  namespaceName: 'otel.test.internal',
  samplerServiceName: 'sampler',
  metricsLogGroupName: '/ecs/test/otel-collector-metrics',
};

const samplerSpec = (
  sampling: Partial<TailSamplingSpec> = {},
): SamplerConfigSpec => ({
  envName: 'test',
  sampling: { ...DEFAULT_TAIL_SAMPLING, ...sampling },
  metricsLogGroupName: '/ecs/test/otel-collector-metrics',
  indexedAttributes: ['http.route'],
});

/** Walk a dotted path through a rendered config. */
const at = (config: CollectorConfig, path: string): unknown =>
  path.split('.').reduce<unknown>(
    (node, key) =>
      node !== null && typeof node === 'object'
        ? (node as Record<string, unknown>)[key]
        : undefined,
    config as unknown,
  );

interface Policy {
  readonly name: string;
  readonly type: string;
  readonly [key: string]: ConfigValue;
}

const policies = (config: CollectorConfig): Policy[] =>
  at(config, 'processors.tail_sampling.policies') as Policy[];

const policyNamed = (config: CollectorConfig, name: string): Policy => {
  const found = policies(config).find((policy) => policy.name === name);
  if (!found) throw new Error(`no policy named ${name}`);
  return found;
};

/* ── Validation: the configs the collector would accept and shouldn't ─────── */

describe('validateSamplingSpec', () => {
  const validate = (overrides: Partial<TailSamplingSpec>): void =>
    validateSamplingSpec({ ...DEFAULT_TAIL_SAMPLING, ...overrides }, 'unit test');

  it('accepts the shipped defaults', () => {
    expect(() => validate({})).not.toThrow();
  });

  // The reason this module exists. A decision_wait below the latency threshold
  // produces a config the collector starts on, a latency policy that evaluates
  // on every trace, and zero traces kept by it — because the duration it is
  // looking for is one it is never given the chance to observe.
  it('rejects a decision window shorter than the latency policy it is meant to catch', () => {
    expect(() => validate({ decisionWaitSeconds: 2, latencyThresholdMs: 5_000 })).toThrow(
      /decisionWaitSeconds \(2s = 2000ms\) must exceed latencyThresholdMs \(5000ms\)/,
    );
  });

  it('rejects a decision window exactly equal to the latency threshold', () => {
    // Equality is not "just enough": a trace of exactly the threshold duration
    // is decided at the instant its last span arrives, and the ordering of
    // those two events is not something the processor promises.
    expect(() => validate({ decisionWaitSeconds: 5, latencyThresholdMs: 5_000 })).toThrow(
      /must exceed latencyThresholdMs/,
    );
  });

  // num_traces is a circular buffer. Below the arrival rate times the decision
  // window it is provably evicting traces before deciding them, which is two
  // numbers a reviewer could multiply and nobody does.
  it('rejects a buffer too small for a decision window of arrivals', () => {
    expect(() =>
      validate({
        decisionWaitSeconds: 30,
        expectedNewTracesPerSec: 2_000,
        numTraces: 50_000,
      }),
    ).toThrow(/numTraces \(50000\) is below twice the traces in flight/);
  });

  it('accepts a buffer at exactly twice the in-flight estimate', () => {
    expect(() =>
      validate({
        decisionWaitSeconds: 10,
        expectedNewTracesPerSec: 100,
        numTraces: 2_000,
      }),
    ).not.toThrow();
  });

  it.each([
    [100, /100 keeps every trace/],
    [0, /0 is a policy that can never sample/],
    [-1, /must be between 0 and 100 exclusive/],
    [140, /must be between 0 and 100 exclusive/],
  ])('rejects a baseline percentage of %s', (baselinePercentage, expected) => {
    expect(() => validate({ baselinePercentage })).toThrow(expected);
  });

  it('rejects an empty drop list', () => {
    expect(() => validate({ dropUrlPathPatterns: [] })).toThrow(
      /dropUrlPathPatterns is empty/,
    );
  });

  // The processor compiles these at start-up and refuses to run, so an invalid
  // pattern is a task that crash-loops after a green deploy rather than a
  // failed synth.
  it('rejects a drop pattern that is not a regular expression', () => {
    expect(() => validate({ dropUrlPathPatterns: ['^/health['] })).toThrow(
      /is not a valid regular expression/,
    );
  });

  it.each([
    ['decisionWaitSeconds', { decisionWaitSeconds: 0 }],
    ['latencyThresholdMs', { latencyThresholdMs: 0 }],
    ['expectedNewTracesPerSec', { expectedNewTracesPerSec: 0 }],
  ])('rejects a non-positive %s', (_field, overrides) => {
    expect(() => validate(overrides)).toThrow(/must be positive/);
  });

  it('names the caller so a synth failure points at one stack', () => {
    expect(() =>
      validateSamplingSpec(
        { ...DEFAULT_TAIL_SAMPLING, baselinePercentage: 0 },
        'OtelCollectorStack-Production',
      ),
    ).toThrow(/^OtelCollectorStack-Production: /);
  });

  it('is enforced by buildSamplerConfig, not only when called directly', () => {
    expect(() => buildSamplerConfig(samplerSpec({ decisionWaitSeconds: 1 }))).toThrow(
      /sampler config for test: decisionWaitSeconds/,
    );
  });
});

/* ── Sampler configuration ────────────────────────────────────────────────── */

describe('buildSamplerConfig', () => {
  const config = buildSamplerConfig(samplerSpec());

  it('runs tail_sampling behind the memory limiter and ahead of the batcher', () => {
    // memory_limiter first or it is protecting memory that is already
    // allocated; batch after tail_sampling because the processor reassembles
    // spans into its own batches as it groups them by trace, so batching ahead
    // of it is work immediately undone.
    expect(at(config, 'service.pipelines.traces.processors')).toEqual([
      'memory_limiter',
      'tail_sampling',
      'batch',
    ]);
  });

  it('exports traces to X-Ray and nothing else', () => {
    expect(at(config, 'service.pipelines.traces.exporters')).toEqual(['awsxray']);
  });

  // `drop` combines its sub-policies with AND: it drops only when every one of
  // them matched. Both semconv spellings of the request path inside one drop
  // policy would therefore require a span to carry both, which none does — so
  // health checks would be sampled by an obviously-correct-looking config.
  it('gives each request-path attribute its own drop policy, with one sub-policy', () => {
    const dropPolicies = policies(config).filter((policy) => policy.type === 'drop');

    expect(dropPolicies.map((policy) => policy.name)).toEqual([
      'drop-synthetic-traffic-by-url.path',
      'drop-synthetic-traffic-by-http.target',
    ]);

    for (const policy of dropPolicies) {
      const subPolicies = (policy.drop as { drop_sub_policy: ConfigValue[] })
        .drop_sub_policy;
      expect(subPolicies).toHaveLength(1);
    }
  });

  it('matches drop patterns as regular expressions', () => {
    const policy = policyNamed(config, 'drop-synthetic-traffic-by-url.path');
    const [sub] = (policy.drop as { drop_sub_policy: Record<string, ConfigValue>[] })
      .drop_sub_policy;
    const matcher = sub.string_attribute as Record<string, ConfigValue>;

    // Without enabled_regex_matching the values are exact matches, so an
    // anchored pattern matches the literal string "^/health$" and nothing else.
    expect(matcher.enabled_regex_matching).toBe(true);
    expect(matcher.key).toBe('url.path');
    expect(matcher.values).toEqual(DEFAULT_TAIL_SAMPLING.dropUrlPathPatterns);
  });

  // UNSET is the status of every span nobody called SetStatus on, which is most
  // of them: including it turns "keep errors" into "keep everything".
  it('keeps only ERROR spans, not UNSET ones', () => {
    const policy = policyNamed(config, 'keep-errors');
    expect(policy.status_code).toEqual({ status_codes: ['ERROR'] });
  });

  it('caches decisions well past the trace buffer so late spans inherit them', () => {
    const cache = at(config, 'processors.tail_sampling.decision_cache') as Record<
      string,
      number
    >;
    const numTraces = at(config, 'processors.tail_sampling.num_traces') as number;

    expect(cache.sampled_cache_size).toBeGreaterThan(numTraces);
    expect(cache.non_sampled_cache_size).toBeGreaterThan(numTraces);
  });

  it('listens for OTLP on the task ENI, since the agents are in other tasks', () => {
    expect(at(config, 'receivers.otlp.protocols.grpc.endpoint')).toBe(
      `0.0.0.0:${OTLP_GRPC_PORT}`,
    );
    expect(at(config, 'extensions.health_check.endpoint')).toBe(
      `0.0.0.0:${HEALTH_CHECK_PORT}`,
    );
  });

  it('does not accept OTLP over HTTP — only agents talk to this tier', () => {
    expect(at(config, 'receivers.otlp.protocols.http')).toBeUndefined();
  });

  it('indexes only the attributes it was given', () => {
    expect(at(config, 'exporters.awsxray.indexed_attributes')).toEqual(['http.route']);
    // index_all_attributes would blow past X-Ray's 50-annotations-per-segment
    // limit, and what gets dropped past it is decided by iteration order.
    expect(at(config, 'exporters.awsxray.index_all_attributes')).toBe(false);
  });
});

/* ── Agent configuration ──────────────────────────────────────────────────── */

describe('buildAgentConfig', () => {
  const config = buildAgentConfig(AGENT_SPEC);

  it('routes by trace id, which is what makes tail sampling correct downstream', () => {
    // The default for traces, and written out because the entire two-tier
    // design rests on it: `service` would send every trace of one service to
    // one sampler and still split a cross-service trace across instances.
    expect(at(config, 'exporters.load_balancing.routing_key')).toBe('traceID');
  });

  it('never runs tail_sampling itself', () => {
    // An agent sees only its own task's spans, so a sampling decision here is
    // made on a fragment by definition.
    expect(at(config, 'processors.tail_sampling')).toBeUndefined();
    expect(at(config, 'service.pipelines.traces.processors')).toEqual([
      'memory_limiter',
      'resourcedetection',
    ]);
  });

  it('resolves backends through the Cloud Map API rather than DNS', () => {
    const resolver = at(config, 'exporters.load_balancing.resolver') as Record<
      string,
      ConfigValue
    >;

    // Cloud Map's DNS answers are Route 53 multivalue records, capped at eight
    // addresses: a ninth sampler task would be invisible, and two agents
    // resolving different eights would build different hash rings.
    expect(resolver.dns).toBeUndefined();
    expect(resolver.static).toBeUndefined();

    expect(resolver.aws_cloud_map).toMatchObject({
      namespace: AGENT_SPEC.namespaceName,
      service_name: AGENT_SPEC.samplerServiceName,
    });
  });

  it('sets the backend port explicitly, because an A registration carries none', () => {
    const cloudMap = at(
      config,
      'exporters.load_balancing.resolver.aws_cloud_map',
    ) as Record<string, ConfigValue>;

    // Left unset, the resolver reads AWS_INSTANCE_PORT, which only SRV
    // registrations have — an A registration yields "10.0.1.4:" and every
    // export fails to connect.
    expect(cloudMap.port).toBe(OTLP_GRPC_PORT);
  });

  it('fails open when no sampler reports healthy', () => {
    const cloudMap = at(
      config,
      'exporters.load_balancing.resolver.aws_cloud_map',
    ) as Record<string, ConfigValue>;

    // HEALTHY alone resolves to zero backends during a deploy or a scale
    // event, and an agent with no backends drops every span.
    expect(cloudMap.health_status).toBe('HEALTHY_OR_ELSE_ALL');
  });

  it('binds OTLP to loopback only', () => {
    // Containers in an awsvpc task share a network namespace, so the app
    // reaches this over localhost; 0.0.0.0 would publish an unauthenticated
    // OTLP endpoint on the task ENI.
    expect(at(config, 'receivers.otlp.protocols.grpc.endpoint')).toBe(
      `localhost:${OTLP_GRPC_PORT}`,
    );
    expect(at(config, 'receivers.otlp.protocols.http.endpoint')).toBe(
      `localhost:${OTLP_HTTP_PORT}`,
    );
    expect(at(config, 'extensions.health_check.endpoint')).toBe(
      `localhost:${HEALTH_CHECK_PORT}`,
    );
  });

  it('detects ECS resource attributes without overwriting the application', () => {
    // The task metadata endpoint is per-task, so this is knowable in the
    // sidecar and nowhere downstream.
    expect(at(config, 'processors.resourcedetection.detectors')).toEqual(['env', 'ecs']);
    expect(at(config, 'processors.resourcedetection.override')).toBe(false);
  });

  it('does not batch ahead of the load balancer', () => {
    // The exporter regroups every batch by trace id before handing it on, so a
    // batch processor in front of it does work that is immediately undone and
    // adds latency to a decision already waiting on decision_wait.
    expect(at(config, 'processors.batch')).toBeUndefined();
  });
});

/* ── Self-telemetry ───────────────────────────────────────────────────────── */

describe('collector self-telemetry', () => {
  const agent = buildAgentConfig(AGENT_SPEC);
  const sampler = buildSamplerConfig(samplerSpec());

  it.each([
    ['agent', agent],
    ['sampler', sampler],
  ])('%s scrapes its own Prometheus endpoint into EMF', (_tier, config) => {
    expect(at(config, 'service.pipelines.metrics/self.receivers')).toEqual([
      'prometheus',
    ]);
    expect(at(config, 'service.pipelines.metrics/self.exporters')).toEqual(['awsemf']);

    const targets = at(
      config,
      'receivers.prometheus.config.scrape_configs',
    ) as { static_configs: { targets: string[] }[] }[];
    expect(targets[0].static_configs[0].targets).toEqual([
      `localhost:${SELF_TELEMETRY_PORT}`,
    ]);
  });

  // Declaring `readers` would replace the default entry rather than amend it —
  // confmap merges maps and replaces sequences — and the replacement's unset
  // flags fall back to Go zero values, so every metric name would grow a unit
  // and type suffix. The allowlist below would then match nothing, and the
  // alarms would sit at INSUFFICIENT_DATA looking like a quiet system.
  it.each([
    ['agent', agent],
    ['sampler', sampler],
  ])('%s leaves service.telemetry.metrics at the collector default', (_tier, config) => {
    expect(at(config, 'service.telemetry.metrics')).toBeUndefined();
    expect(at(config, 'service.telemetry.logs.level')).toBe('info');
  });

  it.each([
    ['agent', agent],
    ['sampler', sampler],
  ])('%s publishes an allowlist, not every collector metric', (_tier, config) => {
    const declarations = at(config, 'exporters.awsemf.metric_declarations') as {
      metric_name_selectors: string[];
    }[];

    // An empty metric_declarations publishes everything the collector exposes
    // — several hundred series, each a billed CloudWatch custom metric.
    expect(declarations).toHaveLength(1);
    expect(declarations[0].metric_name_selectors).toEqual(
      PUBLISHED_COLLECTOR_METRICS.map((name) => `^${name}$`),
    );
  });

  it.each([
    ['agent', agent],
    ['sampler', sampler],
  ])('%s does not roll dimensions up into extra metrics', (_tier, config) => {
    // The default, ZeroAndSingleDimensionRollup, republishes each metric once
    // per individual label: the same data at several prices.
    expect(at(config, 'exporters.awsemf.dimension_rollup_option')).toBe(
      'NoDimensionRollup',
    );
  });

  it('keeps the two tiers in one namespace but separate log streams', () => {
    expect(at(agent, 'exporters.awsemf.namespace')).toBe(metricNamespace('test'));
    expect(at(sampler, 'exporters.awsemf.namespace')).toBe(metricNamespace('test'));
    expect(at(agent, 'exporters.awsemf.log_stream_name')).toBe('self-telemetry/agent');
    expect(at(sampler, 'exporters.awsemf.log_stream_name')).toBe(
      'self-telemetry/sampler',
    );
  });

  it('publishes every metric the alarms read', () => {
    // The alarms in otel-collector-stack.ts evaluate these four. A metric
    // dropped from the allowlist would leave its alarm permanently at
    // INSUFFICIENT_DATA, which is not a state anyone is paged by.
    expect(PUBLISHED_COLLECTOR_METRICS).toEqual(
      expect.arrayContaining([
        'otelcol_processor_tail_sampling_sampling_trace_dropped_too_early',
        'otelcol_processor_refused_spans',
        'otelcol_exporter_send_failed_spans',
        'otelcol_loadbalancer_num_backends',
      ]),
    );
  });
});

/* ── Rendering ────────────────────────────────────────────────────────────── */

describe('renderCollectorConfig', () => {
  it('renders JSON the collector will parse as YAML', () => {
    // YAML 1.2 is a superset of JSON and the collector resolves
    // --config=env:VAR by parsing the variable as YAML, so this round-trips.
    const rendered = renderCollectorConfig(buildSamplerConfig(samplerSpec()));

    expect(() => JSON.parse(rendered) as unknown).not.toThrow();
    expect(JSON.parse(rendered)).toEqual(buildSamplerConfig(samplerSpec()));
  });

  it('is byte-stable for a given spec', () => {
    // A task definition holds this as one environment variable. An unstable
    // rendering would show as a container definition change on every synth,
    // which is a diff nobody reads and a deployment nobody asked for.
    expect(renderCollectorConfig(buildAgentConfig(AGENT_SPEC))).toBe(
      renderCollectorConfig(buildAgentConfig(AGENT_SPEC)),
    );
  });

  it('renders one key per line so a policy change diffs as a policy change', () => {
    const rendered = renderCollectorConfig(buildAgentConfig(AGENT_SPEC));
    expect(rendered.split('\n').length).toBeGreaterThan(20);
  });
});
