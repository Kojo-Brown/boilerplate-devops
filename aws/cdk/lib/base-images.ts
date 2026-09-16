/**
 * Every third-party container image this repository names, pinned by digest.
 *
 * A tag is a pointer the publisher can move. `:latest` moves on every release,
 * `:stable-alpine` moves on every patch, and even `:16-alpine` moves whenever
 * the base layer is rebuilt for a CVE — which is the point of that tag and also
 * why it is not a version. Nothing about a task definition changes when the tag
 * moves, so CloudFormation reports no drift, the next task placement pulls
 * different bytes from the same string, and the two tasks in one service can be
 * running different images with nothing in the console saying so. A digest is
 * the content address of a manifest: `registry/repo@sha256:…` resolves to the
 * same bytes forever or fails to resolve at all.
 *
 * The rules for this file:
 *
 *   • `reference` is what goes into a task definition. Digest form only —
 *     `repository@sha256:…`. Amazon ECS documents `repository:tag` and
 *     `repository@digest` as the two accepted forms and says nothing about the
 *     combined `repository:tag@digest` that Docker accepts, so the tag lives in
 *     `version` for humans and never in the string ECS is handed.
 *   • `version` is the release the digest was resolved from, so an upgrade is a
 *     readable diff rather than two opaque hex strings.
 *   • Both fields move together. A `version` bumped without its digest is worse
 *     than no pin at all, because it reads as one.
 *
 * `tools/audit-dependency-pins.ts` enforces that nothing in `lib/` or `bin/`
 * names a registry image outside this file, and that every entry here is in
 * digest form. See `docs/dependency-pinning.md` for how to resolve a digest and
 * how these are kept current.
 */

/** One pinned image: the digest a runtime pulls, and the release it came from. */
export interface PinnedImage {
  /** Digest-form reference — this is what goes into a task definition. */
  readonly reference: string;
  /** The tag this digest was resolved from, for readability and upgrades. */
  readonly version: string;
}

/**
 * Placeholder application image for the ECS, blue/green, canary and preview
 * stacks. Consumers override it with their own; the default exists so a fresh
 * `cdk deploy` produces a service that starts, listens and passes its health
 * check before any application image exists.
 *
 * Resolved from `public.ecr.aws/nginx/nginx:stable-alpine` on 2026-09-09.
 */
export const NGINX_PLACEHOLDER_IMAGE: PinnedImage = {
  reference:
    'public.ecr.aws/nginx/nginx@sha256:8d32e1ab9a199e9d83b66ada9823585379878433a9b22fa20110418a3e8a0baf',
  version: 'stable-alpine',
};

/**
 * The X-Ray daemon sidecar added to task definitions by `XRayStack`.
 *
 * This one is not a placeholder — it runs in production alongside every
 * instrumented task, and it was previously `:latest`, so the sidecar version
 * was whatever the last task placement happened to pull.
 *
 * Resolved from `public.ecr.aws/xray/aws-xray-daemon:3.7.0` on 2026-09-09.
 */
export const XRAY_DAEMON_IMAGE: PinnedImage = {
  reference:
    'public.ecr.aws/xray/aws-xray-daemon@sha256:b67576293f4d3a0a155f807244957ed0aa4bc945df1573d62d81380a1d548071',
  version: '3.7.0',
};

/**
 * Image providing `psql` for the preview environment's database admin task,
 * which creates and drops a database per pull request.
 *
 * Also not a placeholder: it holds credentials from Secrets Manager and runs
 * DDL against the shared preview instance, which is the last place to want an
 * image whose contents are decided by when a task happened to start.
 *
 * Resolved from `public.ecr.aws/docker/library/postgres:16-alpine` on
 * 2026-09-09. The major must keep matching the instance's
 * `rds.PostgresEngineVersion.VER_16` — `psql` warns and can refuse features
 * when it is older than the server it connects to.
 */
export const POSTGRES_CLIENT_IMAGE: PinnedImage = {
  reference:
    'public.ecr.aws/docker/library/postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685',
  version: '16-alpine',
};

/**
 * The AWS Distro for OpenTelemetry collector, run by `OtelCollectorStack` both
 * as the per-task agent sidecar and as the tail-sampling service.
 *
 * Also not a placeholder, and the one where a moving tag would be hardest to
 * notice: the two tiers must agree about what OTLP means and about how the
 * `load_balancing` exporter hashes a trace ID. They are separate task
 * definitions, so `:latest` on both would let a sampler task placed on Tuesday
 * and an agent task placed on Thursday run different collector builds, and the
 * symptom — a share of traces decided on a fraction of their spans — is
 * indistinguishable from the tier simply being undersized.
 *
 * Resolved from `public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0`
 * on 2026-09-16, by index digest rather than per-platform: ECS picks the
 * `linux/amd64` manifest out of it, and pinning the platform manifest instead
 * would break the moment a task definition asks for `ARM64` under Graviton.
 *
 * This release vendors opentelemetry-collector-contrib v0.158.0, which is what
 * fixes the component names the config in `otel-collector-config.ts` uses:
 * `load_balancing` (renamed from `loadbalancing` upstream, which survives only
 * as a deprecated alias) and the tail-sampling `drop` policy, which replaced
 * the deprecated `invert_match` decision.
 */
export const ADOT_COLLECTOR_IMAGE: PinnedImage = {
  reference:
    'public.ecr.aws/aws-observability/aws-otel-collector@sha256:7968fb60db6a2390a47ba6a2df029745638486e285c9b2487da1b722d0855a3e',
  version: 'v0.50.0',
};

/** Every pin in this file, for the audit and for `docs/dependency-pinning.md`. */
export const PINNED_IMAGES: readonly PinnedImage[] = [
  NGINX_PLACEHOLDER_IMAGE,
  XRAY_DAEMON_IMAGE,
  POSTGRES_CLIENT_IMAGE,
  ADOT_COLLECTOR_IMAGE,
];
