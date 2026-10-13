/**
 * What this repository runs, on which processor architecture, and what moving
 * each one to Graviton is worth.
 *
 * Two halves, and the split matters because only one of them is measured here:
 *
 *   • **The prices are measured.** Every number in {@link ARCHITECTURE_PRICES}
 *     was read out of AWS's own public price list — `https://pricing.us-east-1.
 *     amazonaws.com/offers/v1.0/aws/<offer>/current/us-east-1/index.json`, which
 *     needs no credentials — and each observation carries the SKU it came from
 *     and the `publicationDate` of the offer file it was read from. A price with
 *     no SKU beside it is a number somebody remembered.
 *
 *   • **The performance is not.** Nothing in this repository has ever run on an
 *     arm64 host: CI is `ubuntu-latest`, and measuring a Graviton instance needs
 *     an AWS account, which a fork's pull request cannot have. So
 *     {@link BENCHMARK_CLAIMS} holds vendor claims, each marked
 *     `measured: false` with the page it came from, and `tools/audit-graviton.ts`
 *     refuses a claim that says otherwise without an artifact. The one number
 *     this repository can state about performance is a *bound*: see
 *     {@link slowdownTolerance}.
 *
 * The reason the catalogue exists rather than a document: a migration guide is
 * prose, and prose cannot be wrong in a way that fails a build. Every claim in
 * `docs/graviton.md` is either a row rendered from this file
 * ({@link renderPriceTable}, {@link renderWorkloadTable}) or a predicate over it
 * that `tools/audit-graviton.ts` evaluates against the synthesised
 * CloudFormation. The workload table in particular is a claim about what
 * *deploys*, which is why the audit reads `cdk.out` rather than this file's own
 * `architecture` field.
 *
 * No CDK tokens in here, deliberately: this is data a reviewer can read in a
 * diff and a test can do arithmetic on.
 */

import {
  ADOT_COLLECTOR_IMAGE,
  NGINX_PLACEHOLDER_IMAGE,
  POSTGRES_CLIENT_IMAGE,
  type PinnedImage,
  XRAY_DAEMON_IMAGE,
} from './base-images';

/* ── Prices ────────────────────────────────────────────────────────────────── */

/** The region every price here is for. Graviton discounts are not uniform across regions. */
export const PRICE_REGION = 'us-east-1';

/** The date the offer files below were read. Not the date they were published. */
export const PRICES_READ_ON = '2026-10-13';

export type PriceId =
  | 'lambda-gb-second'
  | 'fargate-vcpu-hour'
  | 'fargate-gb-hour'
  | 'ec2-m-large-hour-graviton3'
  | 'ec2-m-large-hour-graviton4'
  | 'rds-postgres-t-medium-single-az'
  | 'rds-postgres-t-medium-multi-az'
  | 'elasticache-redis-t-small-hour';

/** One side of a price pair, as the price list describes it. */
export interface PriceSide {
  /** What AWS calls it: an instance class, or the usage type for a serverless meter. */
  readonly descriptor: string;
  /** The price list SKU. This is what makes the number re-derivable. */
  readonly sku: string;
  /** On-demand USD per {@link PriceObservation.unit}. */
  readonly usd: number;
}

export interface PriceObservation {
  readonly id: PriceId;
  /** Service as a reader would name it. */
  readonly service: string;
  /** The unit both sides are priced in. */
  readonly unit: string;
  readonly x86: PriceSide;
  /** The Graviton side, plus which Graviton generation the price list says it is. */
  readonly graviton: PriceSide & { readonly processor: string };
  /** Offer code of the price list file, e.g. `AmazonECS`. */
  readonly offerCode: string;
  /** `publicationDate` of that file, verbatim. */
  readonly offerPublicationDate: string;
  /** Anything about the pair a reader would otherwise get wrong. */
  readonly note?: string;
}

/**
 * Every price pair that governs a workload in {@link COMPUTE_WORKLOADS}.
 *
 * The spread is the point. "Graviton is 20% cheaper" is true of two of these
 * eight rows; the ElastiCache node this repository actually runs is 5.9%, and
 * the newest Graviton generation is *more* expensive per hour than the one
 * before it. See {@link gravitonGenerationPremium}.
 */
export const ARCHITECTURE_PRICES: readonly PriceObservation[] = [
  {
    id: 'lambda-gb-second',
    service: 'AWS Lambda',
    unit: 'GB-second',
    x86: { descriptor: 'Lambda-GB-Second', sku: 'TG3M4CAGBA3NYQBH', usd: 0.0000166667 },
    graviton: {
      descriptor: 'Lambda-GB-Second-ARM',
      sku: '72SBSFWPMDTH8S3J',
      usd: 0.0000133334,
      processor: 'AWS Graviton2',
    },
    offerCode: 'AWSLambda',
    offerPublicationDate: '2026-10-12T22:32:57Z',
    note:
      'First-tier price. Both architectures tier down at the same three ' +
      'thresholds and by the same proportion, so the saving is flat across tiers.',
  },
  {
    id: 'fargate-vcpu-hour',
    service: 'AWS Fargate (ECS)',
    unit: 'vCPU-hour',
    x86: { descriptor: 'USE1-Fargate-vCPU-Hours:perCPU', sku: '8CESGAFWKAJ98PME', usd: 0.04048 },
    graviton: {
      descriptor: 'USE1-Fargate-ARM-vCPU-Hours:perCPU',
      sku: 'XSZATS4VYMDC9CYN',
      usd: 0.03238,
      processor: 'AWS Graviton2',
    },
    offerCode: 'AmazonECS',
    offerPublicationDate: '2026-09-11T12:44:25Z',
  },
  {
    id: 'fargate-gb-hour',
    service: 'AWS Fargate (ECS)',
    unit: 'GB-hour',
    x86: { descriptor: 'USE1-Fargate-GB-Hours', sku: 'PBZNQUSEXZUC34C9', usd: 0.004445 },
    graviton: {
      descriptor: 'USE1-Fargate-ARM-GB-Hours',
      sku: 'UNH9KPQP7W7C66C9',
      usd: 0.00356,
      processor: 'AWS Graviton2',
    },
    offerCode: 'AmazonECS',
    offerPublicationDate: '2026-09-11T12:44:25Z',
    note:
      'Not the same proportion as the vCPU meter, which is why a task’s saving ' +
      'depends on its cpu:memory ratio. See blendedFargateSaving().',
  },
  {
    id: 'ec2-m-large-hour-graviton3',
    service: 'Amazon EC2 (Linux, shared tenancy)',
    unit: 'instance-hour',
    x86: { descriptor: 'm6i.large', sku: 'B8JJ44GS8MG4RPR4', usd: 0.096 },
    graviton: {
      descriptor: 'm7g.large',
      sku: 'Y4JWUCG93UEP6MPT',
      usd: 0.0816,
      processor: 'AWS Graviton3',
    },
    offerCode: 'AmazonEC2',
    offerPublicationDate: '2026-10-12T19:39:25Z',
    note: 'Both 2 vCPU / 8 GiB, so this pair compares hours rather than shapes.',
  },
  {
    id: 'ec2-m-large-hour-graviton4',
    service: 'Amazon EC2 (Linux, shared tenancy)',
    unit: 'instance-hour',
    x86: { descriptor: 'm6i.large', sku: 'B8JJ44GS8MG4RPR4', usd: 0.096 },
    graviton: {
      descriptor: 'm8g.large',
      sku: 'Z8TKGW7334QJC4HM',
      usd: 0.08976,
      processor: 'AWS Graviton4',
    },
    offerCode: 'AmazonEC2',
    offerPublicationDate: '2026-10-12T19:39:25Z',
    note:
      'Here so that the newest generation is priced rather than assumed: m8g.large ' +
      'costs 10% more per hour than m7g.large.',
  },
  {
    id: 'rds-postgres-t-medium-single-az',
    service: 'Amazon RDS for PostgreSQL (Single-AZ)',
    unit: 'instance-hour',
    x86: { descriptor: 'db.t3.medium', sku: '2V4Z46C2HCZPQCUW', usd: 0.072 },
    graviton: {
      descriptor: 'db.t4g.medium',
      sku: '6T9XP2QUFF4B5P26',
      usd: 0.065,
      processor: 'AWS Graviton2',
    },
    offerCode: 'AmazonRDS',
    offerPublicationDate: '2026-10-06T22:40:50Z',
  },
  {
    id: 'rds-postgres-t-medium-multi-az',
    service: 'Amazon RDS for PostgreSQL (Multi-AZ)',
    unit: 'instance-hour',
    x86: { descriptor: 'db.t3.medium', sku: 'ZK5MCA7TTVR2MRC7', usd: 0.145 },
    graviton: {
      descriptor: 'db.t4g.medium',
      sku: 'SCBZU9XX357QUA4D',
      usd: 0.129,
      processor: 'AWS Graviton2',
    },
    offerCode: 'AmazonRDS',
    offerPublicationDate: '2026-10-06T22:40:50Z',
    note:
      'A different saving from the Single-AZ row for the same two classes, because ' +
      'Multi-AZ is not exactly twice Single-AZ on either side. Production is Multi-AZ.',
  },
  {
    id: 'elasticache-redis-t-small-hour',
    service: 'Amazon ElastiCache for Redis',
    unit: 'node-hour',
    x86: { descriptor: 'cache.t3.small', sku: '7MEFGT8G577Q9EPY', usd: 0.034 },
    graviton: {
      descriptor: 'cache.t4g.small',
      sku: 'BYFG57CPZSFUXSSY',
      usd: 0.032,
      processor: 'AWS Graviton2',
    },
    offerCode: 'AmazonElastiCache',
    offerPublicationDate: '2026-09-14T06:37:14Z',
    note: 'The smallest saving of any service here, and identical 2 vCPU / 1.37 GiB on both sides.',
  },
];

const PRICES_BY_ID = new Map(ARCHITECTURE_PRICES.map((price) => [price.id, price]));

/** The observation with this id, or `undefined` if the catalogue has no such row. */
export const priceById = (id: string): PriceObservation | undefined => PRICES_BY_ID.get(id as PriceId);

/**
 * Fraction of the x86 price the Graviton side saves, as a number in [0, 1).
 *
 * Derived, never stored: a saving written down next to the two prices it came
 * from is a third number that can disagree with them.
 */
export const savingFraction = (price: PriceObservation): number =>
  (price.x86.usd - price.graviton.usd) / price.x86.usd;

/**
 * How much slower the Graviton side may be, per unit of work, before the price
 * saving is gone.
 *
 * This is the only performance statement this repository can make without an
 * AWS account, and it is the useful one, because it says what a benchmark would
 * have to show. A 20% cheaper hour buys 25% more hours; a 5.9% cheaper hour buys
 * 6.3%. The service with the smallest price gap therefore needs the *strongest*
 * performance evidence — which is the opposite of where anyone bothers to
 * measure.
 */
export const slowdownTolerance = (price: PriceObservation): number =>
  price.x86.usd / price.graviton.usd - 1;

/**
 * What a Fargate task of this shape saves by moving to ARM64.
 *
 * The vCPU and memory meters are discounted by different proportions
 * (20.01% and 19.91%), so there is no single Fargate percentage: a task's saving
 * sits between the two and is decided by its own cpu:memory ratio. `cpuUnits` is
 * the task definition's `cpu` (1024 = 1 vCPU) and `memoryMiB` its
 * `memoryLimitMiB`, so the arguments are the two numbers the stack already has.
 */
export const blendedFargateSaving = (cpuUnits: number, memoryMiB: number): number => {
  const vcpu = priceById('fargate-vcpu-hour');
  const memory = priceById('fargate-gb-hour');
  if (!vcpu || !memory) throw new Error('blendedFargateSaving: Fargate prices missing');
  const vcpus = cpuUnits / 1024;
  const gib = memoryMiB / 1024;
  const x86 = vcpus * vcpu.x86.usd + gib * memory.x86.usd;
  const arm = vcpus * vcpu.graviton.usd + gib * memory.graviton.usd;
  return (x86 - arm) / x86;
};

/**
 * What the newest Graviton generation costs over the one before it, for the same
 * instance size.
 *
 * Positive means the newer generation is dearer per hour, which it is: a
 * migration target is a generation, not "Graviton", and picking the newest one
 * is a performance bet that shows up as a higher bill until the benchmark comes
 * back.
 */
export const gravitonGenerationPremium = (): number => {
  const older = priceById('ec2-m-large-hour-graviton3');
  const newer = priceById('ec2-m-large-hour-graviton4');
  if (!older || !newer) throw new Error('gravitonGenerationPremium: EC2 prices missing');
  return newer.graviton.usd / older.graviton.usd - 1;
};

/* ── Benchmarks ────────────────────────────────────────────────────────────── */

export interface BenchmarkClaim {
  readonly id: string;
  /** What the claim is about, in the claimant's own terms. */
  readonly workloadClass: string;
  /** The claim, as published. Not rounded, not reworded. */
  readonly claim: string;
  /** Who published it. */
  readonly publisher: string;
  /** Where it can be read. */
  readonly source: string;
  /**
   * Whether *this repository* has measured it. Every row is `false`, and the
   * audit rejects a `true` with no `artifact` beside it.
   */
  readonly measured: boolean;
  /** Path to the run that measured it, when one exists. */
  readonly artifact?: string;
  /** Why the number cannot be taken at face value for the workload in question. */
  readonly caveat: string;
}

/**
 * The performance half, and it is all somebody else's measurement.
 *
 * These are here to be *bounded* by {@link slowdownTolerance}, not to be
 * believed: every one of them is a vendor's number for a workload that is not
 * this repository's, and a price saving of 5.9% is erased by a 6.3% regression
 * that none of these claims rules out for a Redis node.
 */
export const BENCHMARK_CLAIMS: readonly BenchmarkClaim[] = [
  {
    id: 'graviton3-price-performance',
    workloadClass: 'General-purpose compute (C7g/M7g/R7g vs comparable x86)',
    claim: 'Up to 25% better compute performance than Graviton2, and up to 40% better price performance than comparable x86 instances.',
    publisher: 'AWS',
    source: 'https://aws.amazon.com/ec2/graviton/',
    measured: false,
    caveat:
      '"Up to" over a vendor-chosen benchmark set. The repository workload nearest ' +
      'to it is the EKS node group, which is blocked for a reason no benchmark ' +
      'addresses.',
  },
  {
    id: 'lambda-arm-price-performance',
    workloadClass: 'AWS Lambda functions on arm64',
    claim: 'Up to 34% better price performance than x86 for Lambda functions.',
    publisher: 'AWS',
    source: 'https://aws.amazon.com/lambda/pricing/',
    measured: false,
    caveat:
      'Price performance, not performance: 20 points of the 34 are the price cut ' +
      'this repository can verify from the price list. The rest is a throughput ' +
      'claim about workloads unlike the 18 event-driven handlers here, each of ' +
      'which runs for under a second and is dominated by SDK round-trips rather ' +
      'than by CPU.',
  },
  {
    id: 'rds-graviton2-throughput',
    workloadClass: 'Amazon RDS db.*6g/t4g instances',
    claim: 'Up to 35% higher throughput than comparable x86 instances for open-source engines.',
    publisher: 'AWS',
    source: 'https://aws.amazon.com/rds/postgresql/pricing/',
    measured: false,
    caveat:
      'Published for the m6g/r6g families on sustained workloads. The instance here ' +
      'is a burstable t4g whose throughput is governed by its CPU credit balance ' +
      'long before the processor matters.',
  },
];

/* ── Workloads ─────────────────────────────────────────────────────────────── */

export type Architecture = 'arm64' | 'x86_64';

export type ComputeKind =
  | 'lambda'
  | 'fargate-task-definition'
  | 'eks-nodegroup'
  | 'rds-instance'
  | 'elasticache-node'
  | 'synthetics-canary';

/** Who decides this workload's architecture. */
export type Owner =
  /** This repository, in a stack under `lib/`. */
  | 'repository'
  /** The CDK framework, in a construct nothing here instantiates directly. */
  | 'cdk'
  /** AWS, in a managed runtime. */
  | 'aws';

/** Where the bytes that have to be arm64 come from. */
export type ImageSource =
  /** No image: a zip function, a managed engine, or an EKS-supplied AMI. */
  | 'none'
  /** An image pinned in `lib/base-images.ts`, verified multi-arch. */
  | 'repository-pinned'
  /** An image the consumer builds with `workflow-templates/docker-build-push.yml`. */
  | 'consumer-supplied'
  /** An artifact AWS or the CDK framework builds, including Lambda layers. */
  | 'aws-managed';

export type Verdict =
  /** Deploys on arm64 today. */
  | 'migrated'
  /** Nothing about the workload prevents arm64; something else does. */
  | 'blocked'
  /** There is no arm64 to move to, or the choice is not this repository's. */
  | 'unavailable';

export type Blocker =
  /**
   * The image comes from `docker-build-push.yml`, which runs `docker build` with
   * no `--platform` and so produces one amd64 manifest. Declaring ARM64 on the
   * task definition would deploy cleanly and fail at task placement.
   */
  | 'consumer-image-single-platform'
  /** The function carries a Lambda layer whose binaries are ELF x86-64. */
  | 'layer-binaries-x86'
  /** AWS publishes no arm64 runtime for this service. */
  | 'no-arm64-runtime'
  /** The CDK framework creates the function and exposes no architecture property. */
  | 'framework-chooses';

/** What changing this workload's architecture does to it. */
export type Mechanics =
  /** A new version of a zip function: no downtime, no data. */
  | 'redeploy'
  /** A new task definition revision and a rolling service deployment. */
  | 'task-revision'
  /** An instance-class modification: one reboot, or a Multi-AZ failover. */
  | 'instance-modify-reboot'
  /** Node group replacement: new nodes join, pods are evicted onto them. */
  | 'node-replacement'
  /** Nothing to do, because nothing can be done. */
  | 'none';

export interface Workload {
  readonly id: string;
  readonly kind: ComputeKind;
  readonly owner: Owner;
  /**
   * Suffix of the resource's `aws:cdk:path`, which is how the audit finds this
   * workload in the synthesised templates. A suffix rather than the whole path
   * because the prefix is the stack, and most of these exist once per
   * environment.
   */
  readonly constructPathSuffix: string;
  /**
   * Stack-name prefixes this workload lives in, when the suffix alone is
   * ambiguous. `TaskDefinition/Resource` is the path of five different task
   * definitions in five stacks, two of which run an image this repository pins
   * and three of which run the consumer's — the same construct id, opposite
   * verdicts. Omitted where the suffix is unique.
   */
  readonly stackPrefixes?: readonly string[];
  /** The architecture the synthesised template must declare. */
  readonly architecture: Architecture;
  readonly verdict: Verdict;
  readonly blocker?: Blocker;
  readonly image: ImageSource;
  readonly mechanics: Mechanics;
  /** Price observations that govern it. Empty only where the choice is not ours. */
  readonly priceIds: readonly PriceId[];
  /**
   * How many resources in `cdk.out` must match {@link constructPathSuffix}.
   *
   * Exact, not a minimum: a stack that stops synthesising takes its resources
   * out of the audit's reach, and a gate that reads less than it did last week
   * reports success identically to one that read everything. Adding an
   * environment therefore means updating this number, which is the moment to
   * classify the new copy.
   */
  readonly expectedResources: number;
  /** One line a reviewer needs that the fields above do not carry. */
  readonly note?: string;
}

/** The 18 inline Node handlers this repository writes, all of them arm64. */
const REPOSITORY_LAMBDAS: readonly {
  readonly id: string;
  readonly path: string;
  readonly copies: number;
}[] = [
  { id: 'slo-budget-reporter', path: 'SloBudgetReporter/Resource', copies: 2 },
  { id: 'slo-burn-rate-rollback', path: 'RollbackFunction/Resource', copies: 2 },
  { id: 'rollback-automation', path: 'RollbackLambda/Resource', copies: 2 },
  { id: 'runbook-enricher', path: 'RunbookEnricher/Resource', copies: 2 },
  { id: 'log-scrubber', path: 'Scrubber/Resource', copies: 2 },
  { id: 'migration-hook', path: 'MigrationHookLambda/Resource', copies: 2 },
  { id: 'canary-analyzer', path: 'AnalyzerFunction/Resource', copies: 2 },
  { id: 'canary-controller', path: 'ControllerFunction/Resource', copies: 2 },
  { id: 'game-day-conductor', path: 'GameDayConductor/Resource', copies: 2 },
  { id: 'game-day-probe', path: 'GameDayProbe/Resource', copies: 2 },
  { id: 'game-day-recorder', path: 'GameDayRecorder/Resource', copies: 2 },
  { id: 'restore-drill-conductor', path: 'RestoreDrillConductor/Resource', copies: 2 },
  { id: 'restore-drill-sweeper', path: 'RestoreDrillSweeper/Resource', copies: 2 },
  { id: 'restore-drill-verifier', path: 'RestoreDrillVerifier/Resource', copies: 2 },
  { id: 'dora-aggregator', path: 'AggregatorFunction/Resource', copies: 1 },
  { id: 'dora-recorder', path: 'RecorderFunction/Resource', copies: 1 },
  { id: 'feature-flag-sweep', path: 'FeatureFlagSweepFunction/Resource', copies: 1 },
  { id: 'preview-reaper', path: 'PreviewReaperFunction/Resource', copies: 1 },
];

/**
 * The functions the CDK framework creates on this repository's behalf.
 *
 * This group is the finding. Twenty-six of the fifty-eight `AWS::Lambda::Function`
 * resources in `cdk.out` are here, nothing in `lib/` or `bin/` names any of
 * them, and `architecture` is not a property any of their constructs accepts —
 * so "migrate the Lambda fleet to arm64" tops out at 32 of 58 functions, and the
 * remainder is invisible to anyone reading the TypeScript. Six of them carry
 * layers whose binaries are ELF x86-64, measured by
 * `tools/audit-graviton.ts`'s `layer-binaries-x86` rule.
 */
const CDK_MANAGED_LAMBDAS: readonly {
  readonly id: string;
  readonly path: string;
  readonly copies: number;
  readonly blocker: Blocker;
  readonly note: string;
}[] = [
  {
    id: 'cdk-eks-kubectl-handler',
    path: '@aws-cdk--aws-eks.KubectlProvider/Handler/Resource',
    copies: 2,
    blocker: 'layer-binaries-x86',
    note: 'Carries the kubectl and awscli layers: both ship ELF x86-64 binaries.',
  },
  {
    id: 'cdk-eks-cluster-oneventhandler',
    path: '@aws-cdk--aws-eks.ClusterResourceProvider/OnEventHandler/Resource',
    copies: 2,
    blocker: 'layer-binaries-x86',
    note: 'Carries the awscli layer.',
  },
  {
    id: 'cdk-eks-cluster-iscompletehandler',
    path: '@aws-cdk--aws-eks.ClusterResourceProvider/IsCompleteHandler/Resource',
    copies: 2,
    blocker: 'layer-binaries-x86',
    note: 'Carries the awscli layer.',
  },
  {
    id: 'cdk-provider-framework-onevent',
    path: 'Provider/framework-onEvent/Resource',
    copies: 4,
    blocker: 'framework-chooses',
    note: 'Custom-resource framework handler; architecture is not a Provider property.',
  },
  {
    id: 'cdk-provider-framework-iscomplete',
    path: 'Provider/framework-isComplete/Resource',
    copies: 2,
    blocker: 'framework-chooses',
    note: 'Custom-resource framework handler.',
  },
  {
    id: 'cdk-provider-framework-ontimeout',
    path: 'Provider/framework-onTimeout/Resource',
    copies: 2,
    blocker: 'framework-chooses',
    note: 'Custom-resource framework handler.',
  },
  {
    id: 'cdk-cfn-utils-provider',
    path: 'AWSCDKCfnUtilsProviderCustomResourceProvider/Handler',
    copies: 2,
    blocker: 'framework-chooses',
    note: 'Singleton custom-resource provider created by aws-cdk-lib.',
  },
  {
    id: 'cdk-oidc-provider',
    path: 'Custom::AWSCDKOpenIdConnectProviderCustomResourceProvider/Handler',
    copies: 3,
    blocker: 'framework-chooses',
    note: 'Created by iam.OpenIdConnectProvider.',
  },
  {
    id: 'cdk-s3-auto-delete-objects',
    path: 'Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler',
    copies: 3,
    blocker: 'framework-chooses',
    note: 'Created by autoDeleteObjects on a bucket.',
  },
  {
    id: 'cdk-vpc-restrict-default-sg',
    path: 'Custom::VpcRestrictDefaultSGCustomResourceProvider/Handler',
    copies: 2,
    blocker: 'framework-chooses',
    note: 'Created by the @aws-cdk/aws-ec2:restrictDefaultSecurityGroup feature flag.',
  },
  {
    id: 'cdk-log-retention',
    path: 'LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a/Resource',
    copies: 2,
    blocker: 'framework-chooses',
    note:
      'Created by logRetention on a log group CDK manages for us. The hash in the ' +
      'path is the handler asset\u2019s, so an aws-cdk-lib upgrade can move it \u2014 which ' +
      'fails workload-count-drift rather than silently unclassifying two functions.',
  },
];

/**
 * Every compute resource this repository synthesises, classified.
 *
 * The audit requires this list to account for all of them: a resource no entry
 * matches fails `workload-unclassified`, which is what stops the inventory going
 * quietly blind the next time a stack is added.
 */
export const COMPUTE_WORKLOADS: readonly Workload[] = [
  ...REPOSITORY_LAMBDAS.map(
    (fn): Workload => ({
      id: fn.id,
      kind: 'lambda',
      owner: 'repository',
      constructPathSuffix: fn.path,
      architecture: 'arm64',
      verdict: 'migrated',
      image: 'none',
      mechanics: 'redeploy',
      priceIds: ['lambda-gb-second'],
      expectedResources: fn.copies,
    }),
  ),
  ...CDK_MANAGED_LAMBDAS.map(
    (fn): Workload => ({
      id: fn.id,
      kind: 'lambda',
      owner: 'cdk',
      constructPathSuffix: fn.path,
      architecture: 'x86_64',
      verdict: 'unavailable',
      blocker: fn.blocker,
      image: 'aws-managed',
      mechanics: 'none',
      priceIds: [],
      expectedResources: fn.copies,
      note: fn.note,
    }),
  ),
  {
    id: 'otel-sampler-task',
    kind: 'fargate-task-definition',
    owner: 'repository',
    constructPathSuffix: 'TaskDefinition/Resource',
    stackPrefixes: ['OtelCollectorStack'],
    architecture: 'arm64',
    verdict: 'migrated',
    image: 'repository-pinned',
    mechanics: 'task-revision',
    priceIds: ['fargate-vcpu-hour', 'fargate-gb-hour'],
    expectedResources: 2,
    note:
      'Runs ADOT_COLLECTOR_IMAGE and nothing else, which is an index digest with a ' +
      'linux/arm64 manifest in it.',
  },
  {
    id: 'preview-db-admin-task',
    kind: 'fargate-task-definition',
    owner: 'repository',
    constructPathSuffix: 'PreviewDbAdminTask/Resource',
    stackPrefixes: ['PreviewEnvironmentStack'],
    architecture: 'arm64',
    verdict: 'migrated',
    image: 'repository-pinned',
    mechanics: 'task-revision',
    priceIds: ['fargate-vcpu-hour', 'fargate-gb-hour'],
    expectedResources: 1,
    note: 'Runs POSTGRES_CLIENT_IMAGE, a 16-platform index.',
  },
  {
    id: 'app-service-task',
    kind: 'fargate-task-definition',
    owner: 'repository',
    constructPathSuffix: 'TaskDefinition/Resource',
    stackPrefixes: ['EcsStack', 'BlueGreenDeployStack', 'CanaryDeployStack', 'PreviewPrStack'],
    architecture: 'x86_64',
    verdict: 'blocked',
    blocker: 'consumer-image-single-platform',
    image: 'consumer-supplied',
    mechanics: 'task-revision',
    priceIds: ['fargate-vcpu-hour', 'fargate-gb-hour'],
    expectedResources: 7,
    note:
      'EcsStack, BlueGreenDeployStack, CanaryDeployStack and PreviewPrStack: four ' +
      'stacks, seven task definitions, all running the image the consumer builds.',
  },
  {
    id: 'db-migration-task',
    kind: 'fargate-task-definition',
    owner: 'repository',
    constructPathSuffix: 'MigrationTaskDef/Resource',
    stackPrefixes: ['DbMigrationStack'],
    architecture: 'x86_64',
    verdict: 'blocked',
    blocker: 'consumer-image-single-platform',
    image: 'consumer-supplied',
    mechanics: 'task-revision',
    priceIds: ['fargate-vcpu-hour', 'fargate-gb-hour'],
    expectedResources: 2,
    note: 'Runs migrationImageUri, which is the application image with a different command.',
  },
  {
    id: 'eks-system-nodegroup',
    kind: 'eks-nodegroup',
    owner: 'repository',
    constructPathSuffix: 'Cluster/NodegroupSystemNodeGroup/Resource',
    architecture: 'x86_64',
    verdict: 'blocked',
    blocker: 'consumer-image-single-platform',
    image: 'consumer-supplied',
    mechanics: 'node-replacement',
    priceIds: ['ec2-m-large-hour-graviton3', 'ec2-m-large-hour-graviton4'],
    expectedResources: 2,
    note:
      'The only node group in either cluster, so the application pods land on it. ' +
      'Its add-ons are all multi-arch upstream; k8s/charts/app is not.',
  },
  {
    id: 'rds-postgres-instance',
    kind: 'rds-instance',
    owner: 'repository',
    constructPathSuffix: 'RdsInstance/Resource',
    architecture: 'arm64',
    verdict: 'migrated',
    image: 'none',
    mechanics: 'instance-modify-reboot',
    priceIds: ['rds-postgres-t-medium-single-az', 'rds-postgres-t-medium-multi-az'],
    expectedResources: 2,
    note: 'Staging is Single-AZ and production Multi-AZ, which are different savings.',
  },
  {
    id: 'preview-rds-instance',
    kind: 'rds-instance',
    owner: 'repository',
    constructPathSuffix: 'PreviewDb/Resource',
    architecture: 'arm64',
    verdict: 'migrated',
    image: 'none',
    mechanics: 'instance-modify-reboot',
    priceIds: ['rds-postgres-t-medium-single-az'],
    expectedResources: 1,
    note:
      'Already db.t4g.micro before this catalogue existed, and nothing recorded it — ' +
      'the preview database was the only Graviton workload in the repository.',
  },
  {
    id: 'elasticache-redis-nodes',
    kind: 'elasticache-node',
    owner: 'repository',
    constructPathSuffix: 'RedisReplicationGroup',
    architecture: 'arm64',
    verdict: 'migrated',
    image: 'none',
    mechanics: 'instance-modify-reboot',
    priceIds: ['elasticache-redis-t-small-hour'],
    expectedResources: 2,
  },
  {
    id: 'synthetic-canaries',
    kind: 'synthetics-canary',
    owner: 'aws',
    constructPathSuffix: '/Resource',
    stackPrefixes: ['SyntheticCanaryStack'],
    architecture: 'x86_64',
    verdict: 'unavailable',
    blocker: 'no-arm64-runtime',
    image: 'aws-managed',
    mechanics: 'none',
    priceIds: [],
    expectedResources: 10,
    note:
      'CloudWatch Synthetics publishes one runtime family per language and no arm64 ' +
      'variant of any of them; the canary is billed per run rather than per hour.',
  },
];

/* ── Pinned image platforms ────────────────────────────────────────────────── */

/**
 * What is actually inside each image `lib/base-images.ts` pins, measured against
 * the registry rather than assumed.
 *
 * This is the half of a Graviton migration that no amount of `cpuArchitecture:
 * ARM64` can fix: a task definition asking for ARM64 whose image reference
 * resolves to a `linux/amd64` manifest synthesises, deploys, passes every gate
 * in this repository, and then fails at *task placement* with
 * `CannotPullContainerError` — in the environment it was deployed to, minutes
 * later, with nothing in CloudFormation saying why.
 *
 * `base-images.ts` already said as much about one of the four pins, in a comment
 * on `ADOT_COLLECTOR_IMAGE` explaining that it was resolved by index digest
 * "rather than per-platform". The other three said nothing either way, so
 * whether an ARM64 task definition could pull them was unknown — and the answer
 * had to be measured before anything here could be moved. All four turned out to
 * be multi-platform indexes carrying `linux/arm64`.
 *
 * `unknown/unknown` entries are deliberately absent from `platforms`: a
 * buildkit-built index carries attestation manifests under that platform, so an
 * index with two real platforms reports four entries, and a check that counts
 * `manifests` rather than reading their `platform` is satisfied by an index that
 * holds one architecture and two signatures of it.
 *
 * Re-measuring one of these needs no tooling beyond curl — docs/graviton.md §5
 * has the three commands.
 */
export interface ImagePlatformRecord {
  /**
   * The pin itself, imported from `lib/base-images.ts` rather than repeated.
   *
   * It has to be the constant: `tools/audit-dependency-pins.ts` refuses a
   * registry reference written anywhere but that module, and it is right to —
   * a digest duplicated here is a digest that gets updated in one of the two
   * places. {@link ImagePlatformRecord.digestPrefix} is what keeps the
   * measurement honest across that indirection.
   */
  readonly image: PinnedImage;
  /**
   * The first twelve hex characters of the digest that was *measured*.
   *
   * Without this the record would silently follow the pin: bump
   * `ADOT_COLLECTOR_IMAGE` to a new release and the platform measurement for the
   * old digest would quietly become a claim about the new one — which is the
   * same class of defect as a `version` bumped without its digest, the thing
   * `base-images.ts` warns about in its own header. A mismatch here fails
   * `image-digest-drift`, which says: re-measure before moving on.
   */
  readonly digestPrefix: string;
  /** The media type the registry returned for that digest. */
  readonly mediaType: string;
  /** Real platforms in the index, `os/arch`, without the attestation entries. */
  readonly platforms: readonly string[];
  /** When this was read from the registry. */
  readonly measuredOn: string;
  /** How, so the next person can repeat it. */
  readonly method: string;
}

const REGISTRY_PROBE =
  'GET /v2/<repo>/manifests/<digest> on public.ecr.aws with an Accept header listing the ' +
  'OCI index and Docker manifest-list media types, under a token from /token/?scope=repository:<repo>:pull';

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const DOCKER_MANIFEST_LIST = 'application/vnd.docker.distribution.manifest.list.v2+json';

export const IMAGE_PLATFORMS: readonly ImagePlatformRecord[] = [
  {
    image: NGINX_PLACEHOLDER_IMAGE,
    digestPrefix: '8d32e1ab9a19',
    mediaType: DOCKER_MANIFEST_LIST,
    platforms: ['linux/amd64', 'linux/arm64'],
    measuredOn: '2026-10-13',
    method: REGISTRY_PROBE,
  },
  {
    image: XRAY_DAEMON_IMAGE,
    digestPrefix: 'b67576293f4d',
    mediaType: OCI_INDEX,
    platforms: ['linux/amd64', 'linux/arm64'],
    measuredOn: '2026-10-13',
    method: REGISTRY_PROBE,
  },
  {
    image: POSTGRES_CLIENT_IMAGE,
    digestPrefix: 'cf78e76683b9',
    mediaType: OCI_INDEX,
    platforms: [
      'linux/386',
      'linux/amd64',
      'linux/arm',
      'linux/arm64',
      'linux/ppc64le',
      'linux/riscv64',
      'linux/s390x',
    ],
    measuredOn: '2026-10-13',
    method: REGISTRY_PROBE,
  },
  {
    image: ADOT_COLLECTOR_IMAGE,
    digestPrefix: '7968fb60db6a',
    mediaType: OCI_INDEX,
    platforms: ['linux/amd64', 'linux/arm64'],
    measuredOn: '2026-10-13',
    method: REGISTRY_PROBE,
  },
];

/** The platform record for an image reference, if this repository has measured it. */
export const imagePlatformRecord = (reference: string): ImagePlatformRecord | undefined =>
  IMAGE_PLATFORMS.find((record) => record.image.reference === reference);

/** Whether a measured image can be pulled by a task running on Graviton. */
export const supportsArm64 = (record: ImagePlatformRecord): boolean =>
  record.platforms.includes('linux/arm64');

/* ── Validation ────────────────────────────────────────────────────────────── */

export interface CatalogueFinding {
  readonly rule: string;
  readonly subject: string;
  readonly message: string;
}

const MECHANICS_BY_KIND: Record<ComputeKind, readonly Mechanics[]> = {
  lambda: ['redeploy', 'none'],
  'fargate-task-definition': ['task-revision', 'none'],
  'eks-nodegroup': ['node-replacement', 'none'],
  'rds-instance': ['instance-modify-reboot', 'none'],
  'elasticache-node': ['instance-modify-reboot', 'none'],
  'synthetics-canary': ['none'],
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Everything that is arithmetic or internal consistency over the data above.
 *
 * The rules that need the synthesised templates, the build pipeline or the guide
 * live in `tools/audit-graviton.ts`; these are the ones a unit test can decide.
 */
export const validateGravitonCatalogue = (
  workloads: readonly Workload[] = COMPUTE_WORKLOADS,
  prices: readonly PriceObservation[] = ARCHITECTURE_PRICES,
  claims: readonly BenchmarkClaim[] = BENCHMARK_CLAIMS,
  images: readonly ImagePlatformRecord[] = IMAGE_PLATFORMS,
): readonly CatalogueFinding[] => {
  const findings: CatalogueFinding[] = [];
  const add = (rule: string, subject: string, message: string) =>
    findings.push({ rule, subject, message });

  const priceIds = new Set(prices.map((price) => price.id));

  for (const price of prices) {
    if (prices.filter((other) => other.id === price.id).length > 1) {
      add('price-duplicate-id', price.id, 'Two price observations share this id.');
    }
    if (!ISO_INSTANT.test(price.offerPublicationDate)) {
      add(
        'price-publication-date',
        price.id,
        `offerPublicationDate is ${JSON.stringify(price.offerPublicationDate)}, which is not the ` +
          'ISO instant the price list publishes. Without it there is no way to tell how old the ' +
          'number is.',
      );
    }
    for (const [side, value] of [
      ['x86', price.x86],
      ['graviton', price.graviton],
    ] as const) {
      if (value.sku.trim() === '') {
        add(
          'price-sku-missing',
          `${price.id}.${side}`,
          'No price list SKU, so the number cannot be re-derived from the offer file.',
        );
      }
      if (!(value.usd > 0)) {
        add('price-not-positive', `${price.id}.${side}`, `Price is ${value.usd}.`);
      }
    }
    if (price.x86.sku === price.graviton.sku) {
      add(
        'price-same-sku',
        price.id,
        'Both sides name the same SKU, so this row compares a price with itself.',
      );
    }
    if (price.graviton.usd >= price.x86.usd) {
      add(
        'price-no-saving',
        price.id,
        `The Graviton side costs ${price.graviton.usd} against ${price.x86.usd}, so this row is ` +
          'not a saving and must not be presented as one.',
      );
    }
  }

  for (const workload of workloads) {
    if (workloads.filter((other) => other.id === workload.id).length > 1) {
      add('workload-duplicate-id', workload.id, 'Two workloads share this id.');
    }

    const needsBlocker = workload.verdict !== 'migrated';
    if (needsBlocker && workload.blocker === undefined) {
      add(
        'workload-blocker-missing',
        workload.id,
        `Verdict is ${workload.verdict} with no blocker named. "Not yet" with no reason beside it ` +
          'is how a workload stays on x86 for a year.',
      );
    }
    if (!needsBlocker && workload.blocker !== undefined) {
      add(
        'workload-blocker-stale',
        workload.id,
        `Verdict is migrated and a blocker (${workload.blocker}) is still recorded.`,
      );
    }

    const expected: Architecture = workload.verdict === 'migrated' ? 'arm64' : 'x86_64';
    if (workload.architecture !== expected) {
      add(
        'workload-architecture-disagrees',
        workload.id,
        `Verdict ${workload.verdict} with architecture ${workload.architecture}.`,
      );
    }

    if (workload.image === 'consumer-supplied' && workload.verdict === 'migrated') {
      add(
        'workload-consumer-image-migrated',
        workload.id,
        'Declared arm64 while running an image the consumer builds. The architecture of that ' +
          'image is not this repository’s to assert; see the pipeline rules in ' +
          'tools/audit-graviton.ts.',
      );
    }

    if (!MECHANICS_BY_KIND[workload.kind].includes(workload.mechanics)) {
      add(
        'workload-mechanics-wrong',
        workload.id,
        `A ${workload.kind} cannot migrate by ${workload.mechanics}.`,
      );
    }

    if (workload.expectedResources < 1) {
      add(
        'workload-expected-resources',
        workload.id,
        'expectedResources is below one, so no synthesised resource could satisfy it.',
      );
    }

    for (const id of workload.priceIds) {
      if (!priceIds.has(id)) {
        add('workload-price-unknown', workload.id, `References price ${id}, which does not exist.`);
      }
    }

    const quantified = workload.verdict === 'migrated' || workload.verdict === 'blocked';
    if (quantified && workload.priceIds.length === 0) {
      add(
        'workload-price-missing',
        workload.id,
        `A ${workload.verdict} workload with no price beside it is a migration whose value nobody ` +
          'can state.',
      );
    }
  }

  for (const claim of claims) {
    if (claims.filter((other) => other.id === claim.id).length > 1) {
      add('benchmark-duplicate-id', claim.id, 'Two benchmark claims share this id.');
    }
    if (!claim.measured && !/^https?:\/\//.test(claim.source)) {
      add(
        'benchmark-source-missing',
        claim.id,
        'An unmeasured claim with no source is a number this repository is asserting on its own.',
      );
    }
    if (claim.measured && !claim.artifact) {
      add(
        'benchmark-measured-without-artifact',
        claim.id,
        'Marked measured with no artifact. Nothing here has run on arm64; see docs/graviton.md §6.',
      );
    }
    if (claim.caveat.trim() === '') {
      add(
        'benchmark-caveat-missing',
        claim.id,
        'No caveat recorded, so the claim reads as though it were about this repository.',
      );
    }
  }

  for (const record of images) {
    if (!/^[0-9a-f]{12,}$/.test(record.digestPrefix)) {
      add(
        'image-digest-prefix',
        record.image.version,
        `digestPrefix is ${JSON.stringify(record.digestPrefix)}; it has to be at least twelve hex ` +
          'characters of the digest that was measured, or it cannot detect a pin being bumped.',
      );
    } else if (!record.image.reference.includes(record.digestPrefix)) {
      add(
        'image-digest-drift',
        record.image.version,
        `The pin in base-images.ts no longer carries digest ${record.digestPrefix}, so this ` +
          'measurement is about an image that is no longer deployed. Re-measure the new digest ' +
          'before trusting it on arm64 \u2014 docs/graviton.md §5.',
      );
    }
    if (record.platforms.length === 0) {
      add(
        'image-platforms-empty',
        record.image.version,
        'No platforms recorded. An index nobody could read is not an index with no architectures.',
      );
    }
    if (record.platforms.includes('unknown/unknown')) {
      add(
        'image-platforms-attestation',
        record.image.version,
        'unknown/unknown is a buildkit attestation manifest rather than a platform; counting it ' +
          'makes a single-architecture index look multi-platform.',
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record.measuredOn)) {
      add('image-measured-on', record.image.version, `measuredOn is ${JSON.stringify(record.measuredOn)}.`);
    }
  }

  return findings;
};

/* ── Instance families ─────────────────────────────────────────────────────── */

/**
 * The architecture an instance class name implies.
 *
 * AWS encodes the processor in the letters that follow the generation digit: a
 * `g` there means Graviton (`t4g`, `m7g`, `r6gd`, `im4gn`), and its absence
 * means x86 whatever the prefix is (`m6i`, `m6a`, `g5`, `m7i-flex`). Reading the
 * letters *after* the digit is what keeps the GPU families, whose names start
 * with `g`, on the right side of the line.
 */
export const instanceClassArchitecture = (instanceClass: string): Architecture => {
  const family = instanceClass.replace(/^(db|cache)\./, '').split('.')[0] ?? '';
  const suffix = /\d+(.*)$/.exec(family)?.[1] ?? '';
  return suffix.includes('g') ? 'arm64' : 'x86_64';
};

/* ── Rendering ─────────────────────────────────────────────────────────────── */

const percent = (fraction: number, places = 1): string => `${(fraction * 100).toFixed(places)}%`;

const usd = (value: number): string =>
  value < 0.001 ? `$${value.toFixed(10).replace(/0+$/, '')}` : `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;

/**
 * The cost comparison, rendered from {@link ARCHITECTURE_PRICES}.
 *
 * `docs/graviton.md` has to contain this text exactly. Rendering it rather than
 * checking it is deliberate: a table that is only *validated* drifts into a
 * table nobody regenerates, and the first thing to go stale is the column
 * everyone quotes.
 */
export const renderPriceTable = (
  prices: readonly PriceObservation[] = ARCHITECTURE_PRICES,
): string => {
  const header = [
    '| Service | Unit | x86 | Graviton | Saving | Tolerated slowdown | Offer published |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = prices.map((price) => {
    const cells = [
      price.service,
      price.unit,
      `${price.x86.descriptor} \`${usd(price.x86.usd)}\``,
      `${price.graviton.descriptor} \`${usd(price.graviton.usd)}\``,
      percent(savingFraction(price), 2),
      percent(slowdownTolerance(price), 2),
      price.offerPublicationDate.slice(0, 10),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [...header, ...rows].join('\n');
};

/** The workload inventory, rendered from {@link COMPUTE_WORKLOADS}. */
export const renderWorkloadTable = (
  workloads: readonly Workload[] = COMPUTE_WORKLOADS,
): string => {
  const header = [
    '| Workload | Kind | Copies | Decided by | Image | Verdict | Blocker | Migrates by |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const rows = workloads.map((workload) => {
    const cells = [
      `\`${workload.id}\``,
      workload.kind,
      String(workload.expectedResources),
      workload.owner,
      workload.image,
      workload.verdict,
      workload.blocker ?? '—',
      workload.mechanics,
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return [...header, ...rows].join('\n');
};

/** Resource counts by verdict, for the guide's opening paragraph and the audit's summary. */
export const verdictTotals = (
  workloads: readonly Workload[] = COMPUTE_WORKLOADS,
): Record<Verdict, number> => {
  const totals: Record<Verdict, number> = { migrated: 0, blocked: 0, unavailable: 0 };
  for (const workload of workloads) totals[workload.verdict] += workload.expectedResources;
  return totals;
};
