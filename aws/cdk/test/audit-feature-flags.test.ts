import * as path from 'path';
import {
  auditFeatureFlags,
  DEFAULT_MANIFEST_DIR,
  DEFAULT_MAX_LIFETIME_DAYS,
  Finding,
  FindingRule,
  formatFindings,
  MANIFEST_FILE_PATTERN,
  parseIsoDate,
  parseNowArgument,
  readManifests,
} from '../tools/audit-feature-flags';

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..', '..');

/** A flag that violates nothing, as the base for one-field mutations. */
const validFlag = (overrides: Record<string, unknown> = {}) => ({
  description: 'Rebuilt dashboard shell.',
  kind: 'release',
  owner: '@web-platform',
  ticket: 'WEB-1421',
  createdOn: '2026-08-03',
  expiresOn: '2026-09-15',
  enabled: true,
  rolloutPercentage: 25,
  ...overrides,
});

const manifestOf = (flag: Record<string, unknown>, key = 'newDashboard') => ({
  version: '1',
  flags: { [key]: flag },
});

const rulesFor = (manifest: unknown, options = {}): FindingRule[] =>
  auditFeatureFlags(manifest, options).map((f) => f.rule);

describe('auditFeatureFlags', () => {
  describe('a well-formed manifest', () => {
    it('accepts a release flag mid-rollout', () => {
      expect(auditFeatureFlags(manifestOf(validFlag()))).toEqual([]);
    });

    it('accepts an operational flag with no expiry, no ticket, and a value', () => {
      expect(
        auditFeatureFlags(
          manifestOf(
            {
              description: 'Per-client request budget enforced at the edge.',
              kind: 'operational',
              owner: '@sre',
              createdOn: '2024-02-11',
              enabled: true,
              value: 100,
            },
            'rateLimitRequestsPerMinute',
          ),
        ),
      ).toEqual([]);
    });

    it('accepts an empty flag set — a project with no flags is the goal state', () => {
      expect(auditFeatureFlags({ version: '1', flags: {} })).toEqual([]);
    });
  });

  describe('manifest structure', () => {
    it.each([
      ['a string', 'not a manifest'],
      ['an array', [{ version: '1' }]],
      ['null', null],
    ])('rejects %s', (_label, manifest) => {
      expect(rulesFor(manifest)).toEqual(['invalid-flags']);
    });

    it('rejects a version it does not parse', () => {
      expect(rulesFor({ version: '2', flags: {} })).toEqual(['unsupported-version']);
    });

    it('rejects a missing flags object', () => {
      expect(rulesFor({ version: '1' })).toEqual(['invalid-flags']);
    });

    it('stops after an invalid flags object rather than reporting on its contents', () => {
      // Reporting fifty per-flag findings underneath a top-level structural
      // failure buries the one line that explains all of them.
      expect(rulesFor({ version: '1', flags: [] })).toEqual(['invalid-flags']);
    });

    it('rejects a flag key that is not a lower-camelCase identifier', () => {
      expect(rulesFor(manifestOf(validFlag(), 'new-dashboard'))).toEqual(['invalid-key']);
      expect(rulesFor(manifestOf(validFlag(), 'NewDashboard'))).toEqual(['invalid-key']);
      expect(rulesFor(manifestOf(validFlag(), 'new dashboard'))).toEqual(['invalid-key']);
    });

    it('accepts digits inside a key', () => {
      expect(auditFeatureFlags(manifestOf(validFlag(), 'checkoutV2'))).toEqual([]);
    });

    it('rejects a declaration that is not an object', () => {
      expect(rulesFor({ version: '1', flags: { newDashboard: true } })).toEqual(['invalid-type']);
    });
  });

  describe('required declarations', () => {
    it.each(['description', 'kind', 'owner', 'createdOn', 'enabled'])(
      'requires %s',
      (field) => {
        const flag = validFlag();
        delete (flag as Record<string, unknown>)[field];
        expect(rulesFor(manifestOf(flag))).toContain('missing-field');
      },
    );

    it('rejects a field nothing reads', () => {
      // The failure this prevents is silent: `rolloutPct: 50` deploys fine,
      // reads as a 100% rollout, and looks like a 50% one in review.
      const findings = auditFeatureFlags(manifestOf(validFlag({ rolloutPct: 50 })));
      expect(findings.map((f) => f.rule)).toEqual(['unknown-field']);
      expect(findings[0].message).toContain('rolloutPct');
    });

    it.each([
      ['description', 42, 'string'],
      ['owner', ['@web-platform'], 'string'],
      ['enabled', 'true', 'boolean'],
      ['rolloutPercentage', '25', 'number'],
    ])('rejects %s of the wrong type', (field, value, expected) => {
      const findings = auditFeatureFlags(manifestOf(validFlag({ [field]: value })));
      expect(findings.map((f) => f.rule)).toContain('invalid-type');
      expect(findings.find((f) => f.rule === 'invalid-type')?.message).toContain(expected);
    });

    it('rejects a declaration that is present but empty', () => {
      expect(rulesFor(manifestOf(validFlag({ owner: '   ' })))).toEqual(['invalid-type']);
    });
  });

  describe('kind', () => {
    it('rejects a kind outside the vocabulary', () => {
      expect(rulesFor(manifestOf(validFlag({ kind: 'temporary' })))).toEqual(['invalid-kind']);
    });

    it('does not cascade further kind-dependent rules off an unknown kind', () => {
      // Everything below keys off the kind, so reporting "missing expiry" for a
      // kind that does not exist would be noise on top of the real finding.
      const flag = validFlag({ kind: 'temporary' });
      delete (flag as Record<string, unknown>).expiresOn;
      delete (flag as Record<string, unknown>).ticket;
      expect(rulesFor(manifestOf(flag))).toEqual(['invalid-kind']);
    });

    it.each(['release', 'experiment'])('requires an expiry on a %s flag', (kind) => {
      const flag = validFlag({ kind });
      delete (flag as Record<string, unknown>).expiresOn;
      expect(rulesFor(manifestOf(flag))).toEqual(['missing-expiry']);
    });

    it.each(['release', 'experiment'])('requires a ticket on a %s flag', (kind) => {
      const flag = validFlag({ kind });
      delete (flag as Record<string, unknown>).ticket;
      expect(rulesFor(manifestOf(flag))).toEqual(['missing-ticket']);
    });

    it('rejects an expiry on an operational flag', () => {
      expect(
        rulesFor(
          manifestOf({
            description: 'Stop serving writes.',
            kind: 'operational',
            owner: '@sre',
            createdOn: '2026-02-11',
            expiresOn: '2026-04-11',
            enabled: false,
          }),
        ),
      ).toEqual(['expiry-on-permanent']);
    });

    it('rejects a value on a flag that is going to be deleted', () => {
      expect(rulesFor(manifestOf(validFlag({ value: 100 })))).toEqual(['value-on-temporary']);
    });
  });

  describe('dates', () => {
    it.each([
      ['a non-date', 'soon'],
      ['a day that does not exist', '2026-02-30'],
      ['a month that does not exist', '2026-13-01'],
      ['a timestamp rather than a day', '2026-08-03T00:00:00Z'],
      ['a slash-separated date', '2026/08/03'],
    ])('rejects %s', (_label, value) => {
      expect(rulesFor(manifestOf(validFlag({ expiresOn: value })))).toContain('invalid-date');
    });

    it('does not roll an impossible day forward into the next month', () => {
      // `new Date('2026-02-30')` is a valid Date in March. Accepting it would
      // move a removal deadline by two days without telling anyone.
      expect(parseIsoDate('2026-02-30')).toBeUndefined();
      expect(parseIsoDate('2026-02-28')?.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    });

    it('rejects a deadline that had already passed when it was set', () => {
      expect(
        rulesFor(manifestOf(validFlag({ createdOn: '2026-08-03', expiresOn: '2026-07-03' }))),
      ).toEqual(['expiry-before-creation']);
    });

    it('rejects a deadline on the day the flag was created', () => {
      expect(
        rulesFor(manifestOf(validFlag({ createdOn: '2026-08-03', expiresOn: '2026-08-03' }))),
      ).toEqual(['expiry-before-creation']);
    });

    it(`rejects a lifetime beyond ${DEFAULT_MAX_LIFETIME_DAYS} days`, () => {
      const findings = auditFeatureFlags(
        manifestOf(validFlag({ createdOn: '2026-01-01', expiresOn: '2026-12-31' })),
      );
      expect(findings.map((f) => f.rule)).toEqual(['expiry-horizon']);
      expect(findings[0].message).toContain('364 days');
    });

    it('accepts a lifetime exactly at the limit', () => {
      // 2026-01-01 + 90 days. An off-by-one here would reject the boundary the
      // documentation tells people to use.
      expect(
        auditFeatureFlags(manifestOf(validFlag({ createdOn: '2026-01-01', expiresOn: '2026-04-01' }))),
      ).toEqual([]);
    });

    it('respects a caller-supplied horizon', () => {
      expect(
        rulesFor(manifestOf(validFlag({ createdOn: '2026-01-01', expiresOn: '2026-04-01' })), {
          maxLifetimeDays: 30,
        }),
      ).toEqual(['expiry-horizon']);
    });
  });

  describe('expiry against a clock', () => {
    const expiring = manifestOf(validFlag({ createdOn: '2026-08-03', expiresOn: '2026-09-15' }));

    it('reports nothing about the calendar when no clock is supplied', () => {
      // The repository's CI gate runs this way on purpose: a flag's deadline is
      // not a statement about whether an unrelated pull request is correct, and
      // a build that turns red on a date nobody in the pull request chose is a
      // build people learn to bypass.
      expect(auditFeatureFlags(expiring)).toEqual([]);
    });

    it('reports an expired flag when a clock is supplied', () => {
      const findings = auditFeatureFlags(expiring, { now: new Date('2026-09-16T00:00:00Z') });
      expect(findings.map((f) => f.rule)).toEqual(['expired']);
      expect(findings[0].message).toContain('2026-09-15');
    });

    it('does not report a flag on its own deadline', () => {
      expect(auditFeatureFlags(expiring, { now: new Date('2026-09-15T23:59:59Z') })).toEqual([]);
    });
  });

  describe('rollout', () => {
    it.each([-1, 101, 12.5])('rejects %s as a percentage', (rolloutPercentage) => {
      expect(rulesFor(manifestOf(validFlag({ rolloutPercentage })))).toEqual([
        'rollout-out-of-range',
      ]);
    });

    it('reports only the range violation, not the consistency rules under it', () => {
      expect(rulesFor(manifestOf(validFlag({ enabled: false, rolloutPercentage: 500 })))).toEqual([
        'rollout-out-of-range',
      ]);
    });

    it('rejects a percentage on a flag that is switched off', () => {
      expect(
        rulesFor(manifestOf(validFlag({ enabled: false, rolloutPercentage: 25 }))),
      ).toEqual(['rollout-on-disabled']);
    });

    it('rejects a flag that is on at zero percent', () => {
      expect(rulesFor(manifestOf(validFlag({ enabled: true, rolloutPercentage: 0 })))).toEqual([
        'enabled-at-zero-rollout',
      ]);
    });

    it('accepts an off flag at zero percent, and a full rollout', () => {
      expect(
        auditFeatureFlags(manifestOf(validFlag({ enabled: false, rolloutPercentage: 0 }))),
      ).toEqual([]);
      expect(
        auditFeatureFlags(manifestOf(validFlag({ enabled: true, rolloutPercentage: 100 }))),
      ).toEqual([]);
    });

    it('accepts a flag with no percentage at all as on-for-everyone', () => {
      const flag = validFlag();
      delete (flag as Record<string, unknown>).rolloutPercentage;
      expect(auditFeatureFlags(manifestOf(flag))).toEqual([]);
    });
  });

  describe('reporting', () => {
    it('reports every flag, not just the first that fails', () => {
      const findings = auditFeatureFlags({
        version: '1',
        flags: {
          first: validFlag({ owner: '' }),
          second: validFlag({ kind: 'nonsense' }),
        },
      });
      expect(findings.map((f) => f.path)).toEqual(['flags.first.owner', 'flags.second.kind']);
    });

    it('names the offending path in a form a reader can search for', () => {
      const [finding] = auditFeatureFlags(manifestOf(validFlag({ rolloutPercentage: 400 })));
      expect(finding.path).toBe('flags.newDashboard.rolloutPercentage');
    });

    it('formats findings with the path, the rule, and the reason', () => {
      const findings: Finding[] = [
        { rule: 'expired', path: 'flags.a.expiresOn', message: 'overdue.' },
      ];
      expect(formatFindings(findings)).toBe('flags.a.expiresOn  [expired]\n    overdue.');
    });
  });

  describe('--now', () => {
    it('is absent unless asked for', () => {
      expect(parseNowArgument(['aws/appconfig'])).toBeUndefined();
    });

    it('means today when given bare', () => {
      expect(parseNowArgument(['--now'])).toBeInstanceOf(Date);
    });

    it('accepts an explicit day', () => {
      expect(parseNowArgument(['--now=2026-09-01'])?.toISOString()).toBe(
        '2026-09-01T00:00:00.000Z',
      );
    });

    it('refuses a day it cannot parse rather than silently meaning today', () => {
      expect(() => parseNowArgument(['--now=next friday'])).toThrow(/ISO calendar day/);
    });
  });
});

describe('the manifests shipped in this repository', () => {
  const manifests = readManifests(REPOSITORY_ROOT, DEFAULT_MANIFEST_DIR);

  it('finds at least one manifest to check', () => {
    // Without this the suite below passes vacuously if the directory is renamed.
    expect(manifests.length).toBeGreaterThan(0);
  });

  it.each(manifests.map((m) => [m.file, m.manifest]))('%s is clean', (_file, manifest) => {
    expect(auditFeatureFlags(manifest)).toEqual([]);
  });

  it('matches manifests by name and leaves everything else in the directory alone', () => {
    expect(MANIFEST_FILE_PATTERN.test('feature-flags.json')).toBe(true);
    expect(MANIFEST_FILE_PATTERN.test('feature-flags.example.json')).toBe(true);
    expect(MANIFEST_FILE_PATTERN.test('feature-flags.staging.json')).toBe(true);
    expect(MANIFEST_FILE_PATTERN.test('README.md')).toBe(false);
    expect(MANIFEST_FILE_PATTERN.test('feature-flags.schema.json.bak')).toBe(false);
  });

  it('returns nothing for a directory that does not exist', () => {
    expect(readManifests(REPOSITORY_ROOT, path.posix.join('aws', 'nowhere'))).toEqual([]);
  });
});
