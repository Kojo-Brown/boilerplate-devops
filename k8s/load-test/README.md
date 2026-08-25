# Load test

`hpa-ramp.js` is the [k6](https://k6.io) run the autoscaling thresholds in
[docs/autoscaling.md](../../docs/autoscaling.md) are derived from. It exists so
that the numbers in `values.yaml` and in `EksStack` are re-derivable for a
service that is not the reference one, rather than copied.

**Nothing in CI runs it.** It needs a cluster with the chart installed, a
metrics-server, and a load generator outside the cluster — none of which CI has.
It is a procedure, not a gate.

## Running it

```bash
k6 run \
  -e BASE_URL=https://app.staging.example.com \
  -e TARGET_PATH=/api/items \
  -e PEAK_RPS=600 \
  --out json=ramp.json \
  k8s/load-test/hpa-ramp.js
```

`PEAK_RPS` is the top of the staircase and every step is a fraction of it, so
one number sizes the whole run. Set it to roughly twice the peak the service
actually sees: the point is to find where it stops coping, which is above where
it currently runs.

Run it against staging, not production, and against a release whose image tag
you have written down — a threshold derived from one build and applied to
another is a guess.

## What to record while it runs

k6 measures the client side. Everything about the autoscaler's *reaction* has to
come from the cluster, so run these three alongside it and keep the output:

```bash
# Replica count, current vs target utilization, one line per change.
kubectl get hpa app-staging -n staging --watch

# Per-pod CPU against the request. This is the denominator of the HPA's
# percentage — not node CPU, and not the limit.
kubectl top pods -n staging --containers --watch

# Why the Cluster Autoscaler did or did not add a node.
kubectl -n kube-system logs -l app.kubernetes.io/name=cluster-autoscaler -f
```

Four things come out of the run, and they are the four inputs §3 of
`docs/autoscaling.md` uses:

| Measurement | Read from | Used for |
|---|---|---|
| Requests per second one pod serves at its CPU request | `kubectl top` + the step's offered rate ÷ replica count | `maxReplicas` |
| The utilization at which p99 turns up sharply — the knee | `served_duration` p99 per step against `kubectl top` | `targetCPUUtilizationPercentage` |
| Seconds from a step to the new pods serving | HPA watch timestamps vs the step boundary | the scale-up policy |
| Seconds from a step to a *new node* serving | Cluster Autoscaler log vs the same boundary | `scaleDownDelayAfterAdd`, and whether the HPA can outrun its nodes |

## Reading it

Every metric is tagged with `step` and `offeredRps`, because a percentile over
the whole run averages the 60 req/s step together with the 600 req/s one and
hides the knee. With `--out json=ramp.json`:

```bash
jq -r 'select(.type=="Point" and .metric=="served_duration")
       | [.data.tags.offeredRps, .data.value] | @tsv' ramp.json \
  | sort -n | awk '{a[$1]=a[$1]" "$2} END {for (r in a) print r, a[r]}'
```

Two ways a run is invalid, both of which the script's own thresholds fail on:

- **`dropped_iterations` above zero.** k6 ran out of VUs, so the offered rate is
  not the rate in the stage — you measured the load generator. Raise `maxVUs`.
- **`http_req_failed` above 1%.** Something other than capacity is failing.
  Fix that first; a threshold derived from a run with errors in it encodes the
  errors.

A third, which nothing can detect for you: if the service is behind a cache or
a rate limiter, the staircase measures that and not the pods.
