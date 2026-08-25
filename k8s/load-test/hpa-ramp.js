/**
 * k6 ramp used to derive the autoscaling thresholds in docs/autoscaling.md.
 *
 *   k6 run \
 *     -e BASE_URL=https://app.staging.example.com \
 *     -e PEAK_RPS=600 \
 *     k8s/load-test/hpa-ramp.js
 *
 * What this measures, and why it is shaped like this:
 *
 *   • **An open model.** `ramping-arrival-rate` sends requests at a rate this
 *     script chooses, not at a rate the service allows. A closed model — N
 *     virtual users each waiting for a response — throttles itself the moment
 *     the service slows down, so the fleet never sees the load that was
 *     supposed to trigger a scale-up. Every measurement below depends on
 *     offered load being independent of served load.
 *
 *   • **A staircase, not a smooth ramp.** Each step holds a fixed rate long
 *     enough for the HPA to observe it, act, and settle (metrics-server scrape
 *     + HPA sync + pod start ≈ 90s, so steps are three minutes). A smooth ramp
 *     measures the autoscaler chasing a moving target; a staircase measures
 *     what one step costs, which is the number the thresholds are derived from.
 *
 *   • **A trough before the end.** `scaleDown.stabilizationWindowSeconds` is
 *     only observable if the load actually falls and stays down. The dip at the
 *     end is longer than the window under test, so the fleet has to decide
 *     whether to shrink.
 *
 * The thresholds are read off the run, not off this file. See
 * k8s/load-test/README.md for what to record while it is running — the HPA's
 * own replica count is not visible from inside k6.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
const PEAK_RPS = Number(__ENV.PEAK_RPS ?? 600);
/** Path that does representative work. A health endpoint measures the router. */
const PATH = __ENV.TARGET_PATH ?? '/api/items';

if (!BASE_URL) {
  throw new Error('BASE_URL is required, e.g. -e BASE_URL=https://app.staging.example.com');
}

/** Requests that returned 2xx, tagged by step so each step is readable alone. */
export const served = new Rate('served');
/** Server-side latency, separated from k6's own queueing. */
export const latency = new Trend('served_duration', true);

/**
 * The staircase, as `[fraction of PEAK_RPS, minutes]`.
 *
 * Kept as data rather than as k6 stages so the same list produces both the
 * stages and the elapsed-time boundaries used to tag each sample — a stage
 * object carrying an extra key would be handing k6 something outside its
 * schema.
 *
 *   • Warm-up, so the first measured step is not also the first thirty seconds
 *     of the JIT, the connection pool and the CDN.
 *   • Steps of 1.5–2×, each held three minutes: long enough for the HPA to
 *     observe, act and settle (~90s), which is the shape §3 of
 *     docs/autoscaling.md reads the headroom requirement off.
 *   • A trough longer than the scale-down stabilization window under test (10
 *     minutes in production), so a fleet that refuses to shrink is
 *     distinguishable from one that was never given the chance.
 *   • One more step up from the shrunken fleet, which is the case where the HPA
 *     and the Cluster Autoscaler are both moving at once.
 */
const STEPS = [
  [0.1, 2],
  [0.2, 3],
  [0.4, 3],
  [0.6, 3],
  [0.8, 3],
  [1.0, 5],
  [0.15, 12],
  [0.8, 5],
];

/** Offered rate per step, per second. */
const RATES = STEPS.map(([fraction]) => Math.round(PEAK_RPS * fraction));

/** Cumulative end of each step, in milliseconds since the run started. */
const STEP_ENDS = STEPS.reduce((ends, [, minutes], index) => {
  ends.push((index === 0 ? 0 : ends[index - 1]) + minutes * 60_000);
  return ends;
}, []);

/**
 * Which step a sample belongs to.
 *
 * k6 exposes no "current stage" for a `ramping-arrival-rate` scenario, and every
 * percentile in the summary is otherwise taken over the whole run — which
 * averages a 60 req/s step together with a 600 req/s one and hides the knee this
 * script exists to find.
 */
const currentStep = () => {
  const elapsed = exec.instance.currentTestRunDuration;
  const index = STEP_ENDS.findIndex((end) => elapsed < end);
  return index === -1 ? STEP_ENDS.length - 1 : index;
};

export const options = {
  scenarios: {
    staircase: {
      executor: 'ramping-arrival-rate',
      // The rate the first stage starts from. Equal to that stage's target, so
      // the warm-up is flat rather than a ramp.
      startRate: RATES[0],
      timeUnit: '1s',
      // Enough VUs that k6 itself is never the bottleneck: at the peak rate,
      // one VU per 20ms of latency plus a wide margin. If `dropped_iterations`
      // is non-zero the load generator ran out of VUs and the run is invalid.
      preAllocatedVUs: Math.max(50, Math.ceil(PEAK_RPS * 0.5)),
      maxVUs: Math.max(200, PEAK_RPS * 2),
      stages: STEPS.map(([, minutes], index) => ({
        target: RATES[index],
        duration: `${minutes}m`,
      })),
    },
  },
  thresholds: {
    // Not pass/fail criteria for the service; they are the run's own validity
    // conditions. A run that breaches either measured the load generator or the
    // network, and the thresholds it would produce are noise.
    dropped_iterations: ['count == 0'],
    http_req_failed: ['rate < 0.01'],
  },
  // p(99) is the statistic the knee shows up in first; the mean hides it
  // entirely. The end-of-run summary is still whole-run — splitting by step
  // means reading the tagged time series, which README.md shows how to do.
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(99)', 'max'],
};

export default function loadStep() {
  const index = currentStep();
  const tags = { step: String(index), offeredRps: String(RATES[index]) };

  const response = http.get(`${BASE_URL}${PATH}`, {
    tags,
    // Shorter than the pod's terminationGracePeriodSeconds, so a request that
    // outlives a rolling pod is recorded as slow rather than as a failure.
    timeout: '20s',
  });

  const ok = check(response, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 });

  served.add(ok, tags);
  if (ok) latency.add(response.timings.duration, tags);
}
