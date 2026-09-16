/**
 * The two OpenTelemetry Collector configurations `OtelCollectorStack` deploys,
 * built from typed inputs and checked before they can reach a task definition.
 *
 * ## Why tail sampling needs two tiers and not one
 *
 * Head sampling — which is what `XRayStack`'s sampling rule and every SDK's
 * `traceidratio` sampler do — decides at the root span, before the request has
 * done anything. The decision is therefore made without the two facts anyone
 * actually wants to sample on: whether it failed, and whether it was slow. Tail
 * sampling moves the decision to after the trace is complete, which is the
 * whole point of this item.
 *
 * It buys that with a hard constraint, stated in the processor's own README and
 * routinely missed: **every span of a trace must reach the same collector
 * instance.** A collector tier behind a load balancer violates it by
 * construction — spans of one trace land on different instances, each of which
 * sees a fragment, and each makes a confident decision on its fragment. Nothing
 * fails. The pipeline is green, the collectors are healthy, and what arrives at
 * the backend is a mixture of whole traces, half traces and traces that were
 * kept by one instance and dropped by another. You find out when an incident
 * turns up a trace with the database span missing.
 *
 * So the deployment is two tiers with different jobs:
 *
 *   • **Agent** — a sidecar in the application's own task. It receives OTLP
 *     over the task's loopback, attaches ECS resource attributes (which only it
 *     can: the task metadata endpoint is per-task, so a central tier cannot
 *     know which task a span came from), and forwards with the
 *     `load_balancing` exporter keyed by trace ID. Consistent hashing over the
 *     trace ID is what makes the constraint above hold.
 *   • **Sampler** — a standalone service whose instances are the hash ring's
 *     backends. It runs `tail_sampling` and exports to X-Ray.
 *
 * A sidecar rather than a shared gateway tier for the agent because the app's
 * task is where the trace already is: it needs no load balancer, no extra
 * network hop, and it scales with the application for free. `XRayStack` ships
 * the X-Ray daemon the same way and for the same reason.
 *
 * ## What this module refuses to build
 *
 * Every rule in {@link validateSamplerSpec} is a configuration the collector
 * accepts and starts on. That is the point: a tail-sampling config cannot be
 * wrong loudly. It drops traces, and a dropped trace leaves nothing behind that
 * says it was dropped rather than never sent. The arithmetic ones —
 * `decision_wait` against the latency policy, `num_traces` against the arrival
 * rate — are each two numbers a reviewer could multiply and nobody does.
 *
 * ## Why the rendered config is JSON
 *
 * YAML 1.2 is a superset of JSON, and the collector resolves `--config=env:VAR`
 * by parsing the variable's contents as YAML, so a JSON document is a valid
 * collector config. Emitting JSON means no YAML serialiser in the synth path,
 * an exactly reproducible string (so a template diff shows a config change and
 * nothing else), and a value an operator can paste into a `config.yaml`
 * unchanged. See `docs/otel-collector.md` §2.
 */

/** A value that can appear in a rendered collector config. */
export type ConfigValue =
  | string
  | number
  | boolean
  | readonly ConfigValue[]
  | { readonly [key: string]: ConfigValue };

/** A rendered collector config, in the shape the collector parses. */
export interface CollectorConfig {
  readonly extensions: { readonly [key: string]: ConfigValue };
  readonly receivers: { readonly [key: string]: ConfigValue };
  readonly processors: { readonly [key: string]: ConfigValue };
  readonly exporters: { readonly [key: string]: ConfigValue };
  readonly service: { readonly [key: string]: ConfigValue };
}

/* ── Ports ────────────────────────────────────────────────────────────────── */

/** OTLP/gRPC. The agent listens on loopback; the sampler on the task ENI. */
export const OTLP_GRPC_PORT = 4317;
/** OTLP/HTTP, agent only — SDKs that cannot speak gRPC still need a target. */
export const OTLP_HTTP_PORT = 4318;
/**
 * The `health_check` extension, and the port the collector image's own
 * `/healthcheck` binary probes. It takes a `-port` flag but defaults to this,
 * and the container health check below relies on the default.
 */
export const HEALTH_CHECK_PORT = 13133;
/**
 * The collector's own Prometheus endpoint, which the `prometheus` receiver in
 * the same process scrapes. This is the collector's default rather than
 * something this config sets — see {@link serviceTelemetry} for why overriding
 * it would cost more than it buys.
 */
export const SELF_TELEMETRY_PORT = 8888;

/* ── Tail-sampling policies ───────────────────────────────────────────────── */

/**
 * The policy set, as this repository parameterises it.
 *
 * Deliberately not "any policy the processor supports": the processor combines
 * policies with OR — a trace is sampled if *any* policy says so — and that is
 * the single most misread thing about it. Adding a `probabilistic` policy at
 * 10% alongside an `errors` policy does not cap anything at 10%; it adds 10% to
 * whatever the errors policy already kept. A free-form list would let a caller
 * express "cap at 10%" in a way that reads correct and is not, so the shape
 * here is the one composition that means what it looks like:
 *
 *   errors OR slow OR (baseline% AND not a health check)
 */
export interface TailSamplingSpec {
  /**
   * How long the processor holds a trace before deciding, in seconds.
   *
   * Must exceed the duration of the traces you want to catch. A trace still in
   * flight when the timer fires is decided on the spans seen so far, so a
   * `decision_wait` below the latency threshold systematically misses exactly
   * the slow traces the latency policy exists to keep. Enforced below.
   */
  readonly decisionWaitSeconds: number;
  /**
   * Traces held in memory. The processor keeps them in a circular buffer, so
   * once this is exceeded the oldest trace is evicted — before its decision
   * timer has fired, and counted as `sampling_trace_dropped_too_early`. It must
   * therefore hold a full `decision_wait` of arrivals, with headroom for a
   * burst. Enforced below.
   */
  readonly numTraces: number;
  /** Expected new traces per second; sizes the processor's data structures. */
  readonly expectedNewTracesPerSec: number;
  /** Trace duration at or above which a trace is kept regardless of outcome. */
  readonly latencyThresholdMs: number;
  /** Percentage of ordinary traces kept, 0–100 exclusive of both ends. */
  readonly baselinePercentage: number;
  /**
   * Request paths whose traces are dropped outright.
   *
   * Matched as regular expressions against `url.path`, and against the
   * pre-1.0 semconv spelling `http.target` as well — an SDK that has not
   * migrated emits only the latter, and a policy naming only the former reads
   * as working and matches nothing.
   */
  readonly dropUrlPathPatterns: readonly string[];
}

/** Defaults sized for the reference workload in `docs/otel-collector.md` §4. */
export const DEFAULT_TAIL_SAMPLING: TailSamplingSpec = {
  decisionWaitSeconds: 30,
  numTraces: 200_000,
  expectedNewTracesPerSec: 2_000,
  latencyThresholdMs: 2_000,
  baselinePercentage: 5,
  dropUrlPathPatterns: ['^/health$', '^/healthz$', '^/ready$', '^/metrics$'],
};

/** Attribute keys carrying the request path, newest semconv spelling first. */
const URL_PATH_KEYS = ['url.path', 'http.target'] as const;

/**
 * Reject a spec the collector would happily start on.
 *
 * Throws rather than returning findings: this runs during `cdk synth`, so a
 * violation should fail the build at the line that caused it. Every message
 * names the two numbers that disagree, because the fix is always to change one
 * of them and the reader needs to know which.
 */
export const validateSamplingSpec = (spec: TailSamplingSpec, context: string): void => {
  const fail = (message: string): never => {
    throw new Error(`${context}: ${message}`);
  };

  if (spec.decisionWaitSeconds <= 0) {
    fail(`decisionWaitSeconds must be positive, got ${spec.decisionWaitSeconds}.`);
  }

  if (spec.latencyThresholdMs <= 0) {
    fail(`latencyThresholdMs must be positive, got ${spec.latencyThresholdMs}.`);
  }

  // The rule this whole processor is most often defeated by. A trace is decided
  // `decision_wait` after its *first* span; a trace that takes longer than that
  // is judged on a prefix of itself, and the latency policy — which is looking
  // for a total duration it will never observe — never fires.
  const decisionWaitMs = spec.decisionWaitSeconds * 1_000;
  if (decisionWaitMs <= spec.latencyThresholdMs) {
    fail(
      `decisionWaitSeconds (${spec.decisionWaitSeconds}s = ${decisionWaitMs}ms) must exceed ` +
        `latencyThresholdMs (${spec.latencyThresholdMs}ms). The decision timer starts at the ` +
        `first span, so a trace slower than decision_wait is decided on the spans seen so far ` +
        `and the latency policy never observes a duration above its threshold — the slowest ` +
        `traces are the ones it silently misses.`,
    );
  }

  // Sizing, not taste: the buffer has to survive a full decision window of
  // arrivals or it evicts traces before deciding them. 2x is the headroom for a
  // burst; below 1x the processor is dropping traces at steady state.
  const inFlightAtSteadyState = spec.expectedNewTracesPerSec * spec.decisionWaitSeconds;
  if (spec.numTraces < inFlightAtSteadyState * 2) {
    fail(
      `numTraces (${spec.numTraces}) is below twice the traces in flight at steady state ` +
        `(${spec.expectedNewTracesPerSec}/s x ${spec.decisionWaitSeconds}s = ` +
        `${inFlightAtSteadyState}). The processor holds traces in a circular buffer, so the ` +
        `oldest is evicted before its decision timer fires and is counted as ` +
        `sampling_trace_dropped_too_early. Raise numTraces or shorten decisionWaitSeconds.`,
    );
  }

  if (spec.expectedNewTracesPerSec <= 0) {
    fail(`expectedNewTracesPerSec must be positive, got ${spec.expectedNewTracesPerSec}.`);
  }

  // 100 would be `always_sample` written in a way that hides it: the baseline
  // branch would keep everything, and the errors and latency policies would
  // stop having any effect on what is retained. 0 is the mirror image — a
  // policy that exists, evaluates, and can never sample anything.
  if (spec.baselinePercentage <= 0 || spec.baselinePercentage >= 100) {
    fail(
      `baselinePercentage must be between 0 and 100 exclusive, got ${spec.baselinePercentage}. ` +
        `100 keeps every trace and makes the error and latency policies inert; 0 is a policy ` +
        `that can never sample.`,
    );
  }

  if (spec.dropUrlPathPatterns.length === 0) {
    fail(
      `dropUrlPathPatterns is empty. Health-check and metrics-scrape traces arrive at the ` +
        `interval of whatever polls them and are identical to each other, so they dominate the ` +
        `baseline sample and push real traffic out of it. Pass at least one pattern.`,
    );
  }

  for (const pattern of spec.dropUrlPathPatterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      // The processor compiles these at start-up and refuses to boot on a bad
      // one, which means a task that crash-loops after deploy rather than a
      // failed synth. Catch it here instead.
      fail(
        `dropUrlPathPatterns entry ${JSON.stringify(pattern)} is not a valid regular ` +
          `expression (${(error as Error).message}). The processor compiles these at start-up ` +
          `and refuses to run, so this is a crash-looping task rather than a failed deploy.`,
      );
    }
  }
};

/** The `tail_sampling` processor block for a validated spec. */
const tailSamplingProcessor = (spec: TailSamplingSpec): ConfigValue => ({
  decision_wait: `${spec.decisionWaitSeconds}s`,
  num_traces: spec.numTraces,
  expected_new_traces_per_sec: spec.expectedNewTracesPerSec,
  // Decisions outlive the spans they were made from. A span arriving after its
  // trace has been released from memory would otherwise start a *new* trace and
  // be decided on its own, so a late database span is judged without the error
  // its parent recorded. Sized well above num_traces as the processor's README
  // asks, since a decision is a trace ID and a bit while a trace is every span.
  decision_cache: {
    sampled_cache_size: spec.numTraces * 5,
    non_sampled_cache_size: spec.numTraces * 5,
  },
  policies: [
    // Ordered for readers only — the processor evaluates all of them and ORs
    // the results, so the position of a policy in this list means nothing.
    //
    // One `drop` policy per attribute key, each holding exactly one
    // sub-policy, and that is load-bearing rather than stylistic: `drop`
    // combines its sub-policies with AND — it drops only when every one of
    // them matched. Listing both spellings inside a single `drop` would
    // therefore drop a trace only if it carried `url.path` *and*
    // `http.target`, which no SDK emits; the two spellings are alternatives,
    // so an SDK on either semconv version would have had every health check
    // sampled. As separate top-level policies they are OR'd, which is the
    // intended "either spelling matches".
    //
    // Dropped before anything else can keep them: a `drop` decision is
    // terminal, where the deprecated `invert_match` produced an "inverted"
    // decision an ordinary sample decision elsewhere could override. A health
    // check that errors is dropped too, which is intended — that is the load
    // balancer's business and already an ALB target-group alarm.
    ...URL_PATH_KEYS.map((key) => ({
      name: `drop-synthetic-traffic-by-${key}`,
      type: 'drop',
      drop: {
        drop_sub_policy: [
          {
            name: `match-${key}`,
            type: 'string_attribute',
            string_attribute: {
              key,
              values: spec.dropUrlPathPatterns,
              enabled_regex_matching: true,
            },
          },
        ],
      },
    })),
    {
      name: 'keep-errors',
      type: 'status_code',
      // ERROR only. UNSET is the default status of every span nobody called
      // SetStatus on, which is most of them, so including it keeps everything.
      status_code: { status_codes: ['ERROR'] },
    },
    {
      name: 'keep-slow',
      type: 'latency',
      // No upper_threshold_ms: anything slower than the threshold is kept,
      // including the pathological outliers, which are the interesting ones.
      latency: { threshold_ms: spec.latencyThresholdMs },
    },
    {
      name: 'keep-baseline-sample',
      type: 'probabilistic',
      probabilistic: {
        // Hashed from the trace ID, so the same trace gets the same answer from
        // every sampler instance — which matters during a scale event, when a
        // trace's spans can briefly be split across two owners.
        sampling_percentage: spec.baselinePercentage,
      },
    },
  ],
});

/* ── Self-telemetry ───────────────────────────────────────────────────────── */

/**
 * Collector metrics published to CloudWatch, and nothing else.
 *
 * The `awsemf` exporter publishes every metric it is handed when
 * `metric_declarations` is empty, and the collector's own Prometheus endpoint
 * exposes several hundred series. That is a working pipeline and a CloudWatch
 * custom-metric bill that arrives a month later, so the list is an allowlist.
 *
 * Each entry earns its place by being the only evidence of a failure that is
 * otherwise silent — see `docs/otel-collector.md` §6. `OtelCollectorStack`
 * alarms on the first four.
 */
export const PUBLISHED_COLLECTOR_METRICS: readonly string[] = [
  // Traces evicted from the buffer before their decision timer fired. The
  // failure this whole config is sized against, and invisible without this.
  'otelcol_processor_tail_sampling_sampling_trace_dropped_too_early',
  // Spans the memory limiter refused. Back-pressure, i.e. data loss upstream.
  'otelcol_processor_refused_spans',
  // Spans an exporter gave up on. On the agent this is the sampler tier being
  // unreachable; on the sampler it is X-Ray rejecting segments.
  'otelcol_exporter_send_failed_spans',
  // Backends the agent's resolver found. Zero is the shape of every mistake in
  // the Cloud Map wiring — wrong region, wrong namespace, missing permission —
  // and every one of them leaves a healthy task forwarding into nothing.
  'otelcol_loadbalancer_num_backends',
  // Kept for dashboards rather than alarms: the ratio of these two is the
  // actual sampling rate, which is the number people assume they know.
  'otelcol_processor_tail_sampling_global_count_traces_sampled',
  'otelcol_receiver_accepted_spans',
  'otelcol_exporter_sent_spans',
];

/** Namespace holding the published collector metrics for an environment. */
export const metricNamespace = (envName: string): string => `OTelCollector/${envName}`;

/**
 * The self-telemetry half of a pipeline: scrape our own Prometheus endpoint,
 * publish the allowlist to CloudWatch as EMF.
 *
 * `tier` becomes the log stream, so the agent's and the sampler's series stay
 * distinguishable in one namespace.
 */
const selfTelemetry = (
  envName: string,
  tier: 'agent' | 'sampler',
  logGroupName: string,
): { receiver: ConfigValue; exporter: ConfigValue } => ({
  receiver: {
    config: {
      scrape_configs: [
        {
          job_name: `otel-collector-${tier}`,
          // A minute, not the Prometheus-idiomatic fifteen seconds: these
          // become CloudWatch custom metrics, which are billed per metric and
          // resolved to the minute anyway.
          scrape_interval: '60s',
          static_configs: [{ targets: [`localhost:${SELF_TELEMETRY_PORT}`] }],
        },
      ],
    },
  },
  exporter: {
    namespace: metricNamespace(envName),
    log_group_name: logGroupName,
    log_stream_name: `self-telemetry/${tier}`,
    // The default, ZeroAndSingleDimensionRollup, publishes each metric again
    // once per individual label — the same data at several prices.
    dimension_rollup_option: 'NoDimensionRollup',
    metric_declarations: [
      {
        // No dimensions: every series of a metric lands on one CloudWatch
        // metric, so an alarm on it is "is this happening anywhere in the
        // tier" rather than one alarm per policy or per endpoint.
        dimensions: [[]],
        metric_name_selectors: PUBLISHED_COLLECTOR_METRICS.map(
          (name) => `^${name}$`,
        ),
      },
    ],
  },
});

/**
 * `service.telemetry`.
 *
 * **`metrics` is deliberately absent**, which is the one place in this module
 * where saying nothing is safer than being explicit. The collector's default
 * metrics configuration is already a Prometheus pull reader on
 * `localhost:8888` — the port {@link SELF_TELEMETRY_PORT} names and the
 * receiver scrapes — with `without_units` and `without_type_suffix` set, which
 * is what makes the exported names the suffix-free ones in
 * {@link PUBLISHED_COLLECTOR_METRICS}.
 *
 * Restating that block would not restate those two flags unless every one of
 * them were written out, because `readers` is a *list*: confmap merges maps
 * and replaces sequences, so any `readers:` at all discards the default entry
 * rather than amending it, and the replacement's unset fields fall back to the
 * Go zero value rather than to the default config. The visible consequence is
 * that every metric name grows a unit and type suffix — so the allowlist in
 * the EMF exporter matches nothing, CloudWatch receives no collector metrics,
 * and four alarms sit at INSUFFICIENT_DATA looking like a quiet system.
 *
 * `logs` below is safe to set for exactly the reason `metrics` is not: it is a
 * map, so these two keys merge over the defaults instead of replacing them.
 */
const serviceTelemetry = (): ConfigValue => ({
  logs: { level: 'info', encoding: 'json' },
});

/**
 * The memory limiter, which must be the first processor in every pipeline.
 *
 * Percentages rather than absolute MiB so one config is correct at both tiers'
 * task sizes. Placed first because its job is to refuse data at the door: after
 * any other processor, the memory it is trying to protect has already been
 * allocated.
 */
const memoryLimiter = (): ConfigValue => ({
  check_interval: '1s',
  limit_percentage: 75,
  spike_limit_percentage: 20,
});

/* ── Agent ────────────────────────────────────────────────────────────────── */

export interface AgentConfigSpec {
  readonly envName: string;
  /** Cloud Map namespace the sampler service registers into. */
  readonly namespaceName: string;
  /** Cloud Map service name of the sampler tier. */
  readonly samplerServiceName: string;
  /** Log group the agent publishes its own metrics to, as EMF. */
  readonly metricsLogGroupName: string;
}

/**
 * The sidecar's config: receive OTLP on loopback, forward by trace ID.
 *
 * No `batch` processor. The `load_balancing` exporter regroups every batch by
 * trace ID before handing it to a per-backend OTLP exporter, so batching ahead
 * of it buys nothing and adds latency to a decision that is already waiting on
 * `decision_wait`; the per-backend exporters batch on their own queues.
 */
export const buildAgentConfig = (spec: AgentConfigSpec): CollectorConfig => {
  const telemetry = selfTelemetry(spec.envName, 'agent', spec.metricsLogGroupName);

  return {
    extensions: {
      health_check: { endpoint: `localhost:${HEALTH_CHECK_PORT}` },
    },
    receivers: {
      // Loopback, not 0.0.0.0. Containers in an awsvpc task share one network
      // namespace, so the application reaches the sidecar over localhost and
      // binding the task ENI would expose an unauthenticated OTLP endpoint to
      // everything the task's security group admits.
      otlp: {
        protocols: {
          grpc: { endpoint: `localhost:${OTLP_GRPC_PORT}` },
          http: { endpoint: `localhost:${OTLP_HTTP_PORT}` },
        },
      },
      prometheus: telemetry.receiver,
    },
    processors: {
      memory_limiter: memoryLimiter(),
      // Only the sidecar can do this: the ECS task metadata endpoint is
      // per-task, so cluster, task ARN, task family and revision are knowable
      // here and nowhere downstream. `override: false` keeps anything the
      // application's own SDK already set.
      resourcedetection: {
        detectors: ['env', 'ecs'],
        timeout: '5s',
        override: false,
      },
    },
    exporters: {
      load_balancing: {
        // The default for traces, written out because it is the property the
        // whole two-tier design rests on: `service` would route every trace of
        // one service to one sampler, which balances nothing and still splits
        // a cross-service trace across instances.
        routing_key: 'traceID',
        resolver: {
          // The Cloud Map API rather than DNS. Cloud Map's DNS answers are
          // Route 53 multivalue records, which return at most eight addresses
          // per query: a sampler tier larger than eight would route to an
          // arbitrary eight of its instances, and two agents resolving
          // different eights would build different hash rings — which splits
          // traces across samplers, the one thing this design exists to
          // prevent. `DiscoverInstances` returns the whole registration.
          aws_cloud_map: {
            namespace: spec.namespaceName,
            service_name: spec.samplerServiceName,
            // Explicit, and load-bearing. Without it the resolver reads the
            // port from each instance's AWS_INSTANCE_PORT attribute, which
            // only exists on SRV registrations; an A-record registration
            // yields `10.0.1.4:` and every export fails to connect.
            port: OTLP_GRPC_PORT,
            // Fail open. HEALTHY alone means that a lag in health propagation
            // — a deploy, a scale event — resolves to zero backends, and an
            // agent with no backends drops every span. Routing to a task that
            // is draining loses the traces in flight to it; routing to nothing
            // loses all of them.
            health_status: 'HEALTHY_OR_ELSE_ALL',
            interval: '10s',
            timeout: '5s',
          },
        },
        protocol: {
          otlp: {
            // Plaintext inside the VPC, between two security groups that admit
            // only each other. TLS here would need a private CA and rotation
            // for a hop that never leaves the subnet; `insecure: false` with no
            // certificates would simply fail to connect.
            tls: { insecure: true },
            timeout: '10s',
            sending_queue: { enabled: true, num_consumers: 4, queue_size: 1000 },
            retry_on_failure: {
              enabled: true,
              initial_interval: '1s',
              max_interval: '10s',
              max_elapsed_time: '60s',
            },
          },
        },
      },
      awsemf: telemetry.exporter,
    },
    service: {
      extensions: ['health_check'],
      telemetry: serviceTelemetry(),
      pipelines: {
        traces: {
          receivers: ['otlp'],
          processors: ['memory_limiter', 'resourcedetection'],
          exporters: ['load_balancing'],
        },
        'metrics/self': {
          receivers: ['prometheus'],
          processors: ['memory_limiter'],
          exporters: ['awsemf'],
        },
      },
    },
  };
};

/* ── Sampler ──────────────────────────────────────────────────────────────── */

export interface SamplerConfigSpec {
  readonly envName: string;
  readonly sampling: TailSamplingSpec;
  /** Log group the sampler publishes its own metrics to, as EMF. */
  readonly metricsLogGroupName: string;
  /** X-Ray indexed annotation keys, from span attributes of the same name. */
  readonly indexedAttributes: readonly string[];
}

/**
 * The sampler tier's config: receive from the agents, decide, export to X-Ray.
 *
 * `batch` runs *after* `tail_sampling` and not before. The processor reassembles
 * spans into new batches of its own as it groups them by trace, so a batch
 * processor ahead of it does work that is immediately undone; behind it, it is
 * batching the spans that survived, which is where batching pays.
 */
export const buildSamplerConfig = (spec: SamplerConfigSpec): CollectorConfig => {
  validateSamplingSpec(spec.sampling, `sampler config for ${spec.envName}`);

  const telemetry = selfTelemetry(spec.envName, 'sampler', spec.metricsLogGroupName);

  return {
    extensions: {
      // 0.0.0.0 here, unlike the agent: this one is also the ECS container
      // health check's target and has to answer on the task ENI.
      health_check: { endpoint: `0.0.0.0:${HEALTH_CHECK_PORT}` },
    },
    receivers: {
      otlp: { protocols: { grpc: { endpoint: `0.0.0.0:${OTLP_GRPC_PORT}` } } },
      prometheus: telemetry.receiver,
    },
    processors: {
      memory_limiter: memoryLimiter(),
      tail_sampling: tailSamplingProcessor(spec.sampling),
      batch: { timeout: '5s', send_batch_size: 200, send_batch_max_size: 500 },
    },
    exporters: {
      awsxray: {
        // Annotations are the only span attributes X-Ray will filter on. An
        // attribute not named here is still on the segment and still visible,
        // but no console filter expression or GetTraceSummaries call can
        // select by it — which reads as "the data is there" right up until
        // someone needs to find one trace among a day of them.
        indexed_attributes: spec.indexedAttributes,
        // Off deliberately: promoting every attribute to an annotation hits
        // X-Ray's 50-annotation-per-segment limit, and what is dropped past it
        // is decided by iteration order.
        index_all_attributes: false,
      },
      awsemf: telemetry.exporter,
    },
    service: {
      extensions: ['health_check'],
      telemetry: serviceTelemetry(),
      pipelines: {
        traces: {
          receivers: ['otlp'],
          processors: ['memory_limiter', 'tail_sampling', 'batch'],
          exporters: ['awsxray'],
        },
        'metrics/self': {
          receivers: ['prometheus'],
          processors: ['memory_limiter'],
          exporters: ['awsemf'],
        },
      },
    },
  };
};

/**
 * Render a config for `--config=env:…`.
 *
 * Stable key order (whatever the builders wrote) and two-space indentation, so
 * the value embedded in a task definition diffs line by line when a policy
 * changes rather than as one opaque string.
 */
export const renderCollectorConfig = (config: CollectorConfig): string =>
  JSON.stringify(config, null, 2);
