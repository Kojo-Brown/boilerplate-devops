import {
  DEFAULT_SCRUBBING_RULESET,
  IPV4_RULE,
  LAMBDA_ENVIRONMENT_BYTE_LIMIT,
  RedactionRule,
  ScrubbingRuleset,
  assertEnvironmentFitsLambdaLimit,
  assertValidScrubbingRuleset,
  environmentByteSize,
  extendRuleset,
  serializeRuleset,
  validateScrubbingRuleset,
} from '../lib/log-scrubbing';

/**
 * The ruleset is data, and every way of getting it wrong produces a pipeline
 * that reports success. These tests are the validator's own contract: each one
 * names a configuration that deploys cleanly and scrubs incorrectly.
 */

const rule = (overrides: Partial<RedactionRule> = {}): RedactionRule => ({
  id: 'test-rule',
  pattern: 'secret-[0-9]+',
  replacement: '[REDACTED:TEST]',
  why: 'fixture',
  ...overrides,
});

const ruleset = (overrides: Partial<ScrubbingRuleset> = {}): ScrubbingRuleset => ({
  rules: [rule()],
  sensitiveKeys: ['password'],
  tokenizeKeys: ['email'],
  maxDepth: 8,
  maxScannedValueChars: 8192,
  ...overrides,
});

describe('the shipped default ruleset', () => {
  it('is valid, so synth of a stack that does not override it cannot fail on it', () => {
    expect(validateScrubbingRuleset(DEFAULT_SCRUBBING_RULESET)).toEqual([]);
  });

  it('compiles every pattern the handler will compile, with the global flag added', () => {
    for (const entry of DEFAULT_SCRUBBING_RULESET.rules) {
      expect(() => new RegExp(entry.pattern, `${entry.flags ?? ''}g`)).not.toThrow();
    }
  });

  it('leaves a kilobyte of the Lambda environment for everything else', () => {
    const serialized = serializeRuleset(DEFAULT_SCRUBBING_RULESET);
    // The limit is on the whole environment — every variable, keys included —
    // and the ruleset is the entry that grows when a rule is added. The rest of
    // the environment is around 300 bytes of ARNs and names, so this leaves
    // room for a handful of local rules before the synth-time assert fires.
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(
      LAMBDA_ENVIRONMENT_BYTE_LIMIT - 1024,
    );
  });

  it('leaves IPv4 out, and the opt-in rule is itself valid', () => {
    expect(DEFAULT_SCRUBBING_RULESET.rules.map((entry) => entry.id)).not.toContain('ipv4');
    expect(
      validateScrubbingRuleset(extendRuleset(DEFAULT_SCRUBBING_RULESET, { rules: [IPV4_RULE] })),
    ).toEqual([]);
  });

  it('never masks a key it also tokenises, so correlation keys survive', () => {
    for (const key of DEFAULT_SCRUBBING_RULESET.tokenizeKeys) {
      const masked = DEFAULT_SCRUBBING_RULESET.sensitiveKeys.some((pattern) =>
        new RegExp(`^(?:${pattern})$`, 'i').test(key),
      );
      expect({ key, masked }).toEqual({ key, masked: false });
    }
  });
});

describe('validateScrubbingRuleset', () => {
  it('refuses an empty ruleset rather than shipping a transform that removes nothing', () => {
    expect(validateScrubbingRuleset(ruleset({ rules: [] }))[0]).toContain('rules is empty');
  });

  it('refuses a pattern that does not compile — it would throw at cold start and deliver raw', () => {
    const problems = validateScrubbingRuleset(ruleset({ rules: [rule({ pattern: '([a-z' })] }));
    expect(problems.join('\n')).toContain('does not compile');
  });

  it('refuses a pattern that matches the empty string', () => {
    const problems = validateScrubbingRuleset(ruleset({ rules: [rule({ pattern: '[0-9]*' })] }));
    expect(problems.join('\n')).toContain('matches the empty string');
  });

  it("refuses the 'g' flag, which would give the shared RegExp a lastIndex between records", () => {
    const problems = validateScrubbingRuleset(ruleset({ rules: [rule({ flags: 'g' })] }));
    expect(problems.join('\n')).toContain('lastIndex');
  });

  it('refuses a sticky flag for the same reason', () => {
    expect(validateScrubbingRuleset(ruleset({ rules: [rule({ flags: 'y' })] })).length).toBe(1);
  });

  it('accepts case-insensitive and multiline flags', () => {
    expect(validateScrubbingRuleset(ruleset({ rules: [rule({ flags: 'im' })] }))).toEqual([]);
  });

  it('refuses a replacement another rule would match, which cascades the marker', () => {
    const problems = validateScrubbingRuleset(
      ruleset({
        rules: [
          rule({ id: 'email', pattern: '[a-z]+@[a-z.]+', replacement: '[REDACTED:redacted@example.com]' }),
        ],
      }),
    );
    expect(problems.join('\n')).toContain('is matched by rule');
  });

  it('refuses a replacement with no visible marker', () => {
    const problems = validateScrubbingRuleset(ruleset({ rules: [rule({ replacement: '' })] }));
    expect(problems.join('\n')).toContain('carries no');
  });

  it('refuses duplicate rule ids, which make the per-rule counts unreadable', () => {
    const problems = validateScrubbingRuleset(ruleset({ rules: [rule(), rule()] }));
    expect(problems.join('\n')).toContain('duplicate rule id');
  });

  it('refuses a rule id that is not a slug', () => {
    expect(validateScrubbingRuleset(ruleset({ rules: [rule({ id: 'Test Rule' })] })).length).toBe(1);
  });

  it('refuses a key that is both masked and tokenised — masking wins and the join dies', () => {
    const problems = validateScrubbingRuleset(
      ruleset({ sensitiveKeys: ['email'], tokenizeKeys: ['email'] }),
    );
    expect(problems.join('\n')).toContain('both tokenised and matched');
  });

  it('refuses a sensitive-key pattern that does not compile', () => {
    expect(validateScrubbingRuleset(ruleset({ sensitiveKeys: ['(unclosed'] })).length).toBe(1);
  });

  it('refuses a sensitive-key pattern that matches every key', () => {
    const problems = validateScrubbingRuleset(ruleset({ sensitiveKeys: ['.*'] }));
    expect(problems.join('\n')).toContain('matches the empty key name');
  });

  it('refuses duplicate tokenised keys', () => {
    const problems = validateScrubbingRuleset(ruleset({ tokenizeKeys: ['email', 'EMAIL'] }));
    expect(problems.join('\n')).toContain('duplicate tokenised key');
  });

  it.each([0, 33, 2.5])('refuses maxDepth %p', (maxDepth) => {
    expect(validateScrubbingRuleset(ruleset({ maxDepth })).length).toBe(1);
  });

  it.each([255, 262145])('refuses maxScannedValueChars %p', (maxScannedValueChars) => {
    expect(validateScrubbingRuleset(ruleset({ maxScannedValueChars })).length).toBe(1);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = validateScrubbingRuleset(
      ruleset({ rules: [rule({ pattern: '([a-z' })], maxDepth: 0, sensitiveKeys: ['(unclosed'] }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });
});

describe('assertValidScrubbingRuleset', () => {
  it('throws with every problem and a pointer to the docs', () => {
    expect(() => assertValidScrubbingRuleset(ruleset({ rules: [] }))).toThrow(
      /Invalid log-scrubbing ruleset[\s\S]*docs\/log-pipeline\.md/,
    );
  });

  it('passes the default ruleset through silently', () => {
    expect(() => assertValidScrubbingRuleset(DEFAULT_SCRUBBING_RULESET)).not.toThrow();
  });
});

describe('extendRuleset', () => {
  it('adds without restating, and has no removal path', () => {
    const extended = extendRuleset(DEFAULT_SCRUBBING_RULESET, {
      rules: [rule({ id: 'internal-id' })],
      sensitiveKeys: ['internal_reference'],
      tokenizeKeys: ['tenant_id'],
    });
    expect(extended.rules).toHaveLength(DEFAULT_SCRUBBING_RULESET.rules.length + 1);
    expect(extended.tokenizeKeys).toContain('tenant_id');
    expect(extended.maxDepth).toBe(DEFAULT_SCRUBBING_RULESET.maxDepth);
  });

  it('overrides the bounds when asked', () => {
    expect(extendRuleset(DEFAULT_SCRUBBING_RULESET, { maxDepth: 4 }).maxDepth).toBe(4);
  });
});

describe('serializeRuleset', () => {
  it('drops the prose the handler never reads', () => {
    const parsed = JSON.parse(serializeRuleset(DEFAULT_SCRUBBING_RULESET));
    expect(parsed.rules[0].why).toBeUndefined();
    expect(parsed.rules[0].pattern).toBe(DEFAULT_SCRUBBING_RULESET.rules[0].pattern);
  });

  it('keeps the validator on the rules, so the extra check travels with them', () => {
    const parsed = JSON.parse(serializeRuleset(DEFAULT_SCRUBBING_RULESET));
    const card = parsed.rules.find((entry: { id: string }) => entry.id === 'credit-card');
    expect(card.requires).toBe('luhn');
  });

  it('lowercases tokenised keys, because the handler matches on the lowercased key', () => {
    const parsed = JSON.parse(serializeRuleset(ruleset({ tokenizeKeys: ['Email'] })));
    expect(parsed.tokenizeKeys).toEqual(['email']);
  });
});

describe('assertEnvironmentFitsLambdaLimit', () => {
  it('counts keys as well as values, the way Lambda does', () => {
    expect(environmentByteSize({ AB: 'cd' })).toBe(4);
  });

  it('accepts an environment inside the limit', () => {
    expect(() =>
      assertEnvironmentFitsLambdaLimit(
        { SCRUBBING_RULESET: serializeRuleset(DEFAULT_SCRUBBING_RULESET) },
        'test',
      ),
    ).not.toThrow();
  });

  it('refuses one Lambda would reject, and names the entry to shorten', () => {
    expect(() =>
      assertEnvironmentFitsLambdaLimit({ SCRUBBING_RULESET: 'x'.repeat(5000) }, 'TestStack'),
    ).toThrow(/TestStack[\s\S]*SCRUBBING_RULESET/);
  });
});
