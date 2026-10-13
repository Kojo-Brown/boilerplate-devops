import { PINNED_IMAGES } from '../lib/base-images';
import {
  ARCHITECTURE_PRICES,
  type ImagePlatformRecord,
  BENCHMARK_CLAIMS,
  COMPUTE_WORKLOADS,
  IMAGE_PLATFORMS,
  type BenchmarkClaim,
  type PriceObservation,
  type Workload,
  blendedFargateSaving,
  gravitonGenerationPremium,
  imagePlatformRecord,
  instanceClassArchitecture,
  priceById,
  renderPriceTable,
  renderWorkloadTable,
  savingFraction,
  slowdownTolerance,
  supportsArm64,
  validateGravitonCatalogue,
  verdictTotals,
} from '../lib/graviton-migration';

/**
 * Tests for the Graviton catalogue.
 *
 * Three groups. The arithmetic, because a saving and a tolerance are derived
 * numbers and a document quotes them. The classification, because the whole
 * value of the catalogue is that a workload cannot be left unclassified or
 * classified two ways at once. And the perturbation set at the bottom: each one
 * moves exactly one field of an otherwise correct catalogue and requires
 * `validateGravitonCatalogue` to notice, because a validator that passes
 * everything reads identically to data that is correct.
 */

const price = (id: string): PriceObservation => {
  const found = priceById(id);
  if (!found) throw new Error(`no price ${id}`);
  return found;
};

const workload = (id: string): Workload => {
  const found = COMPUTE_WORKLOADS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no workload ${id}`);
  return found;
};

/** A correct single-workload catalogue, for the perturbation tests to break. */
const SOUND_WORKLOAD: Workload = {
  id: 'example',
  kind: 'lambda',
  owner: 'repository',
  constructPathSuffix: 'Example/Resource',
  architecture: 'arm64',
  verdict: 'migrated',
  image: 'none',
  mechanics: 'redeploy',
  priceIds: ['lambda-gb-second'],
  expectedResources: 1,
};

const SOUND_PRICE: PriceObservation = {
  id: 'lambda-gb-second',
  service: 'Example',
  unit: 'GB-second',
  x86: { descriptor: 'x', sku: 'AAAA', usd: 1 },
  graviton: { descriptor: 'y', sku: 'BBBB', usd: 0.8, processor: 'AWS Graviton2' },
  offerCode: 'Example',
  offerPublicationDate: '2026-10-12T00:00:00Z',
};

const SOUND_CLAIM: BenchmarkClaim = {
  id: 'example-claim',
  workloadClass: 'Example',
  claim: 'Faster.',
  publisher: 'Someone',
  source: 'https://example.invalid/benchmark',
  measured: false,
  caveat: 'Not this workload.',
};

const SOUND_IMAGE: ImagePlatformRecord = {
  ...IMAGE_PLATFORMS[0],
};

const rulesFor = (
  workloads: readonly Workload[] = [SOUND_WORKLOAD],
  prices: readonly PriceObservation[] = [SOUND_PRICE],
  claims: readonly BenchmarkClaim[] = [SOUND_CLAIM],
  images: readonly ImagePlatformRecord[] = [SOUND_IMAGE],
): string[] =>
  validateGravitonCatalogue(workloads, prices, claims, images).map((finding) => finding.rule);

describe('the shipped catalogue', () => {
  it('has no findings', () => {
    expect(validateGravitonCatalogue()).toEqual([]);
  });

  it('classifies every pinned image, because an unmeasured pin is an unknown', () => {
    for (const pin of PINNED_IMAGES) {
      expect(imagePlatformRecord(pin.reference)).toBeDefined();
    }
    expect(IMAGE_PLATFORMS).toHaveLength(PINNED_IMAGES.length);
  });

  it('records every pinned image as multi-platform with linux/arm64', () => {
    // The measurement that let anything move at all: had one of these been a
    // single-platform manifest, the task definitions in OtelCollectorStack and
    // PreviewEnvironmentStack could not have been migrated.
    for (const record of IMAGE_PLATFORMS) {
      expect(supportsArm64(record)).toBe(true);
      expect(record.platforms).toContain('linux/amd64');
      expect(record.platforms).not.toContain('unknown/unknown');
    }
  });

  it('accounts for all 87 compute resources, split 40 / 11 / 36', () => {
    const totals = verdictTotals();
    expect(totals).toEqual({ migrated: 40, blocked: 11, unavailable: 36 });
    expect(totals.migrated + totals.blocked + totals.unavailable).toBe(
      COMPUTE_WORKLOADS.reduce((sum, entry) => sum + entry.expectedResources, 0),
    );
  });

  it('puts more Lambda functions beyond reach than this repository writes by hand', () => {
    // 32 ours, 26 the framework's. The point of the number: "we moved our
    // Lambdas to Graviton" is 55% true here, and nothing but this table says so.
    const lambdas = COMPUTE_WORKLOADS.filter((entry) => entry.kind === 'lambda');
    const count = (owner: Workload['owner']) =>
      lambdas
        .filter((entry) => entry.owner === owner)
        .reduce((sum, entry) => sum + entry.expectedResources, 0);
    expect(count('repository')).toBe(32);
    expect(count('cdk')).toBe(26);
  });

  it('blocks every consumer-image workload and migrates none of them', () => {
    const consumer = COMPUTE_WORKLOADS.filter((entry) => entry.image === 'consumer-supplied');
    expect(consumer.length).toBeGreaterThan(0);
    for (const entry of consumer) {
      expect(entry.verdict).toBe('blocked');
      expect(entry.blocker).toBe('consumer-image-single-platform');
      expect(entry.architecture).toBe('x86_64');
    }
  });

  it('gives every workload a unique id and every price a unique sku pair', () => {
    const ids = COMPUTE_WORKLOADS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const skus = ARCHITECTURE_PRICES.flatMap((entry) => [entry.x86.sku, entry.graviton.sku]);
    expect(skus.every((sku) => /^[A-Z0-9]{16}$/.test(sku))).toBe(true);
  });
});

describe('savings and tolerances', () => {
  it('derives the Lambda saving as exactly the published 20%', () => {
    expect(savingFraction(price('lambda-gb-second'))).toBeCloseTo(0.2, 5);
  });

  it('derives the ElastiCache saving as 5.88%, not 20%', () => {
    // The row that makes the guide's argument: the service this repository runs
    // saves a third of what the headline number promises.
    expect(savingFraction(price('elasticache-redis-t-small-hour'))).toBeCloseTo(0.058824, 6);
  });

  it('gives the same two RDS classes two different savings by deployment option', () => {
    const single = savingFraction(price('rds-postgres-t-medium-single-az'));
    const multi = savingFraction(price('rds-postgres-t-medium-multi-az'));
    expect(single).toBeCloseTo(0.097222, 6);
    expect(multi).toBeCloseTo(0.110345, 6);
    expect(multi).toBeGreaterThan(single);
  });

  it('prices the newest Graviton generation above the one before it', () => {
    expect(gravitonGenerationPremium()).toBeCloseTo(0.1, 6);
    // Still cheaper than x86, which is why both rows are published rather than
    // just the cheapest one.
    expect(savingFraction(price('ec2-m-large-hour-graviton4'))).toBeGreaterThan(0);
    expect(savingFraction(price('ec2-m-large-hour-graviton4'))).toBeLessThan(
      savingFraction(price('ec2-m-large-hour-graviton3')),
    );
  });

  it('ties the tolerated slowdown to the saving as s / (1 - s)', () => {
    for (const observation of ARCHITECTURE_PRICES) {
      const saving = savingFraction(observation);
      expect(slowdownTolerance(observation)).toBeCloseTo(saving / (1 - saving), 9);
    }
  });

  it('tolerates only 6.25% on the cheapest saving and 25% on the largest', () => {
    expect(slowdownTolerance(price('elasticache-redis-t-small-hour'))).toBeCloseTo(0.0625, 6);
    expect(slowdownTolerance(price('lambda-gb-second'))).toBeCloseTo(0.25, 5);
  });

  it('keeps every Fargate blend between the two meters it is made of', () => {
    const vcpu = savingFraction(price('fargate-vcpu-hour'));
    const memory = savingFraction(price('fargate-gb-hour'));
    expect(memory).toBeLessThan(vcpu);
    // Every shape Fargate permits, from the smallest task to a memory-heavy one.
    for (const [cpu, mib] of [
      [256, 512],
      [256, 2048],
      [512, 1024],
      [512, 4096],
      [1024, 2048],
      [4096, 30720],
    ]) {
      const blend = blendedFargateSaving(cpu, mib);
      expect(blend).toBeLessThanOrEqual(vcpu);
      expect(blend).toBeGreaterThanOrEqual(memory);
    }
  });

  it('moves the blend towards the memory meter as the task gets memory-heavy', () => {
    expect(blendedFargateSaving(1024, 2048)).toBeGreaterThan(blendedFargateSaving(256, 2048));
  });
});

describe('instanceClassArchitecture', () => {
  it('reads the letters after the generation digit, not the prefix', () => {
    const cases: [string, string][] = [
      ['db.t4g.medium', 'arm64'],
      ['db.t3.medium', 'x86_64'],
      ['cache.t4g.small', 'arm64'],
      ['cache.t3.micro', 'x86_64'],
      ['m7g.large', 'arm64'],
      ['m6i.large', 'x86_64'],
      ['m6a.large', 'x86_64'],
      ['r6gd.xlarge', 'arm64'],
      ['im4gn.large', 'arm64'],
      ['c7gn.xlarge', 'arm64'],
      // The GPU families begin with the letter the rule looks for, and are x86.
      ['g5.xlarge', 'x86_64'],
      ['g4dn.xlarge', 'x86_64'],
      // A suffixed x86 family, where a substring match on "g" would be wrong.
      ['m7i-flex.large', 'x86_64'],
      ['m6id.large', 'x86_64'],
    ];
    for (const [instanceClass, expected] of cases) {
      expect([instanceClass, instanceClassArchitecture(instanceClass)]).toEqual([
        instanceClass,
        expected,
      ]);
    }
  });
});

describe('rendering', () => {
  it('renders one price row per observation, with the SKU descriptors', () => {
    const table = renderPriceTable();
    const rows = table.trim().split('\n');
    expect(rows).toHaveLength(ARCHITECTURE_PRICES.length + 2);
    expect(table).toContain('db.t4g.medium');
    expect(table).toContain('| 5.88% | 6.25% |');
  });

  it('renders one workload row per entry, with the blocker spelled out', () => {
    const table = renderWorkloadTable();
    expect(table.trim().split('\n')).toHaveLength(COMPUTE_WORKLOADS.length + 2);
    expect(table).toContain('consumer-image-single-platform');
    expect(table).toContain('no-arm64-runtime');
    // A migrated workload's blocker column is a dash rather than empty, so a
    // missing value cannot be mistaken for a rendering bug.
    expect(table).toContain('| migrated | — |');
  });

  it('renders the copies column from expectedResources', () => {
    expect(renderWorkloadTable()).toContain(
      `| \`synthetic-canaries\` | synthetics-canary | ${workload('synthetic-canaries').expectedResources} |`,
    );
  });
});

describe('validateGravitonCatalogue', () => {
  it('passes sound data', () => {
    expect(rulesFor()).toEqual([]);
  });

  it('rejects a verdict that is not migrated with no blocker beside it', () => {
    expect(
      rulesFor([{ ...SOUND_WORKLOAD, verdict: 'blocked', architecture: 'x86_64' }]),
    ).toContain('workload-blocker-missing');
  });

  it('rejects a blocker left behind on a migrated workload', () => {
    expect(rulesFor([{ ...SOUND_WORKLOAD, blocker: 'framework-chooses' }])).toContain(
      'workload-blocker-stale',
    );
  });

  it('rejects an architecture that disagrees with the verdict', () => {
    expect(rulesFor([{ ...SOUND_WORKLOAD, architecture: 'x86_64' }])).toContain(
      'workload-architecture-disagrees',
    );
  });

  it('rejects a consumer-image workload claiming arm64', () => {
    // The one the pipeline rule exists for, restated as data: this repository
    // cannot assert the architecture of an image it does not build.
    expect(rulesFor([{ ...SOUND_WORKLOAD, image: 'consumer-supplied' }])).toContain(
      'workload-consumer-image-migrated',
    );
  });

  it('rejects mechanics that do not belong to the kind', () => {
    expect(rulesFor([{ ...SOUND_WORKLOAD, mechanics: 'instance-modify-reboot' }])).toContain(
      'workload-mechanics-wrong',
    );
  });

  it('rejects an expectedResources no resource could satisfy', () => {
    expect(rulesFor([{ ...SOUND_WORKLOAD, expectedResources: 0 }])).toContain(
      'workload-expected-resources',
    );
  });

  it('rejects a reference to a price that does not exist', () => {
    expect(
      rulesFor([{ ...SOUND_WORKLOAD, priceIds: ['fargate-gb-hour'] }], [SOUND_PRICE]),
    ).toContain('workload-price-unknown');
  });

  it('rejects a quantifiable workload with no price at all', () => {
    expect(rulesFor([{ ...SOUND_WORKLOAD, priceIds: [] }])).toContain('workload-price-missing');
  });

  it('allows a workload nobody can price when nobody can move it either', () => {
    expect(
      rulesFor([
        {
          ...SOUND_WORKLOAD,
          verdict: 'unavailable',
          architecture: 'x86_64',
          blocker: 'framework-chooses',
          mechanics: 'none',
          priceIds: [],
        },
      ]),
    ).toEqual([]);
  });

  it('rejects duplicate workload ids', () => {
    expect(rulesFor([SOUND_WORKLOAD, SOUND_WORKLOAD])).toContain('workload-duplicate-id');
  });

  it('rejects a price pair that is not a saving', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [
        { ...SOUND_PRICE, graviton: { ...SOUND_PRICE.graviton, usd: 1.2 } },
      ]),
    ).toContain('price-no-saving');
  });

  it('rejects a price pair that compares a SKU with itself', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [
        { ...SOUND_PRICE, graviton: { ...SOUND_PRICE.graviton, sku: SOUND_PRICE.x86.sku } },
      ]),
    ).toContain('price-same-sku');
  });

  it('rejects a price with no SKU, which is a number somebody remembered', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [{ ...SOUND_PRICE, x86: { ...SOUND_PRICE.x86, sku: '  ' } }]),
    ).toContain('price-sku-missing');
  });

  it('rejects a publication date that is not the instant the price list publishes', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [{ ...SOUND_PRICE, offerPublicationDate: '2026-10-12' }]),
    ).toContain('price-publication-date');
  });

  it('rejects a benchmark claiming to be measured with no artifact', () => {
    expect(rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [{ ...SOUND_CLAIM, measured: true }])).toContain(
      'benchmark-measured-without-artifact',
    );
  });

  it('accepts a measured benchmark that names its run', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [
        { ...SOUND_CLAIM, measured: true, artifact: 'benchmarks/2026-10-13-pgbench.json' },
      ]),
    ).toEqual([]);
  });

  it('rejects an unsourced claim and an uncaveated one', () => {
    expect(rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [{ ...SOUND_CLAIM, source: 'AWS' }])).toContain(
      'benchmark-source-missing',
    );
    expect(rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [{ ...SOUND_CLAIM, caveat: '' }])).toContain(
      'benchmark-caveat-missing',
    );
  });

  it('rejects a measurement whose pin has been bumped underneath it', () => {
    // The hazard the digest prefix exists for: the record references the
    // constant in base-images.ts (audit:pins requires that), so without the
    // prefix a new digest would silently inherit the old measurement.
    const bumped = [{ ...SOUND_IMAGE, digestPrefix: 'deadbeef1234' }];
    expect(rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [SOUND_CLAIM], bumped)).toContain(
      'image-digest-drift',
    );
  });

  it('rejects a digest prefix too short to detect that', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [SOUND_CLAIM], [
        { ...SOUND_IMAGE, digestPrefix: '8d32' },
      ]),
    ).toContain('image-digest-prefix');
  });

  it('rejects an attestation manifest counted as a platform', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [SOUND_CLAIM], [
        { ...SOUND_IMAGE, platforms: ['linux/amd64', 'unknown/unknown'] },
      ]),
    ).toContain('image-platforms-attestation');
  });

  it('rejects an index that recorded no platforms, and an undated measurement', () => {
    expect(
      rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [SOUND_CLAIM], [
        { ...SOUND_IMAGE, platforms: [] },
      ]),
    ).toContain('image-platforms-empty');
    expect(
      rulesFor([SOUND_WORKLOAD], [SOUND_PRICE], [SOUND_CLAIM], [
        { ...SOUND_IMAGE, measuredOn: 'last week' },
      ]),
    ).toContain('image-measured-on');
  });

  it('keeps every shipped measurement tied to the digest it was taken from', () => {
    for (const record of IMAGE_PLATFORMS) {
      expect(record.image.reference).toContain(record.digestPrefix);
      expect(record.digestPrefix).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it('keeps every shipped benchmark claim unmeasured, with a source and a caveat', () => {
    for (const claim of BENCHMARK_CLAIMS) {
      expect(claim.measured).toBe(false);
      expect(claim.source).toMatch(/^https:\/\//);
      expect(claim.caveat.length).toBeGreaterThan(40);
    }
  });
});
