import {
  CATALOGUED_MAX_CPU,
  DEFAULT_LOOKBACK_DAYS,
  FARGATE_SIZE_ROWS,
  LAMBDA_MINIMUM_INVOCATIONS,
  LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB,
  MINIMUM_ECS_METRIC_HOURS,
  MINIMUM_REASON_LENGTH,
  RIGHT_SIZING_WORKLOADS,
  type RightSizingWorkload,
  assertValidRightSizingCatalogue,
  blockingReason,
  fargateSizeRow,
  isProposable,
  isValidFargateSize,
  postureTotals,
  renderRightSizingTable,
  rightSizingWorkloadById,
  rightSizingWorkloadMatches,
  rightSizingWorkloadsFor,
  sweeperCatalogue,
  validateRightSizingCatalogue,
} from '../lib/right-sizing';

/**
 * Tests for the right-sizing catalogue and its arithmetic.
 *
 * Everything asserted here fails in the same direction if it is wrong: a
 * recommendation becomes a proposal it should not have become, or the catalogue
 * keeps saying a service cannot be measured after it has become measurable. Both
 * produce a smaller number than they should, and a smaller number is what
 * success looks like on this page.
 */

/** A minimal proposable entry, so each test varies one thing. */
const proposable = (overrides: Partial<RightSizingWorkload> = {}): RightSizingWorkload => ({
  id: 'test-service',
  stackPrefixes: ['TestStack-'],
  servicePathSuffix: 'Service/Service',
  serviceNamePattern: 'test-service',
  posture: 'propose',
  reason:
    'A fixture entry whose reason is long enough to satisfy the length floor and which names a ' +
    'failure: a resize applied here would change the thing under test.',
  expectedResources: 1,
  floor: { cpu: 512, memoryMiB: 1024 },
  ...overrides,
});

const rulesFrom = (workloads: readonly RightSizingWorkload[]): string[] =>
  validateRightSizingCatalogue(workloads).map((finding) => finding.rule);

describe('the Fargate size table', () => {
  it('accepts every pair the shipped rows describe', () => {
    for (const row of FARGATE_SIZE_ROWS) {
      const values =
        row.memoryMiB ??
        Array.from(
          { length: (row.maxMemoryMiB - row.minMemoryMiB) / (row.stepMiB ?? 1024) + 1 },
          (_unused, index) => row.minMemoryMiB + index * (row.stepMiB ?? 1024),
        );
      for (const memoryMiB of values) {
        expect(isValidFargateSize(row.cpu, memoryMiB)).toBe(true);
      }
    }
  });

  // The pair that is rejected at RegisterTaskDefinition rather than at synth:
  // 512 CPU takes 1024 MiB at the smallest, and 512 looks like a smaller
  // version of a valid size rather than an invalid one.
  it.each([
    [512, 512],
    [256, 4096],
    [1024, 1024],
    [2048, 2048],
    [4096, 4096],
  ])('rejects %i CPU with %i MiB', (cpu, memoryMiB) => {
    expect(isValidFargateSize(cpu, memoryMiB)).toBe(false);
  });

  it('rejects a memory value between two steps', () => {
    expect(isValidFargateSize(1024, 2048)).toBe(true);
    expect(isValidFargateSize(1024, 2560)).toBe(false);
  });

  it('rejects a CPU value Fargate accepts but this table does not cover', () => {
    // Fargate also accepts 8192 and 16384. The table stops at 4096 deliberately,
    // and the consequence is that a recommendation naming one of them is
    // reported rather than silently accepted or silently rejected.
    expect(fargateSizeRow(8192)).toBeUndefined();
    expect(isValidFargateSize(8192, 16384)).toBe(false);
    expect(CATALOGUED_MAX_CPU).toBe(4096);
  });

  it('rejects a CPU value Fargate does not accept either', () => {
    expect(isValidFargateSize(768, 2048)).toBe(false);
  });
});

describe('the shipped catalogue', () => {
  it('is valid', () => {
    expect(validateRightSizingCatalogue()).toEqual([]);
    expect(() => assertValidRightSizingCatalogue()).not.toThrow();
  });

  it('accounts for the eleven ECS services this repository synthesises', () => {
    const totals = postureTotals();
    expect(totals.propose + totals.hold + totals.uncovered).toBe(11);
  });

  it('declares a reason on every entry that is long enough to name a failure', () => {
    for (const workload of RIGHT_SIZING_WORKLOADS) {
      expect(workload.reason.trim().length).toBeGreaterThanOrEqual(MINIMUM_REASON_LENGTH);
    }
  });

  it('declares the two application services uncovered for the documented reason', () => {
    for (const id of ['staging-application', 'production-application']) {
      const workload = rightSizingWorkloadById(id);
      expect(workload.posture).toBe('uncovered');
      expect(workload.uncoveredReason).toBe('dual-target-tracking');
      expect(isProposable(workload)).toBe(false);
    }
  });

  it('keeps the canary pair pointing at each other', () => {
    const stable = rightSizingWorkloadById('canary-stable-service');
    const canary = rightSizingWorkloadById('canary-deploy-canary-service');
    expect(stable.sizeMustMatch).toContain(canary.id);
    expect(canary.sizeMustMatch).toContain(stable.id);
  });

  it('throws on an unknown id rather than returning undefined', () => {
    expect(() => rightSizingWorkloadById('no-such-workload')).toThrow(/no-such-workload/);
  });

  it('records the AWS thresholds the postures are reasoned against', () => {
    expect(DEFAULT_LOOKBACK_DAYS).toBe(14);
    expect(MINIMUM_ECS_METRIC_HOURS).toBe(24);
    expect(LAMBDA_MINIMUM_INVOCATIONS).toBe(50);
    expect(LAMBDA_RECOMMENDATION_MEMORY_CEILING_MIB).toBe(1792);
  });
});

describe('matching a service to an entry', () => {
  it('needs both the stack prefix and the construct path', () => {
    const workload = proposable();
    expect(
      rightSizingWorkloadMatches(workload, {
        stackName: 'TestStack-Staging',
        constructPath: 'Service/Service',
      }),
    ).toBe(true);
    expect(
      rightSizingWorkloadMatches(workload, {
        stackName: 'OtherStack-Staging',
        constructPath: 'Service/Service',
      }),
    ).toBe(false);
    expect(
      rightSizingWorkloadMatches(workload, {
        stackName: 'TestStack-Staging',
        constructPath: 'Cluster/Resource',
      }),
    ).toBe(false);
  });

  /**
   * A suffix match is a suffix match: `StableService/Service` ends with
   * `Service/Service`, so the construct path alone cannot separate the canary
   * stack's stable service from an application service. The stack prefixes are
   * what do it, which is why `stackPrefixes` is required and why
   * `service-ambiguous` exists in the gate rather than a tie-break here — the
   * day two entries do claim one service, the answer a reader needs is which
   * two, not which one won.
   */
  it('matches a longer path ending in the same suffix, which the prefixes disambiguate', () => {
    expect(
      rightSizingWorkloadMatches(proposable({ stackPrefixes: ['CanaryDeployStack-'] }), {
        stackName: 'CanaryDeployStack-Production',
        constructPath: 'StableService/Service',
      }),
    ).toBe(true);

    // And in the shipped catalogue no `Service/Service` entry shares a stack
    // prefix with the canary entries, so nothing is actually ambiguous.
    expect(
      rightSizingWorkloadsFor({
        stackName: 'CanaryDeployStack-Production',
        constructPath: 'StableService/Service',
      }),
    ).toHaveLength(1);
  });

  it('distinguishes the two canary services, which share a stack', () => {
    const stable = rightSizingWorkloadsFor({
      stackName: 'CanaryDeployStack-Production',
      constructPath: 'StableService/Service',
    });
    const canary = rightSizingWorkloadsFor({
      stackName: 'CanaryDeployStack-Production',
      constructPath: 'CanaryService/Service',
    });
    expect(stable.map((entry) => entry.id)).toEqual(['canary-stable-service']);
    expect(canary.map((entry) => entry.id)).toEqual(['canary-deploy-canary-service']);
  });

  it('reports both entries when two claim one service rather than picking one', () => {
    const duplicated = [proposable(), proposable({ id: 'test-service-copy' })];
    expect(
      rightSizingWorkloadsFor(
        { stackName: 'TestStack-Staging', constructPath: 'Service/Service' },
        duplicated,
      ),
    ).toHaveLength(2);
  });
});

describe('whether a recommendation may become a proposal', () => {
  it('allows a valid size at or above the floor on a proposable entry', () => {
    expect(blockingReason(proposable(), { cpu: 512, memoryMiB: 1024 })).toBeUndefined();
    expect(blockingReason(proposable(), { cpu: 1024, memoryMiB: 2048 })).toBeUndefined();
  });

  it('refuses on posture before it looks at the numbers', () => {
    // A hold entry given a perfectly valid size is still a hold: the posture is
    // about the workload and the size cannot override it.
    expect(
      blockingReason(proposable({ posture: 'hold', holdReason: 'paired-comparison', floor: undefined }), {
        cpu: 1024,
        memoryMiB: 2048,
      }),
    ).toBe('posture-hold');
    expect(
      blockingReason(
        proposable({ posture: 'uncovered', uncoveredReason: 'dual-target-tracking', floor: undefined }),
        { cpu: 1024, memoryMiB: 2048 },
      ),
    ).toBe('posture-uncovered');
  });

  it('separates a size this table cannot speak for from one that is invalid', () => {
    expect(blockingReason(proposable(), { cpu: 8192, memoryMiB: 16384 })).toBe(
      'size-outside-catalogue',
    );
    expect(blockingReason(proposable(), { cpu: 1024, memoryMiB: 1024 })).toBe(
      'size-invalid-for-fargate',
    );
  });

  it('refuses a valid size below the floor', () => {
    expect(blockingReason(proposable(), { cpu: 256, memoryMiB: 512 })).toBe('below-floor');
    // Valid, above the CPU floor, below the memory floor: the half-way case a
    // single comparison would miss.
    expect(
      blockingReason(proposable({ floor: { cpu: 512, memoryMiB: 2048 } }), {
        cpu: 512,
        memoryMiB: 1024,
      }),
    ).toBe('below-floor');
  });

  describe('agreement', () => {
    const uniform = proposable({ uniformSize: true, expectedResources: 2 });

    it('accepts peers that agree', () => {
      expect(blockingReason(uniform, { cpu: 512, memoryMiB: 1024 }, [{ cpu: 512, memoryMiB: 1024 }]))
        .toBeUndefined();
    });

    it('refuses peers that disagree', () => {
      expect(
        blockingReason(uniform, { cpu: 512, memoryMiB: 1024 }, [{ cpu: 1024, memoryMiB: 2048 }]),
      ).toBe('peer-disagreement');
    });

    // The case the whole `expectedPeers` count exists for: one of two services
    // produced a finding, so the recommendation agrees with itself and a
    // comparison over an empty list passes. A missing finding is not consent.
    it('treats a missing peer finding as a disagreement, not as unanimity', () => {
      expect(blockingReason(uniform, { cpu: 512, memoryMiB: 1024 }, [])).toBe('peer-disagreement');
    });

    it('requires the named peers as well as its own copies', () => {
      const paired = proposable({
        uniformSize: true,
        expectedResources: 2,
        sizeMustMatch: ['other-entry'],
      });
      const size = { cpu: 512, memoryMiB: 1024 };
      expect(blockingReason(paired, size, [size])).toBe('peer-disagreement');
      expect(blockingReason(paired, size, [size, size])).toBeUndefined();
    });

    it('ignores peers on an entry that requires no agreement', () => {
      expect(
        blockingReason(proposable(), { cpu: 512, memoryMiB: 1024 }, [{ cpu: 4096, memoryMiB: 8192 }]),
      ).toBeUndefined();
    });
  });
});

describe('validation', () => {
  it('rejects a duplicate id', () => {
    expect(rulesFrom([proposable(), proposable()])).toContain('workload-duplicate-id');
  });

  it('rejects an entry that claims every stack or every service', () => {
    expect(rulesFrom([proposable({ stackPrefixes: [] })])).toContain('workload-no-stack-prefix');
    expect(rulesFrom([proposable({ servicePathSuffix: '  ' })])).toContain('workload-no-path-suffix');
  });

  it('rejects an entry the sweeper could never match at runtime', () => {
    expect(rulesFrom([proposable({ serviceNamePattern: '' })])).toContain(
      'workload-no-service-name-pattern',
    );
  });

  it('rejects an entry that expects to match nothing', () => {
    expect(rulesFrom([proposable({ expectedResources: 0 })])).toContain('workload-expects-nothing');
  });

  it('rejects a reason too short to name a failure', () => {
    expect(rulesFrom([proposable({ reason: 'not safe' })])).toContain('workload-reason-too-short');
  });

  it('rejects an uncovered entry with no reason, in either direction', () => {
    expect(rulesFrom([proposable({ posture: 'uncovered', floor: undefined })])).toContain(
      'uncovered-without-reason',
    );
    expect(rulesFrom([proposable({ uncoveredReason: 'step-scaling' })])).toContain(
      'uncovered-reason-without-posture',
    );
  });

  it('rejects a hold with no reason, in either direction', () => {
    expect(rulesFrom([proposable({ posture: 'hold', floor: undefined })])).toContain(
      'hold-without-reason',
    );
    expect(rulesFrom([proposable({ holdReason: 'headroom-is-the-point' })])).toContain(
      'hold-reason-without-posture',
    );
  });

  it('rejects a proposable entry with no floor', () => {
    expect(rulesFrom([proposable({ floor: undefined })])).toContain('propose-without-floor');
  });

  // A floor that is not itself a deployable size can never be reached, so every
  // proposal below the next valid pair is rejected for the wrong reason.
  it('rejects a floor that Fargate would not register', () => {
    expect(rulesFrom([proposable({ floor: { cpu: 512, memoryMiB: 512 } })])).toContain(
      'floor-invalid-for-fargate',
    );
  });

  it('rejects a floor nothing would consult', () => {
    expect(
      rulesFrom([proposable({ posture: 'hold', holdReason: 'paired-comparison' })]),
    ).toContain('floor-on-unproposable-workload');
  });

  it('rejects uniformSize on an entry with nothing to be uniform with', () => {
    expect(rulesFrom([proposable({ uniformSize: true })])).toContain(
      'uniform-size-on-single-resource',
    );
  });

  describe('sizeMustMatch', () => {
    it('rejects a self-reference', () => {
      expect(rulesFrom([proposable({ sizeMustMatch: ['test-service'] })])).toContain(
        'size-match-self',
      );
    });

    it('rejects a peer that does not exist', () => {
      expect(rulesFrom([proposable({ sizeMustMatch: ['absent'] })])).toContain(
        'size-match-unknown-peer',
      );
    });

    it('rejects a constraint that holds in one direction only', () => {
      const rules = rulesFrom([
        proposable({ id: 'left', sizeMustMatch: ['right'] }),
        proposable({ id: 'right' }),
      ]);
      expect(rules).toContain('size-match-not-symmetric');
    });

    it('rejects peers whose floors disagree', () => {
      const rules = rulesFrom([
        proposable({ id: 'left', sizeMustMatch: ['right'], floor: { cpu: 512, memoryMiB: 1024 } }),
        proposable({ id: 'right', sizeMustMatch: ['left'], floor: { cpu: 1024, memoryMiB: 2048 } }),
      ]);
      expect(rules).toContain('size-match-floors-differ');
    });
  });

  it('throws with every finding listed rather than only the first', () => {
    expect(() =>
      assertValidRightSizingCatalogue([proposable({ reason: 'short', floor: undefined })]),
    ).toThrow(/workload-reason-too-short[\s\S]*propose-without-floor/);
  });
});

describe('the sweeper projection', () => {
  it('carries the posture, the floor and the constraints but not the prose', () => {
    const entries = sweeperCatalogue();
    expect(entries).toHaveLength(RIGHT_SIZING_WORKLOADS.length);

    const blueGreen = entries.find((entry) => entry.id === 'blue-green-service');
    expect(blueGreen).toMatchObject({
      pattern: '*-bg-service',
      posture: 'propose',
      floorCpu: 512,
      floorMemoryMiB: 1024,
      uniformSize: true,
      expectedResources: 2,
    });

    // The reasons are several kilobytes and belong in the file and the guide,
    // not in a Lambda environment variable.
    expect(JSON.stringify(entries)).not.toContain('rehearsed');
  });

  it('carries the blocking reason so a log line can name it', () => {
    const entries = sweeperCatalogue();
    expect(entries.find((entry) => entry.id === 'production-application')?.blockedReason).toBe(
      'dual-target-tracking',
    );
    expect(entries.find((entry) => entry.id === 'otel-sampler-service')?.blockedReason).toBe(
      'headroom-is-the-point',
    );
    expect(entries.find((entry) => entry.id === 'blue-green-service')?.blockedReason).toBeUndefined();
  });

  it('omits a floor where there is none rather than defaulting to zero', () => {
    const held = sweeperCatalogue().find((entry) => entry.id === 'otel-sampler-service');
    expect(held?.floorCpu).toBeUndefined();
    expect(held?.floorMemoryMiB).toBeUndefined();
  });
});

describe('rendering', () => {
  it('renders one row per entry with the reason in the Why column', () => {
    const table = renderRightSizingTable();
    const rows = table.split('\n').slice(2);
    expect(rows).toHaveLength(RIGHT_SIZING_WORKLOADS.length);
    expect(table).toContain('dual-target-tracking');
    expect(table).toContain('headroom-is-the-point');
    expect(table).toContain('its own copies');
  });

  it('shows an em dash rather than a zero where there is no floor', () => {
    const row = renderRightSizingTable([
      proposable({ posture: 'hold', holdReason: 'paired-comparison', floor: undefined }),
    ])
      .split('\n')
      .slice(2)[0];
    expect(row).toContain('| — |');
  });

  it('counts services rather than entries', () => {
    expect(postureTotals([proposable({ expectedResources: 3 })])).toEqual({
      propose: 3,
      hold: 0,
      uncovered: 0,
    });
  });
});
