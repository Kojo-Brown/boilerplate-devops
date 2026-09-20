/**
 * The redaction ruleset the log pipeline's Firehose transform runs, and the
 * validation that refuses the configurations it cannot run correctly.
 *
 * This file holds **data and its validation only**. The engine that applies it
 * lives in `LOG_SCRUBBER_SOURCE` in `log-pipeline-stack.ts`, because that
 * string is what Lambda executes and a second copy here would be the one the
 * tests prove correct while the deployed one drifts. What is here is the part a
 * reviewer has to be able to read in a diff: which patterns are matched, which
 * keys are masked, which are tokenised, and what each decision costs.
 *
 * ## Why a ruleset needs a validator at all
 *
 * Every way of getting this wrong produces a pipeline that looks healthy.
 *
 *   • A pattern that fails to compile throws at cold start. Firehose retries
 *     the batch, every invocation fails the same way, and after the retries the
 *     records are delivered to the error prefix **unscrubbed** — the one
 *     outcome the pipeline exists to prevent, reached by a typo in a regex that
 *     nothing in `tsc` or `cdk synth` reads.
 *
 *   • A pattern that matches the empty string matches at every position, so
 *     every log line becomes a run of redaction markers. The pipeline is green,
 *     delivery succeeds, and the archive is worthless.
 *
 *   • A replacement that is itself matched by another rule cascades: the marker
 *     is rewritten by the next rule and the result no longer says what was
 *     removed. `redacted@example.com` as an email replacement is the obvious
 *     case — it is matched by the email rule that produced it.
 *
 *   • A `g` or `y` flag on a rule gives the compiled RegExp a `lastIndex` that
 *     survives between calls. Reused across records it skips matches, so the
 *     same input is scrubbed on one invocation and passed through on the next.
 *     The engine adds `g` itself, exactly once, so rules must not carry it.
 *
 *   • A key listed for both masking and tokenisation is masked, because masking
 *     runs first. The join key you built the tokeniser for silently becomes a
 *     constant, and nothing anywhere reports it.
 *
 * `assertValidScrubbingRuleset` is called at synth time, so all five are a
 * failed build rather than a failed deploy or a quiet leak.
 */

/** Prefix every mask carries, so a redacted field is visibly redacted. */
export const REDACTION_MARKER_PREFIX = '[REDACTED:';

/** Prefix every tokenised value carries: `tkn:<label>:<hmac>`. */
export const TOKEN_PREFIX = 'tkn:';

/** Marker substituted for a value longer than `maxScannedValueChars`. */
export const TRUNCATION_MARKER = '[TRUNCATED]';

/**
 * One pattern applied to free text and to every string value.
 *
 * `pattern` is a RegExp source without flags. The engine compiles it with `g`
 * and with `flags`, and applies every rule to the *original* string, merging
 * overlapping spans before rewriting — a rule never sees another rule's output,
 * which is what keeps the result independent of rule order.
 */
export interface RedactionRule {
  /** Stable id; appears in the per-rule redaction counts the handler publishes. */
  readonly id: string;
  /** RegExp source. Compiled with `g` by the engine — do not include it here. */
  readonly pattern: string;
  /** Extra flags. `i`, `m`, `s` and `u` only; `g` and `y` are refused. */
  readonly flags?: string;
  /** Literal replacement for the matched span. Must carry the redaction marker. */
  readonly replacement: string;
  /**
   * Extra test the matched text must pass before it is redacted.
   *
   * `luhn` is the only one, and it exists because the alternative to a check
   * digit on a 13-to-19-digit run is redacting order ids, trace ids and
   * durations in microseconds. It is a filter, not proof: roughly one in ten
   * arbitrary digit runs passes Luhn, so this trades most false positives for
   * some, in the direction that keeps logs readable without keeping card
   * numbers.
   */
  readonly requires?: 'luhn';
  /** Why the rule exists. Documentation — never shipped to the function. */
  readonly why: string;
}

/**
 * What the handler is given: patterns, key policy, and the two bounds that keep
 * one pathological record from taking the batch down with it.
 */
export interface ScrubbingRuleset {
  readonly rules: readonly RedactionRule[];
  /**
   * RegExp sources matched against JSON **key names**, case-insensitively and
   * anchored — a key whose name matches has its value replaced wholesale,
   * whatever the value's type.
   *
   * Key matching and value matching catch different things and neither
   * subsumes the other: a value-only ruleset misses `"ssn": "not on file"`
   * and `"password": 12345`, and a key-only ruleset misses the email somebody
   * interpolated into a `message` string.
   */
  readonly sensitiveKeys: readonly string[];
  /**
   * Literal key names (case-insensitive) whose values are replaced by a keyed
   * hash instead of a mask, so records for one subject can still be correlated.
   * Literal rather than pattern, because these are checked for overlap with
   * `sensitiveKeys` and a pattern cannot be checked against a pattern.
   */
  readonly tokenizeKeys: readonly string[];
  /**
   * How deep into a JSON object the walker descends. Below it, the subtree is
   * replaced by a marker rather than passed through: an attacker-influenced
   * payload nested a thousand deep would otherwise either overflow the stack —
   * a `ProcessingFailed` record, delivered raw — or be emitted unscrubbed.
   */
  readonly maxDepth: number;
  /**
   * Longest string value scanned. Longer values are truncated to this length
   * with {@link TRUNCATION_MARKER} appended rather than scanned or passed
   * through: regex work is superlinear in the pathological case, a transform
   * that times out is retried and then delivered raw, and a megabyte of base64
   * in a log line has no debugging value to weigh against that.
   */
  readonly maxScannedValueChars: number;
}

/* ── The default rules ─────────────────────────────────────────────────────── */

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: 'email',
    pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.[A-Za-z]{2,}",
    replacement: '[REDACTED:EMAIL]',
    why:
      'The single most common identifier to end up in a log line by accident, usually ' +
      'interpolated into a message rather than carried in a field — which is why the key ' +
      'policy alone does not cover it.',
  },
  {
    id: 'credit-card',
    pattern: "\\b(?:\\d[ -]?){12,18}\\d\\b",
    replacement: '[REDACTED:CARD]',
    requires: 'luhn',
    why:
      'Separators are part of the pattern because a card number pasted into a support ' +
      'ticket carries them, and a rule matching only unbroken runs would miss exactly the ' +
      'hand-typed ones. Luhn keeps order ids and trace ids readable.',
  },
  {
    id: 'us-ssn',
    pattern: "\\b(?!000|666|9\\d{2})\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b",
    replacement: '[REDACTED:SSN]',
    why:
      'The negative lookaheads are the SSA\'s own never-issued ranges. Without them the ' +
      'pattern also matches dates, part numbers and phone extensions written with dashes.',
  },
  {
    id: 'phone-e164',
    pattern: "(?<![\\w.])\\+[1-9]\\d{7,14}(?![\\w.])",
    replacement: '[REDACTED:PHONE]',
    why:
      'E.164 is the form an API carries. The lookarounds keep it off version strings and ' +
      'signed numbers in metrics, which are the two things that look like it.',
  },
  {
    id: 'phone-nanp',
    pattern: "(?<![\\w.-])\\(?[2-9]\\d{2}\\)?[ .-][2-9]\\d{2}[ .-]\\d{4}(?![\\w.-])",
    replacement: '[REDACTED:PHONE]',
    why:
      'A separator is required rather than optional: ten unbroken digits are far more ' +
      'often an id or a millisecond timestamp than a phone number, and NANP area and ' +
      'exchange codes cannot start with 0 or 1.',
  },
  {
    id: 'jwt',
    pattern: "\\beyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}",
    replacement: '[REDACTED:JWT]',
    why:
      'A logged JWT is both PII — the claims usually carry a subject and an email — and a ' +
      'live credential until it expires. `eyJ` is base64url for `{"`, so this matches the ' +
      'header of any JSON-serialised token rather than a particular issuer.',
  },
  {
    id: 'aws-access-key-id',
    pattern: "\\b(?:AKIA|ASIA|AIDA|AROA|AGPA|ANPA|ANVA|APKA)[0-9A-Z]{16}\\b",
    replacement: '[REDACTED:AWS-KEY-ID]',
    why:
      'Not PII, but the pipeline is the last place a leaked credential can be stopped ' +
      'before it lands in an archive read by analytics tooling. The prefixes are AWS\'s own ' +
      'resource-identifier prefixes.',
  },
  {
    id: 'authorization-credential',
    pattern: "(?<=\\b[Aa]uthorization[\"']?\\s*[:=]\\s*[\"']?)(?:[Bb]earer|[Bb]asic|[Dd]igest)\\s+[A-Za-z0-9._~+/=-]{8,}",
    replacement: '[REDACTED:AUTHORIZATION]',
    why:
      'The lookbehind keeps the header name in the line: a redaction that swallows the key ' +
      'as well as the value leaves nobody able to tell which header was present.',
  },
  {
    id: 'url-credentials',
    pattern: "(?<=://)[^\\s:@/]+:[^\\s@/]+(?=@)",
    replacement: '[REDACTED:URL-CREDENTIALS]',
    why:
      'A connection string in an exception message is the classic way a database password ' +
      'reaches a log. The lookarounds keep the scheme and the host out of the match, because ' +
      'which host failed is the reason the line is being read — though `user:pass@host` is ' +
      'also a valid email address, so the email rule usually overlaps this one and the merged ' +
      'span takes the host with it. Over-redacting is the direction to fail in.',
  },
];

/**
 * IPv4 addresses. **Not in the default ruleset**, and that is a decision rather
 * than an omission.
 *
 * A client IP is personal data under GDPR, so there is a real argument for
 * redacting it. It is also the field an abuse investigation, a rate-limit
 * dispute and a "which node served this" question all start from, and this
 * pipeline's own records carry the load balancer's and the task's addresses in
 * the same shape — a blanket rule redacts those too, and the result is an
 * archive nobody can correlate against a VPC flow log.
 *
 * Add it deliberately, with the retention of the scrubbed archive in front of
 * you, via `extendRuleset(DEFAULT_SCRUBBING_RULESET, { rules: [IPV4_RULE] })`.
 * See docs/log-pipeline.md §6.
 */
export const IPV4_RULE: RedactionRule = {
  id: 'ipv4',
  pattern: "(?<![\\w.])(?:(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)(?![\\w.])",
  replacement: '[REDACTED:IPV4]',
  why: 'Opt-in: personal data in one reading, and the primary correlation key in another.',
};

/**
 * Key names whose value is masked whatever it contains.
 *
 * Anchored and case-insensitive, so `ssn` matches `SSN` and `Ssn` but not
 * `lesson`. Each entry spells out its own separators rather than relying on a
 * loose `.*`, because a key rule that matches too much is invisible: the field
 * is simply always `[REDACTED:FIELD]` and nobody knows what it used to hold.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "pass(?:word|wd|phrase)",
  "secret(?:[_-]?key)?",
  "(?:api|access|private|encryption|signing)[_-]?key",
  "token|refresh[_-]?token|id[_-]?token|access[_-]?token",
  "authorization|proxy[_-]?authorization|cookie|set[_-]?cookie",
  "session[_-]?id|sid",
  "ssn|social[_-]?security(?:[_-]?number)?",
  "(?:credit[_-]?)?card[_-]?(?:number|no)|pan|cvv|cvc|card[_-]?security[_-]?code",
  "dob|date[_-]?of[_-]?birth|birth[_-]?date",
  "phone(?:[_-]?number)?|mobile(?:[_-]?number)?|telephone",
  "(?:street[_-]?|home[_-]?|postal[_-]?|billing[_-]?|shipping[_-]?)address|address[_-]?line[_-]?\\d",
  "post(?:al)?[_-]?code|zip(?:[_-]?code)?",
  "iban|bic|swift|account[_-]?number|routing[_-]?number|sort[_-]?code",
  "national[_-]?id|passport(?:[_-]?number)?|driver[_-]?licen[cs]e(?:[_-]?number)?",
  "latitude|longitude|lat|lng|geo",
];

/**
 * Key names whose value is replaced by a keyed hash rather than a mask.
 *
 * This is the difference between an archive you can debug against and one you
 * can only prove is clean: `tkn:email:9f2c…` appears identically on every
 * record for one subject, so "show me this user's last hour" still works
 * without the archive holding an address anyone can read.
 *
 * What it is not: anonymisation. The input domain of an email address or a user
 * id is small enough to enumerate, so anyone holding the hash key and a
 * candidate list can confirm a match. It is pseudonymisation — it removes the
 * value from the archive, not the subject from the record. See
 * docs/log-pipeline.md §5.
 */
export const DEFAULT_TOKENIZE_KEYS: readonly string[] = [
  'email',
  'email_address',
  'emailaddress',
  'user_email',
  'useremail',
  'user_id',
  'userid',
  'customer_id',
  'customerid',
  'subject_id',
  'username',
];

export const DEFAULT_SCRUBBING_RULESET: ScrubbingRuleset = {
  rules: DEFAULT_REDACTION_RULES,
  sensitiveKeys: DEFAULT_SENSITIVE_KEYS,
  tokenizeKeys: DEFAULT_TOKENIZE_KEYS,
  // Eight levels reaches the deepest field in a conventional structured log —
  // an error's `cause` chain nested inside a request context — and stops well
  // short of a payload shaped to exhaust the stack.
  maxDepth: 8,
  // 8 KiB is several times the longest useful message and a small fraction of
  // CloudWatch's 256 KB event limit. What lives above it is base64, a minified
  // bundle or a stack trace nobody reads to the end.
  maxScannedValueChars: 8192,
};

/* ── Extension ─────────────────────────────────────────────────────────────── */

export interface RulesetExtension {
  readonly rules?: readonly RedactionRule[];
  readonly sensitiveKeys?: readonly string[];
  readonly tokenizeKeys?: readonly string[];
  readonly maxDepth?: number;
  readonly maxScannedValueChars?: number;
}

/**
 * Add to a ruleset without restating it.
 *
 * Additive on purpose: there is no "remove a rule" helper, because the way a
 * scrubber stops scrubbing in practice is a local override that nobody reads
 * as one. Dropping a default rule means editing this file, in a diff.
 */
export const extendRuleset = (
  base: ScrubbingRuleset,
  extension: RulesetExtension,
): ScrubbingRuleset => ({
  rules: [...base.rules, ...(extension.rules ?? [])],
  sensitiveKeys: [...base.sensitiveKeys, ...(extension.sensitiveKeys ?? [])],
  tokenizeKeys: [...base.tokenizeKeys, ...(extension.tokenizeKeys ?? [])],
  maxDepth: extension.maxDepth ?? base.maxDepth,
  maxScannedValueChars: extension.maxScannedValueChars ?? base.maxScannedValueChars,
});

/* ── Validation ────────────────────────────────────────────────────────────── */

const RULE_ID = /^[a-z][a-z0-9-]*$/;
const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u']);

/** Lambda rejects a function whose environment exceeds this, in total. */
export const LAMBDA_ENVIRONMENT_BYTE_LIMIT = 4096;

const compile = (source: string, flags: string): RegExp | undefined => {
  try {
    return new RegExp(source, flags);
  } catch {
    return undefined;
  }
};

/**
 * Every problem with a ruleset, as messages. Empty means the handler can run it.
 *
 * Returns the whole list rather than throwing on the first, because these are
 * found by reading a diff and fixing one at a time is how a reviewer ends up
 * running synth six times.
 */
export const validateScrubbingRuleset = (ruleset: ScrubbingRuleset): string[] => {
  const problems: string[] = [];

  if (ruleset.rules.length === 0) {
    problems.push(
      'rules is empty: the transform would rewrite every record and remove nothing, which ' +
        'is a pipeline that reports success and scrubs nothing.',
    );
  }

  const seen = new Set<string>();
  for (const rule of ruleset.rules) {
    if (!RULE_ID.test(rule.id)) {
      problems.push(`rule id ${JSON.stringify(rule.id)} must match ${RULE_ID.source}.`);
    }
    if (seen.has(rule.id)) {
      problems.push(
        `duplicate rule id ${JSON.stringify(rule.id)}: per-rule redaction counts are keyed ` +
          'by id, so two rules sharing one make both unreadable.',
      );
    }
    seen.add(rule.id);

    const flags = rule.flags ?? '';
    for (const flag of flags) {
      if (!ALLOWED_FLAGS.has(flag)) {
        problems.push(
          `rule ${rule.id} declares flag ${JSON.stringify(flag)}. The engine adds 'g' itself; ` +
            "'g' or 'y' here gives the shared RegExp a lastIndex that survives between " +
            'records, so the same input is scrubbed on one invocation and passed through on ' +
            'the next.',
        );
      }
    }

    const compiled = compile(rule.pattern, flags);
    if (compiled === undefined) {
      problems.push(
        `rule ${rule.id} does not compile: ${JSON.stringify(rule.pattern)} with flags ` +
          `${JSON.stringify(flags)}. It would throw at cold start, every retry would fail the ` +
          'same way, and Firehose would deliver the batch to the error prefix unscrubbed.',
      );
    } else if (compiled.test('')) {
      problems.push(
        `rule ${rule.id} matches the empty string, so it matches at every position and ` +
          'rewrites every record into redaction markers.',
      );
    }

    if (!rule.replacement.includes(REDACTION_MARKER_PREFIX)) {
      problems.push(
        `rule ${rule.id} replaces with ${JSON.stringify(rule.replacement)}, which carries no ` +
          `${REDACTION_MARKER_PREFIX}…] marker. A redaction nobody can see reads exactly like ` +
          'a field that was never populated.',
      );
    }
  }

  // A replacement matched by any rule — its own or another's — cascades on the
  // next pass over a value and stops saying what was removed.
  for (const rule of ruleset.rules) {
    for (const other of ruleset.rules) {
      const compiled = compile(other.pattern, other.flags ?? '');
      if (compiled === undefined) continue;
      if (compiled.test(rule.replacement)) {
        problems.push(
          `rule ${rule.id}'s replacement ${JSON.stringify(rule.replacement)} is matched by rule ` +
            `${other.id}, so the marker would itself be redacted.`,
        );
      }
    }
  }

  for (const key of ruleset.sensitiveKeys) {
    const compiled = compile(`^(?:${key})$`, 'i');
    if (compiled === undefined) {
      problems.push(`sensitive key pattern ${JSON.stringify(key)} does not compile.`);
      continue;
    }
    if (compiled.test('')) {
      problems.push(
        `sensitive key pattern ${JSON.stringify(key)} matches the empty key name, so every ` +
          'unnamed field is masked.',
      );
    }
  }

  const tokenized = new Set<string>();
  for (const key of ruleset.tokenizeKeys) {
    const lower = key.toLowerCase();
    if (tokenized.has(lower)) {
      problems.push(`duplicate tokenised key ${JSON.stringify(key)}.`);
    }
    tokenized.add(lower);

    for (const pattern of ruleset.sensitiveKeys) {
      const compiled = compile(`^(?:${pattern})$`, 'i');
      if (compiled?.test(lower) === true) {
        problems.push(
          `key ${JSON.stringify(key)} is both tokenised and matched by the sensitive-key ` +
            `pattern ${JSON.stringify(pattern)}. Masking runs first, so the value would be ` +
            'masked and the correlation the token exists for would silently stop working.',
        );
      }
    }
  }

  if (!Number.isInteger(ruleset.maxDepth) || ruleset.maxDepth < 1 || ruleset.maxDepth > 32) {
    problems.push(
      `maxDepth is ${ruleset.maxDepth}: it must be an integer in 1..32. Below 1 nothing is ` +
        'walked; above 32 a nested payload can exhaust the stack, and a transform that ' +
        'throws delivers the batch raw.',
    );
  }

  if (
    !Number.isInteger(ruleset.maxScannedValueChars) ||
    ruleset.maxScannedValueChars < 256 ||
    ruleset.maxScannedValueChars > 262144
  ) {
    problems.push(
      `maxScannedValueChars is ${ruleset.maxScannedValueChars}: it must be an integer in ` +
        '256..262144. CloudWatch Logs caps one event at 256 KB, and a bound below 256 ' +
        'characters truncates ordinary messages into uselessness.',
    );
  }

  return problems;
};

/** {@link validateScrubbingRuleset}, as a synth-time failure. */
export const assertValidScrubbingRuleset = (ruleset: ScrubbingRuleset): void => {
  const problems = validateScrubbingRuleset(ruleset);
  if (problems.length > 0) {
    throw new Error(
      `Invalid log-scrubbing ruleset:\n  - ${problems.join('\n  - ')}\n` +
        'See docs/log-pipeline.md §3.',
    );
  }
};

/* ── Shipping it to the function ───────────────────────────────────────────── */

/** The ruleset as the handler receives it — no prose, because bytes are scarce. */
export interface SerializedRuleset {
  readonly rules: readonly {
    readonly id: string;
    readonly pattern: string;
    readonly flags?: string;
    readonly replacement: string;
    readonly requires?: 'luhn';
  }[];
  readonly sensitiveKeys: readonly string[];
  readonly tokenizeKeys: readonly string[];
  readonly maxDepth: number;
  readonly maxScannedValueChars: number;
}

/**
 * The ruleset as a compact JSON string for the function's environment.
 *
 * `why` is dropped here: it is the field that makes the ruleset reviewable and
 * the field the handler never reads, and the environment it would be spent
 * from is 4 KB for the whole function.
 */
export const serializeRuleset = (ruleset: ScrubbingRuleset): string => {
  const serialized: SerializedRuleset = {
    rules: ruleset.rules.map((rule) => ({
      id: rule.id,
      pattern: rule.pattern,
      ...(rule.flags === undefined ? {} : { flags: rule.flags }),
      replacement: rule.replacement,
      ...(rule.requires === undefined ? {} : { requires: rule.requires }),
    })),
    sensitiveKeys: [...ruleset.sensitiveKeys],
    tokenizeKeys: ruleset.tokenizeKeys.map((key) => key.toLowerCase()),
    maxDepth: ruleset.maxDepth,
    maxScannedValueChars: ruleset.maxScannedValueChars,
  };
  return JSON.stringify(serialized);
};

/** Total bytes an environment map costs against Lambda's 4 KB limit. */
export const environmentByteSize = (environment: Record<string, string>): number =>
  Object.entries(environment).reduce(
    (total, [key, value]) =>
      total + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8'),
    0,
  );

/**
 * Refuse an environment Lambda would refuse.
 *
 * The limit is on the *total* size of the environment, counted over keys and
 * values together, and the API rejects the function on create and update —
 * which is a failed stack update at the end of a deployment pipeline, reported
 * as `InvalidParameterValueException`, on a change whose diff was a regex.
 * Adding rules is the thing that grows it, and this is the only place that
 * relationship is visible.
 */
export const assertEnvironmentFitsLambdaLimit = (
  environment: Record<string, string>,
  context: string,
): void => {
  const size = environmentByteSize(environment);
  if (size <= LAMBDA_ENVIRONMENT_BYTE_LIMIT) return;

  const largest = Object.entries(environment)
    .map(([key, value]) => ({ key, bytes: Buffer.byteLength(value, 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes)[0];

  throw new Error(
    `${context}: the Lambda environment is ${size} bytes, above the ${LAMBDA_ENVIRONMENT_BYTE_LIMIT}-byte ` +
      `limit Lambda enforces on create and update. Largest entry: ${largest.key} ` +
      `(${largest.bytes} bytes). Shorten the ruleset's patterns or drop a rule — see ` +
      'docs/log-pipeline.md §3.',
  );
};
