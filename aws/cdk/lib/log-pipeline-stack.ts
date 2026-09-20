import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as logs_destinations from 'aws-cdk-lib/aws-logs-destinations';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';
import {
  DEFAULT_SCRUBBING_RULESET,
  ScrubbingRuleset,
  assertEnvironmentFitsLambdaLimit,
  assertValidScrubbingRuleset,
  serializeRuleset,
} from './log-scrubbing';

/**
 * Namespace the scrubber publishes its own counters under.
 *
 * Counters only — the handler never publishes, logs or returns any part of a
 * record's content. Its own log group is the one log group in the account that
 * the pipeline cannot scrub, because it is written after the scrub, so the rule
 * it holds itself to is that nothing from a record reaches it. See
 * `test/log-scrubber-handler.test.ts`, which asserts exactly that.
 */
export const LOG_PIPELINE_METRIC_NAMESPACE = 'LogPipeline';

/** Metric names the scrubber publishes as EMF. */
export const LOG_PIPELINE_METRICS = {
  /** Firehose records the transform accepted and returned scrubbed. */
  recordsProcessed: 'RecordsProcessed',
  /** Records returned `Dropped` for any reason. Data loss, never a leak. */
  recordsDropped: 'RecordsDropped',
  /** Individual log events rewritten. */
  eventsScrubbed: 'EventsScrubbed',
  /** Spans replaced by a redaction marker, across every rule. */
  redactionsApplied: 'RedactionsApplied',
  /** Values replaced by a keyed hash. */
  tokensIssued: 'TokensIssued',
  /** Values that would have been tokenised but were masked instead. */
  tokenizationUnavailable: 'TokenizationUnavailable',
  /** String values cut at `maxScannedValueChars`. */
  valuesTruncated: 'ValuesTruncated',
  /** Subtrees replaced because they were deeper than `maxDepth`. */
  subtreesClipped: 'SubtreesClipped',
  /** Records dropped because the transform's response budget was exhausted. */
  oversizeRecordsDropped: 'OversizeRecordsDropped',
  /** Records dropped because they did not decode or parse. */
  unreadableRecordsDropped: 'UnreadableRecordsDropped',
  /**
   * Subscription health checks dropped.
   *
   * Counted apart from `RecordsDropped` because CloudWatch Logs sends one down
   * every new subscription: folding them in would put a permanent floor under
   * the drop alarm, and a floor under an alarm is how it gets raised until it
   * never fires.
   */
  controlMessagesDropped: 'ControlMessagesDropped',
} as const;

/**
 * The Firehose transform, verbatim as Lambda runs it.
 *
 * Shipped with `lambda.Code.fromInline`, so `tsc` sees a string and `cdk synth`
 * embeds it unchanged — nothing in the build parses it. It is compiled and run
 * against recorded events by `test/log-scrubber-handler.test.ts` instead.
 *
 * ## The one decision everything else follows from
 *
 * Firehose's transform contract has three outcomes per record, and only two of
 * them are safe here:
 *
 *   • `Ok` — the record, transformed, is delivered to S3.
 *   • `Dropped` — the record is discarded. Data loss, nothing written.
 *   • `ProcessingFailed` — Firehose retries, and after the retries it writes
 *     **the original, untransformed record** to the error output prefix.
 *
 * `ProcessingFailed` is what every transform blueprint returns for a record it
 * could not handle, and in a scrubbing pipeline it is the leak: the record that
 * defeated the scrubber is the one that lands in S3 unscrubbed. So this handler
 * never returns it. A record it cannot decode, cannot parse, or cannot fit in
 * the response is `Dropped`, counted, and alarmed on. Losing a log line is
 * recoverable — the source group still holds it for the transit window. Writing
 * it unscrubbed is not.
 *
 * That leaves Firehose's own `ExecuteProcessingFailure` — an invocation that
 * throws, times out, or is throttled — as the only remaining path to the error
 * prefix, which is why the quarantine prefix is treated as sensitive data and
 * alarmed on rather than assumed empty. See docs/log-pipeline.md §4.
 *
 * ## The rest of the contract, which is easy to get wrong quietly
 *
 *   • Input is base64, and for a CloudWatch Logs subscription it is **gzipped**
 *     JSON holding many events. Output must be base64 too.
 *   • Firehose writes records to S3 back to back and **adds no separator**. A
 *     transform that returns bare JSON produces objects that are one
 *     unparseable line, which Athena reports as zero rows rather than as an
 *     error. Every emitted line ends with a newline.
 *   • The response is capped at 6 MB. Gzipped input expands, so a full input
 *     batch can exceed it after decompression; the budget is tracked in
 *     base64 bytes, and records that no longer fit are dropped rather than
 *     failed.
 *   • `CONTROL_MESSAGE` records are CloudWatch's subscription health checks and
 *     carry no log events. They are dropped, not forwarded.
 */
export const LOG_SCRUBBER_SOURCE = `
'use strict';

const zlib = require('zlib');
const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const RULESET = JSON.parse(process.env.SCRUBBING_RULESET);
const NAMESPACE = process.env.METRIC_NAMESPACE;
const ENV_NAME = process.env.ENV_NAME;
const PIPELINE = process.env.PIPELINE_NAME;
const HASH_SECRET_ARN = process.env.HASH_SECRET_ARN;
const RESPONSE_BUDGET_BYTES = Number(process.env.RESPONSE_BUDGET_BYTES);

const TOKEN_PREFIX = 'tkn:';
const MARKER_PREFIX = '[REDACTED:';
const FIELD_MARKER = '[REDACTED:FIELD]';
const DEPTH_MARKER = '[REDACTED:DEPTH-LIMIT]';
const OVERLAP_MARKER = '[REDACTED:OVERLAPPING]';
const TRUNCATION_MARKER = '[TRUNCATED]';

// Compiled once per container. 'g' is added here and refused in the ruleset, so
// exactly one copy of each pattern carries a lastIndex and this file is the only
// place that resets it.
const RULES = RULESET.rules.map(function (rule) {
  return {
    id: rule.id,
    matcher: new RegExp(rule.pattern, (rule.flags || '') + 'g'),
    replacement: rule.replacement,
    requires: rule.requires,
  };
});

const SENSITIVE_KEY = RULESET.sensitiveKeys.length
  ? new RegExp('^(?:' + RULESET.sensitiveKeys.map(function (p) { return '(?:' + p + ')'; }).join('|') + ')$', 'i')
  : null;
const TOKENIZE_KEYS = new Set(RULESET.tokenizeKeys);

/**
 * Luhn check digit. A filter on the card rule, not a proof: it removes the
 * order ids and trace ids a 13-to-19-digit pattern otherwise eats.
 */
function passesLuhn(text) {
  const digits = text.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Apply every rule to the original string and rewrite once.
 *
 * Rules never see each other's output, so the result does not depend on rule
 * order. Overlapping matches are *merged* rather than resolved by precedence:
 * taking the first and skipping the second would leave the part of the second
 * that extends past the first in the line, which is the half nobody notices.
 *
 * A span wholly inside another keeps the outer rule's marker — an Authorization
 * header whose value happens to be a JWT is still an Authorization header. Only
 * a partial overlap, where neither rule covers the whole region, becomes
 * OVERLAPPING: there is no honest single label for it, and the alternative is
 * choosing one rule's marker for a span it does not describe.
 */
function scrubText(text, stats) {
  const spans = [];
  for (const rule of RULES) {
    rule.matcher.lastIndex = 0;
    let match = rule.matcher.exec(text);
    while (match !== null) {
      if (match[0].length === 0) {
        // Refused by the ruleset validator; guarded here so a hand-edited
        // environment variable cannot spin the loop forever.
        rule.matcher.lastIndex += 1;
      } else if (rule.requires !== 'luhn' || passesLuhn(match[0])) {
        spans.push({ start: match.index, end: match.index + match[0].length, rule: rule.id, replacement: rule.replacement });
      }
      match = rule.matcher.exec(text);
    }
  }
  if (spans.length === 0) return text;

  spans.sort(function (a, b) { return a.start - b.start || a.end - b.end; });

  const merged = [];
  for (const span of spans) {
    const last = merged.length > 0 ? merged[merged.length - 1] : null;
    if (last !== null && span.start <= last.end) {
      const contained = span.end <= last.end;
      last.end = Math.max(last.end, span.end);
      last.rules.push(span.rule);
      if (!contained && span.replacement !== last.replacement) last.replacement = OVERLAP_MARKER;
    } else {
      merged.push({ start: span.start, end: span.end, rules: [span.rule], replacement: span.replacement });
    }
  }

  let out = '';
  let cursor = 0;
  for (const region of merged) {
    out += text.slice(cursor, region.start) + region.replacement;
    cursor = region.end;
    stats.redactions += 1;
    for (const id of region.rules) {
      stats.byRule[id] = (stats.byRule[id] || 0) + 1;
    }
  }
  return out + text.slice(cursor);
}

function scrubString(value, stats) {
  let text = value;
  if (text.length > RULESET.maxScannedValueChars) {
    text = text.slice(0, RULESET.maxScannedValueChars) + TRUNCATION_MARKER;
    stats.truncated += 1;
  }
  return scrubText(text, stats);
}

/** Keyed hash, or undefined when the key could not be read. */
let hashKeyPromise = null;

async function hashKey() {
  if (HASH_SECRET_ARN === undefined || HASH_SECRET_ARN === '') return undefined;
  if (hashKeyPromise === null) {
    const client = new SecretsManagerClient({});
    hashKeyPromise = client
      .send(new GetSecretValueCommand({ SecretId: HASH_SECRET_ARN }))
      .then(function (response) {
        const raw = response.SecretString;
        if (typeof raw !== 'string' || raw.length === 0) throw new Error('empty secret');
        try {
          const parsed = JSON.parse(raw);
          return typeof parsed.key === 'string' ? parsed.key : raw;
        } catch (error) {
          return raw;
        }
      });
  }
  try {
    return await hashKeyPromise;
  } catch (error) {
    // Retried on the next invocation rather than cached as a failure: a
    // throttled GetSecretValue would otherwise disable tokenisation for the
    // life of the container.
    hashKeyPromise = null;
    return undefined;
  }
}

/**
 * Tokenise a value so records about one subject still correlate.
 *
 * Normalised before hashing, because 'A@Example.com' and 'a@example.com' are
 * one subject and two tokens would be a join that silently returns half the
 * rows. Values already carrying the token prefix are returned unchanged, which
 * is what makes a second pass over already-scrubbed data idempotent.
 */
function tokenize(value, key, secret, stats) {
  if (typeof value === 'string' && value.startsWith(TOKEN_PREFIX)) return value;
  if (typeof value !== 'string' && typeof value !== 'number') {
    stats.masked += 1;
    return FIELD_MARKER;
  }
  if (secret === undefined) {
    // Fail safe rather than fail open: an unreadable hash key means the value
    // is masked, not passed through.
    stats.tokenizationUnavailable += 1;
    return FIELD_MARKER;
  }
  const normalized = String(value).trim().toLowerCase();
  const digest = crypto.createHmac('sha256', secret).update(key + ':' + normalized).digest('hex');
  stats.tokens += 1;
  return TOKEN_PREFIX + key + ':' + digest.slice(0, 32);
}

function walk(node, depth, secret, stats) {
  if (depth > RULESET.maxDepth) {
    stats.clipped += 1;
    return DEPTH_MARKER;
  }
  if (Array.isArray(node)) {
    return node.map(function (item) { return walk(item, depth + 1, secret, stats); });
  }
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const key of Object.keys(node)) {
      const value = node[key];
      const lower = key.toLowerCase();
      if (SENSITIVE_KEY !== null && SENSITIVE_KEY.test(key)) {
        // Masked whatever the type: an object under a key called 'password' is
        // not safer than a string under it, and walking into it would emit
        // whatever it holds under key names nobody has seen.
        if (typeof value === 'string' && (value.startsWith(MARKER_PREFIX) || value.startsWith(TOKEN_PREFIX))) {
          out[key] = value;
        } else {
          stats.masked += 1;
          out[key] = FIELD_MARKER;
        }
        continue;
      }
      if (TOKENIZE_KEYS.has(lower)) {
        out[key] = tokenize(value, lower, secret, stats);
        continue;
      }
      out[key] = walk(value, depth + 1, secret, stats);
    }
    return out;
  }
  if (typeof node === 'string') return scrubString(node, stats);
  if (typeof node === 'number' && Number.isFinite(node)) {
    // A card number written as a JSON number is still a card number. Only long
    // runs are worth stringifying — everything else is a duration or a count.
    const text = String(node);
    if (/[0-9]{13,}/.test(text)) {
      const scrubbed = scrubText(text, stats);
      if (scrubbed !== text) return scrubbed;
    }
    return node;
  }
  return node;
}

/**
 * One log event becomes one line.
 *
 * Envelope fields carry an '@' prefix — CloudWatch's own convention for
 * generated fields — so an application field called 'timestamp' or 'id' cannot
 * collide with the envelope and silently overwrite where the record came from.
 */
function renderEvent(envelope, event, secret, stats) {
  const line = {
    '@timestamp': new Date(event.timestamp).toISOString(),
    '@id': event.id,
    '@logGroup': envelope.logGroup,
    '@logStream': envelope.logStream,
    '@owner': envelope.owner,
  };

  let parsed;
  try {
    parsed = JSON.parse(event.message);
  } catch (error) {
    parsed = undefined;
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const scrubbed = walk(parsed, 1, secret, stats);
    for (const key of Object.keys(scrubbed)) {
      if (key.charAt(0) === '@') continue;
      line[key] = scrubbed[key];
    }
  } else {
    line.message = scrubString(typeof event.message === 'string' ? event.message : String(event.message), stats);
  }

  stats.events += 1;
  return JSON.stringify(line);
}

function emitMetrics(stats) {
  const metrics = Object.keys(stats.counters).map(function (name) {
    return { Name: name, Unit: 'Count' };
  });
  const payload = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [['Environment', 'Pipeline']],
          Metrics: metrics,
        },
      ],
    },
    Environment: ENV_NAME,
    Pipeline: PIPELINE,
    // Per-rule counts are properties rather than metrics on purpose: a metric
    // per rule multiplies the dimension set by the size of the ruleset, and the
    // question they answer — "which rule is firing on everything?" — is asked
    // from Logs Insights, not from an alarm.
    redactionsByRule: stats.byRule,
  };
  for (const name of Object.keys(stats.counters)) {
    payload[name] = stats.counters[name];
  }
  console.log(JSON.stringify(payload));
}

exports.handler = async function handler(event) {
  const secret = await hashKey();
  const stats = {
    events: 0,
    redactions: 0,
    masked: 0,
    tokens: 0,
    tokenizationUnavailable: 0,
    truncated: 0,
    clipped: 0,
    byRule: {},
    counters: {},
  };

  let processed = 0;
  let dropped = 0;
  let unreadable = 0;
  let oversize = 0;
  let controlMessages = 0;
  let budget = RESPONSE_BUDGET_BYTES;

  const records = [];
  for (const record of event.records || []) {
    let envelope;
    try {
      const raw = Buffer.from(record.data, 'base64');
      const isGzip = raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b;
      envelope = JSON.parse((isGzip ? zlib.gunzipSync(raw) : raw).toString('utf8'));
    } catch (error) {
      // Never ProcessingFailed: that hands the bytes we could not read to the
      // error prefix, unscrubbed, which is the outcome this pipeline exists to
      // prevent.
      unreadable += 1;
      dropped += 1;
      records.push({ recordId: record.recordId, result: 'Dropped' });
      continue;
    }

    if (envelope === null || typeof envelope !== 'object') {
      unreadable += 1;
      dropped += 1;
      records.push({ recordId: record.recordId, result: 'Dropped' });
      continue;
    }

    if (envelope.messageType === 'CONTROL_MESSAGE') {
      controlMessages += 1;
      records.push({ recordId: record.recordId, result: 'Dropped' });
      continue;
    }

    let lines;
    if (Array.isArray(envelope.logEvents)) {
      lines = envelope.logEvents.map(function (logEvent) {
        return renderEvent(envelope, logEvent, secret, stats);
      });
    } else {
      // Not a subscription envelope — a direct PutRecord from some other
      // producer. Scrubbed as one structured line rather than trusted.
      lines = [JSON.stringify(walk(envelope, 1, secret, stats))];
      stats.events += 1;
    }

    const encoded = Buffer.from(lines.join('\\n') + '\\n', 'utf8').toString('base64');
    if (encoded.length > budget) {
      // Firehose caps the response at 6 MB and gzipped input expands past it.
      // Dropping loses the record; ProcessingFailed would deliver it raw.
      oversize += 1;
      dropped += 1;
      records.push({ recordId: record.recordId, result: 'Dropped' });
      continue;
    }
    budget -= encoded.length;
    processed += 1;
    records.push({ recordId: record.recordId, result: 'Ok', data: encoded });
  }

  stats.counters.RecordsProcessed = processed;
  stats.counters.RecordsDropped = dropped;
  stats.counters.EventsScrubbed = stats.events;
  stats.counters.RedactionsApplied = stats.redactions + stats.masked;
  stats.counters.TokensIssued = stats.tokens;
  stats.counters.TokenizationUnavailable = stats.tokenizationUnavailable;
  stats.counters.ValuesTruncated = stats.truncated;
  stats.counters.SubtreesClipped = stats.clipped;
  stats.counters.OversizeRecordsDropped = oversize;
  stats.counters.UnreadableRecordsDropped = unreadable;
  stats.counters.ControlMessagesDropped = controlMessages;
  emitMetrics(stats);

  return { records: records };
};
`;

/* ── Stack ─────────────────────────────────────────────────────────────────── */

export interface LogPipelineStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging. */
  readonly envName: string;
  /**
   * Log groups whose events are forwarded, scrubbed and archived.
   *
   * Imported by name rather than created here: the application's group is made
   * by the `awslogs` driver the first time a task starts, and a second
   * declaration of it would either fail the deploy or take ownership of
   * somebody else's resource.
   *
   * CloudWatch Logs allows **two** subscription filters per log group. A group
   * already feeding an OpenSearch or a vendor subscription has one slot left,
   * and the third filter fails the stack update rather than the log group.
   */
  readonly sourceLogGroupNames: readonly string[];
  /** Redaction rules (default: {@link DEFAULT_SCRUBBING_RULESET}). */
  readonly ruleset?: ScrubbingRuleset;
  /**
   * How long the scrubbed archive is kept (default: 400 days).
   *
   * The archive is the long-lived copy, which is why the transit log groups can
   * expire in days. 400 rather than 365: a year-on-year comparison needs the
   * same week of the previous year to still exist.
   */
  readonly archiveRetentionDays?: number;
  /**
   * How long the quarantine prefix is kept (default: 7 days).
   *
   * Short on purpose. Firehose writes **unscrubbed** records there when the
   * transform cannot run at all, so it is the one prefix in this bucket that
   * holds what the pipeline exists to remove, and every day it is kept is a day
   * that data is retained. Seven is long enough to notice the alarm on a Friday
   * and drain it on Monday.
   */
  readonly quarantineRetentionDays?: number;
  /**
   * Principals allowed to read the quarantine prefix (role ARNs).
   *
   * Empty — the default — denies every principal, including this account's
   * administrators, and an incident that needs those records starts by editing
   * this list in a pull request. That is the intended friction: the alternative
   * is a prefix of raw records readable by whoever can already read the
   * scrubbed archive, which is the audience the scrubbing is for.
   */
  readonly quarantineReaderRoleArns?: readonly string[];
  /** Buffering hint before Firehose writes an object (default: 60 seconds). */
  readonly bufferingIntervalSeconds?: number;
  /** Buffering hint in MiB before Firehose writes an object (default: 5). */
  readonly bufferingSizeMib?: number;
  /**
   * Input buffered per transform invocation, in MB (default: 0.2).
   *
   * The smallest value Firehose accepts, and the value its own CloudWatch Logs
   * blueprint recommends, because this bound is on **compressed** input while
   * the 6 MB response limit is on expanded output: structured logs gzip at
   * better than 10:1, so a 1 MB buffer can decompress past the response the
   * transform is allowed to return. This pipeline drops what does not fit
   * rather than delivering it raw, so the buffer size is the difference between
   * a complete archive and a lossy one.
   */
  readonly processorBufferSizeMb?: number;
  /** Transform invocation timeout (default: 60 seconds; Firehose gives up at 300). */
  readonly transformTimeoutSeconds?: number;
  /** Concurrent transform invocations the function may hold (default: 20). */
  readonly transformConcurrency?: number;
  /**
   * Bytes of base64 output the transform may return per invocation
   * (default: 5 MiB).
   *
   * Under Firehose's 6 MB response limit with room for the envelope. Records
   * that no longer fit are dropped and counted.
   */
  readonly responseBudgetBytes?: number;
  /** Retention of the scrubber's own log group and the delivery error log group. */
  readonly operationalLogRetention?: logs.RetentionDays;
  /**
   * Create the account-wide CloudWatch Logs data protection policy
   * (default: false).
   *
   * Account-scoped and region-scoped, so **exactly one stack per account may
   * own it**: two stacks creating one with the same name fight over it on every
   * deploy, and two with different names both apply, doubling the audit
   * findings and the cost. Enable it in one environment — see `bin/app.ts`.
   */
  readonly manageAccountDataProtectionPolicy?: boolean;
  /** Email addresses subscribed to the pipeline's alarm topic. */
  readonly alarmEmails?: readonly string[];
}

/**
 * A structured log pipeline that scrubs PII before anything durable ingests it.
 *
 * ## What "before ingest" means here, precisely
 *
 * There are two stores, and a design that only addresses one of them reads as
 * complete:
 *
 *   • **CloudWatch Logs**, which the `awslogs` driver writes to as the
 *     container emits. Nothing can scrub before that — the write *is* the
 *     ingest — so the control there is a data protection policy, which masks
 *     matches at ingest for every reader without `logs:Unmask` and records a
 *     finding. The stored bytes are unchanged: masking is an access control
 *     over data the account still holds, not a deletion. What makes it
 *     tolerable is the second half of the design — those groups expire in
 *     weeks rather than years, because they are transit, not the archive.
 *
 *   • **The S3 archive**, which is the copy that is kept, queried by Athena,
 *     and read by whoever is given the bucket. Nothing lands there until the
 *     transform has run, so this is where scrubbing is real: the record is
 *     rewritten before it is written, and what is written is line-delimited
 *     JSON with masked fields, tokenised identifiers, and no path by which an
 *     unscrubbed record can arrive except Firehose's own error prefix.
 *
 * The pipeline is therefore: application → CloudWatch Logs (masked at ingest,
 * short retention) → subscription filter → Firehose → Lambda transform
 * (scrub) → S3, with a quarantine prefix that is alarmed on, expires in a week,
 * and is unreadable by default.
 *
 * ## What is deliberately not here
 *
 *   • **Re-ingestion of oversize batches.** AWS's blueprint re-ingests records
 *     that no longer fit the transform's response; this drops and alarms
 *     instead. Re-ingestion needs `PutRecordBatch` on the stream the function
 *     is a transform of — a cycle in CloudFormation and a loop in production if
 *     the second pass is not idempotent — and the 0.2 MB processor buffer makes
 *     the case rare. `OversizeRecordsDropped` is the signal that the trade was
 *     wrong for your traffic.
 *
 *   • **Object Lock on the archive.** A WORM archive is the right answer for a
 *     compliance log and the wrong one for a boilerplate: it cannot be turned
 *     off, and it makes a non-production `cdk destroy` fail rather than
 *     succeed. See docs/log-pipeline.md §8.
 */
export class LogPipelineStack extends cdk.Stack {
  public readonly archiveBucket: s3.Bucket;
  public readonly deliveryStream: firehose.DeliveryStream;
  public readonly scrubber: lambda.Function;
  public readonly hashSecret: secretsmanager.Secret;
  public readonly encryptionKey: kms.Key;
  public readonly alarmTopic: sns.Topic;
  public readonly alarms: readonly cloudwatch.Alarm[];
  /** Prefix under which scrubbed records are written. */
  public readonly archivePrefix = 'scrubbed/';
  /** Prefix Firehose writes records to when the transform could not run. */
  public readonly quarantinePrefix = 'quarantine/';

  constructor(scope: Construct, id: string, props: LogPipelineStackProps) {
    super(scope, id, props);

    const envName = props.envName;
    const ruleset = props.ruleset ?? DEFAULT_SCRUBBING_RULESET;
    const archiveRetentionDays = props.archiveRetentionDays ?? 400;
    const quarantineRetentionDays = props.quarantineRetentionDays ?? 7;
    const bufferingIntervalSeconds = props.bufferingIntervalSeconds ?? 60;
    const bufferingSizeMib = props.bufferingSizeMib ?? 5;
    const processorBufferSizeMb = props.processorBufferSizeMb ?? 0.2;
    const transformTimeoutSeconds = props.transformTimeoutSeconds ?? 60;
    const transformConcurrency = props.transformConcurrency ?? 20;
    const responseBudgetBytes = props.responseBudgetBytes ?? 5 * 1024 * 1024;
    const operationalLogRetention = props.operationalLogRetention ?? logs.RetentionDays.ONE_MONTH;
    const isProduction = envName === 'production';

    // Synth-time, so a pattern that would throw at cold start — and deliver the
    // batch raw — is a failed build instead.
    assertValidScrubbingRuleset(ruleset);

    if (props.sourceLogGroupNames.length === 0) {
      throw new Error(
        `${id}: sourceLogGroupNames is empty, so the pipeline would deploy with nothing ` +
          'subscribed to it — an archive that stays empty and a set of alarms that stay green.',
      );
    }

    if (transformTimeoutSeconds < 30 || transformTimeoutSeconds > 300) {
      throw new Error(
        `${id}: transformTimeoutSeconds is ${transformTimeoutSeconds}. Firehose abandons a ` +
          'transform invocation at 300 seconds and delivers the batch to the error prefix ' +
          'unscrubbed, so a longer Lambda timeout cannot help; below 30 the function is being ' +
          'cut off while it still had work to do, with the same result.',
      );
    }

    if (processorBufferSizeMb < 0.2 || processorBufferSizeMb > 3) {
      throw new Error(
        `${id}: processorBufferSizeMb is ${processorBufferSizeMb}; Firehose accepts 0.2 to 3.`,
      );
    }

    const deliveryStreamName = `${envName}-log-pipeline`;
    const scrubberName = `${envName}-log-scrubber`;
    const scrubberLogGroupName = `/aws/lambda/${scrubberName}`;
    const deliveryLogGroupName = `/aws/kinesisfirehose/${deliveryStreamName}`;
    const auditLogGroupName = `/aws/logs/${envName}-data-protection-audit`;

    // ── Encryption ────────────────────────────────────────────────────────────
    // One key for the archive, the stream, the function's environment and the
    // operational log groups. A single key rather than four because they hold
    // one dataset at different stages, and the grant that matters — who can
    // read the archive — is then one key policy to review rather than four.
    this.encryptionKey = new kms.Key(this, 'PipelineKey', {
      alias: `alias/${envName}-log-pipeline`,
      description: `Encrypts the ${envName} scrubbed log archive, its delivery stream and the scrubber's configuration`,
      enableKeyRotation: true,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    // CloudWatch Logs encrypts with a key it can use, and `LogGroup`'s
    // `encryptionKey` prop does not add this: without it the log group fails to
    // create with `InvalidParameterException`, at deploy time. The condition is
    // what keeps the grant from being "this service, for anything in the
    // account" — it holds the key to log groups in this account and region.
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudWatchLogs',
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt*',
          'kms:Decrypt*',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:Describe*',
        ],
        resources: ['*'],
        conditions: {
          ArnLike: {
            'kms:EncryptionContext:aws:logs:arn': `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`,
          },
        },
      }),
    );

    // ── Archive ───────────────────────────────────────────────────────────────
    // Reads of the archive are themselves recorded. This bucket holds logs
    // about people's requests; who read it, and when, is the question an access
    // review asks, and S3 server access logs are the only record of it — a
    // CloudTrail data event on S3 is off by default and billed per event.
    //
    // A separate bucket because a bucket logging to itself records the writes it
    // is making, which grows without bound. That makes this one the end of the
    // chain: nothing logs its reads, and the skip below says so rather than
    // leaving the finding to a baseline file.
    const accessLogBucket = new s3.Bucket(this, 'ArchiveAccessLogBucket', {
      bucketName: `${envName}-log-archive-access-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // S3-managed rather than the pipeline key: the log delivery service
      // writes these objects, and a KMS-encrypted destination adds a grant to
      // the key that exists only so a service can write records nobody reads
      // day to day.
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      // Versioned because this is the record of who read an archive of people's
      // data: a delete then leaves a delete marker somebody can find rather
      // than a gap nobody can date.
      versioned: true,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
      lifecycleRules: [
        {
          id: 'expire-access-logs',
          enabled: true,
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    (accessLogBucket.node.defaultChild as s3.CfnBucket).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_18',
          comment:
            'This is the access-log bucket. Pointing its own access logs at itself makes every ' +
            'write produce a record of that write; pointing them at a third bucket moves the ' +
            'same question one bucket further along. The chain terminates here deliberately.',
        },
      ],
    });

    this.archiveBucket = new s3.Bucket(this, 'ArchiveBucket', {
      serverAccessLogsBucket: accessLogBucket,
      serverAccessLogsPrefix: 'archive-access/',
      bucketName: `${envName}-log-archive-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true,
      enforceSSL: true,
      versioned: true,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProduction,
      lifecycleRules: [
        {
          id: 'tier-and-expire-scrubbed',
          enabled: true,
          prefix: this.archivePrefix,
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL, transitionAfter: cdk.Duration.days(90) },
          ],
          expiration: cdk.Duration.days(archiveRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
        {
          // The prefix holding records the transform never saw. Expiring it is
          // the only thing that bounds how long unscrubbed data lives here.
          id: 'expire-quarantine',
          enabled: true,
          prefix: this.quarantinePrefix,
          expiration: cdk.Duration.days(quarantineRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
        {
          id: 'abort-incomplete-uploads',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
    });

    // Reads of the quarantine prefix are denied to everyone the stack does not
    // name. A Deny beats any Allow, including an administrator's, which is the
    // point: the records under this prefix are the ones that reached S3 without
    // being scrubbed, and "the archive is safe to hand out" has to stay true of
    // the bucket rather than of a prefix convention nobody enforces.
    const quarantineReaders = props.quarantineReaderRoleArns ?? [];
    this.archiveBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'RestrictQuarantineReads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [this.archiveBucket.arnForObjects(`${this.quarantinePrefix}*`)],
        ...(quarantineReaders.length > 0
          ? { conditions: { StringNotLike: { 'aws:PrincipalArn': [...quarantineReaders] } } }
          : {}),
      }),
    );

    // ── Tokenisation key ──────────────────────────────────────────────────────
    // Generated by Secrets Manager rather than passed in, so no value of it ever
    // exists in this repository, in the template, or in a CI variable.
    //
    // Rotating it re-keys every future token, so records either side of a
    // rotation no longer correlate. That is a deliberate non-rotation: the value
    // is a correlation key, not a credential — it grants nothing — and the cost
    // of rotating it is a seam in the archive. See docs/log-pipeline.md §5.
    this.hashSecret = new secretsmanager.Secret(this, 'TokenizationKey', {
      secretName: `${envName}/log-pipeline/tokenization-key`,
      description: `HMAC key that pseudonymises identifiers in ${envName} logs. Rotating it breaks correlation across the rotation.`,
      encryptionKey: this.encryptionKey,
      removalPolicy: isProduction ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ version: 1 }),
        generateStringKey: 'key',
        passwordLength: 64,
        excludePunctuation: true,
      },
    });

    // ── Transform ─────────────────────────────────────────────────────────────
    const scrubberLogGroup = new logs.LogGroup(this, 'ScrubberLogGroup', {
      logGroupName: scrubberLogGroupName,
      retention: operationalLogRetention,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const scrubberRole = new iam.Role(this, 'ScrubberRole', {
      roleName: `${envName}-log-scrubber-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Scrubs PII from ${envName} log records in flight to the archive`,
    });
    scrubberRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    );
    scrubberRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ReadTokenizationKey',
        actions: ['secretsmanager:GetSecretValue'],
        resources: [this.hashSecret.secretArn],
      }),
    );
    // Decrypting the secret, and the function's own environment, under the
    // pipeline key. Scoped to the one key; `kms:Decrypt` on `"*"` would be
    // every encrypted thing in the account.
    this.encryptionKey.grantDecrypt(scrubberRole);

    const scrubberEnvironment: Record<string, string> = {
      SCRUBBING_RULESET: serializeRuleset(ruleset),
      METRIC_NAMESPACE: LOG_PIPELINE_METRIC_NAMESPACE,
      ENV_NAME: envName,
      PIPELINE_NAME: deliveryStreamName,
      HASH_SECRET_ARN: this.hashSecret.secretArn,
      RESPONSE_BUDGET_BYTES: String(responseBudgetBytes),
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };
    assertEnvironmentFitsLambdaLimit(scrubberEnvironment, `${id} scrubber`);

    this.scrubber = new lambda.Function(this, 'Scrubber', {
      functionName: scrubberName,
      description: `Redacts and tokenises PII in ${envName} log records before Firehose writes them`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: scrubberRole,
      timeout: cdk.Duration.seconds(transformTimeoutSeconds),
      memorySize: 512,
      // Bounded rather than unlimited: every invocation holds a slice of the
      // account's concurrency, and a burst of log volume must not starve the
      // functions that serve traffic. Firehose retries what it cannot place.
      reservedConcurrentExecutions: transformConcurrency,
      environmentEncryption: this.encryptionKey,
      logGroup: scrubberLogGroup,
      environment: scrubberEnvironment,
      code: lambda.Code.fromInline(LOG_SCRUBBER_SOURCE),
    });

    (this.scrubber.node.defaultChild as lambda.CfnFunction).addMetadata('checkov', {
      skip: [
        {
          id: 'CKV_AWS_116',
          comment:
            'No DLQ: a Firehose transform is invoked synchronously, so there is no asynchronous ' +
            'event to route. Firehose retries the batch itself and then delivers it to the ' +
            'quarantine prefix, which is what ProcessingFailures alarms on.',
        },
        {
          id: 'CKV_AWS_117',
          comment:
            'Not in a VPC: the handler calls Secrets Manager and nothing else, and touches no ' +
            'VPC resource. Attaching it would put a NAT gateway or an interface endpoint in the ' +
            'path every log record takes.',
        },
      ],
    });

    // ── Delivery ──────────────────────────────────────────────────────────────
    const deliveryLogGroup = new logs.LogGroup(this, 'DeliveryLogGroup', {
      logGroupName: deliveryLogGroupName,
      retention: operationalLogRetention,
      encryptionKey: this.encryptionKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.deliveryStream = new firehose.DeliveryStream(this, 'DeliveryStream', {
      deliveryStreamName,
      encryption: firehose.StreamEncryption.customerManagedKey(this.encryptionKey),
      destination: new firehose.S3Bucket(this.archiveBucket, {
        encryptionKey: this.encryptionKey,
        compression: firehose.Compression.GZIP,
        bufferingInterval: cdk.Duration.seconds(bufferingIntervalSeconds),
        bufferingSize: cdk.Size.mebibytes(bufferingSizeMib),
        // Partitioned by date so an Athena table can prune by day. `!{timestamp}`
        // is Firehose's own expansion, evaluated against the record's arrival
        // time — not something the transform can influence.
        dataOutputPrefix: `${this.archivePrefix}dt=!{timestamp:yyyy-MM-dd}/hour=!{timestamp:HH}/`,
        // A separate top level, not a suffix under `scrubbed/`: everything the
        // archive's readers are given access to is below `scrubbed/`, and this
        // is the prefix that can hold records nothing scrubbed.
        errorOutputPrefix: `${this.quarantinePrefix}!{firehose:error-output-type}/dt=!{timestamp:yyyy-MM-dd}/`,
        loggingConfig: new firehose.EnableLogging(deliveryLogGroup),
        processors: [
          new firehose.LambdaFunctionProcessor(this.scrubber, {
            bufferSize: cdk.Size.mebibytes(processorBufferSizeMb),
            bufferInterval: cdk.Duration.seconds(bufferingIntervalSeconds),
            // Three attempts before the batch goes to quarantine unscrubbed.
            retries: 3,
          }),
        ],
        // No `s3Backup`. Firehose's source-record backup writes the
        // **untransformed** records to S3 — one enum away from archiving
        // exactly what this pipeline removes, under a prefix whose name says
        // "backup". `audit:logs` fails the build if one is ever configured.
      }),
    });

    // ── Subscriptions ─────────────────────────────────────────────────────────
    props.sourceLogGroupNames.forEach((logGroupName, index) => {
      const sourceGroup = logs.LogGroup.fromLogGroupName(this, `Source${index}`, logGroupName);
      new logs.SubscriptionFilter(this, `SourceSubscription${index}`, {
        logGroup: sourceGroup,
        destination: new logs_destinations.FirehoseDestination(this.deliveryStream),
        // Every event. A filter pattern here would be a second, undocumented
        // place where what reaches the archive is decided, and the events it
        // dropped would be the ones nobody could explain the absence of.
        filterPattern: logs.FilterPattern.allEvents(),
        filterName: `${envName}-log-pipeline-${index}`,
      });
    });

    // ── Masking at ingest ─────────────────────────────────────────────────────
    if (props.manageAccountDataProtectionPolicy === true) {
      const auditLogGroup = new logs.LogGroup(this, 'DataProtectionAuditLogGroup', {
        logGroupName: auditLogGroupName,
        retention: operationalLogRetention,
        encryptionKey: this.encryptionKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const managedIdentifiers = [
        'EmailAddress',
        'CreditCardNumber',
        'CreditCardSecurityCode',
        'Ssn-US',
        'PhoneNumber-US',
        'PassportNumber-US',
        'DriversLicense-US',
        'BankAccountNumber-US',
        'Address',
      ].map((name) => `arn:${this.partition}:dataprotection::aws:data-identifier/${name}`);

      new logs.CfnAccountPolicy(this, 'DataProtectionAccountPolicy', {
        policyName: `${envName}-log-data-protection`,
        policyType: 'DATA_PROTECTION_POLICY',
        scope: 'ALL',
        // The audit destination must not be covered by the policy that writes
        // to it, or every finding produces a finding. The scrubber's and the
        // delivery stream's groups are excluded for the same reason they are
        // cheap to exclude: they hold counters and delivery errors, and
        // scanning them is a cost per ingested byte with nothing to find.
        selectionCriteria: `LogGroupNamePrefix NOT IN ["${auditLogGroupName}", "${scrubberLogGroupName}", "${deliveryLogGroupName}"]`,
        // Two statements, in this order, is the shape the API accepts: audit
        // first so findings are recorded, then deidentify so readers see masks.
        // One statement alone is accepted too — and a policy with only the
        // audit half masks nothing while reporting that it found everything.
        policyDocument: JSON.stringify({
          Name: `${envName}-log-data-protection`,
          Description:
            'Masks managed data identifiers at ingest for every reader without logs:Unmask.',
          Version: '2021-06-01',
          Statement: [
            {
              Sid: 'audit-findings',
              DataIdentifier: managedIdentifiers,
              Operation: {
                Audit: {
                  FindingsDestination: {
                    CloudWatchLogs: { LogGroup: auditLogGroupName },
                  },
                },
              },
            },
            {
              Sid: 'mask-on-read',
              DataIdentifier: managedIdentifiers,
              Operation: { Deidentify: { MaskConfig: {} } },
            },
          ],
        }),
      });
    }

    // ── Alarms ────────────────────────────────────────────────────────────────
    this.alarmTopic = new sns.Topic(this, 'LogPipelineAlarmTopic', {
      topicName: `${envName}-log-pipeline-alerts`,
      displayName: `${envName} log pipeline alerts`,
      masterKey: kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
    });
    for (const email of props.alarmEmails ?? []) {
      this.alarmTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    const action = new cw_actions.SnsAction(this.alarmTopic);
    const pipelineMetric = (metricName: string, statistic = 'Sum'): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: LOG_PIPELINE_METRIC_NAMESPACE,
        metricName,
        statistic,
        period: cdk.Duration.minutes(5),
        dimensionsMap: { Environment: envName, Pipeline: deliveryStreamName },
      });

    const firehoseMetric = (metricName: string, statistic: string): cloudwatch.Metric =>
      new cloudwatch.Metric({
        namespace: 'AWS/Firehose',
        metricName,
        statistic,
        period: cdk.Duration.minutes(5),
        dimensionsMap: { DeliveryStreamName: deliveryStreamName },
      });

    const alarms: cloudwatch.Alarm[] = [];
    const alarm = (
      id: string,
      props_: Omit<cloudwatch.AlarmProps, 'metric'> & { readonly metric: cloudwatch.IMetric },
    ): cloudwatch.Alarm => {
      const created = new cloudwatch.Alarm(this, id, props_);
      created.addAlarmAction(action);
      created.addOkAction(action);
      alarms.push(created);
      return created;
    };

    // The transform throwing is the one failure that puts unscrubbed records in
    // S3, so it is the pipeline's most severe signal even though nothing is
    // down.
    alarm('ScrubberFailingAlarm', {
      alarmName: `${envName}-log-scrubber-failing`,
      alarmDescription:
        'The scrubbing transform is failing. Firehose retries and then writes the batch to the ' +
        'quarantine prefix UNSCRUBBED. Treat as a data-exposure incident, not a delivery delay.',
      metric: this.scrubber.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Firehose's own count of records it gave up transforming. Distinct from
    // the alarm above: a throttle or a timeout never surfaces as a Lambda error.
    alarm('ProcessingFailuresAlarm', {
      alarmName: `${envName}-log-pipeline-processing-failures`,
      alarmDescription:
        'Firehose abandoned the transform for some records and delivered them to the quarantine ' +
        'prefix unscrubbed. Drain the prefix and find out why the function could not run.',
      metric: firehoseMetric('ExecuteProcessingFailure.Records', 'Sum'),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Dropped records are the price of never failing open. They are still data
    // loss, and a pipeline quietly dropping a percentage of its input looks
    // exactly like one that is healthy.
    alarm('RecordsDroppedAlarm', {
      alarmName: `${envName}-log-pipeline-records-dropped`,
      alarmDescription:
        'The transform dropped records it could not decode, parse or fit in its response. ' +
        'Nothing leaked; those log lines are not in the archive.',
      metric: pipelineMetric(LOG_PIPELINE_METRICS.recordsDropped),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // The oversize path specifically, because its fix is a setting rather than
    // an investigation: lower `processorBufferSizeMb`.
    alarm('OversizeDroppedAlarm', {
      alarmName: `${envName}-log-pipeline-oversize-dropped`,
      alarmDescription:
        'Records were dropped because the transform response budget was exhausted. Lower ' +
        'processorBufferSizeMb — compressed input is expanding past the 6 MB response limit.',
      metric: pipelineMetric(LOG_PIPELINE_METRICS.oversizeRecordsDropped),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Tokenisation degrades to masking when the key cannot be read, which keeps
    // the pipeline safe and silently ends every correlation the archive
    // supports. Nothing else would report it.
    alarm('TokenizationUnavailableAlarm', {
      alarmName: `${envName}-log-pipeline-tokenization-unavailable`,
      alarmDescription:
        'The tokenisation key could not be read, so identifiers are being masked instead of ' +
        'tokenised. The archive stays safe; records for one subject no longer correlate.',
      metric: pipelineMetric(LOG_PIPELINE_METRICS.tokenizationUnavailable),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Every other signal here degrades to green when the pipeline stops
    // receiving: no records, no failures, no drops. This is the only alarm that
    // treats an absence as the failure it is.
    alarm('PipelineSilentAlarm', {
      alarmName: `${envName}-log-pipeline-silent`,
      alarmDescription:
        'No records have been scrubbed for 45 minutes. Either the source log groups stopped ' +
        'producing or the subscription is no longer delivering — the archive is not being ' +
        'written either way.',
      metric: pipelineMetric(LOG_PIPELINE_METRICS.recordsProcessed).with({
        period: cdk.Duration.minutes(15),
      }),
      threshold: 1,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // Delivery falling behind. The records are safe in the stream's buffer, but
    // the archive is stale and the transit log groups are expiring on schedule.
    alarm('DeliveryBacklogAlarm', {
      alarmName: `${envName}-log-pipeline-delivery-backlog`,
      alarmDescription:
        'Firehose has records older than 15 minutes still undelivered. The archive is behind ' +
        'the transit log groups, which expire on their own schedule.',
      metric: firehoseMetric('DeliveryToS3.DataFreshness', 'Maximum'),
      threshold: cdk.Duration.minutes(15).toSeconds(),
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.alarms = alarms;

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ArchiveBucketName', {
      value: this.archiveBucket.bucketName,
      description: 'Bucket holding the scrubbed log archive',
      exportName: `${envName}-log-archive-bucket`,
    });

    new cdk.CfnOutput(this, 'ArchivePrefix', {
      value: this.archivePrefix,
      description: 'Prefix under which scrubbed, line-delimited JSON is written',
      exportName: `${envName}-log-archive-prefix`,
    });

    new cdk.CfnOutput(this, 'QuarantinePrefix', {
      value: this.quarantinePrefix,
      description:
        'Prefix Firehose writes UNSCRUBBED records to when the transform could not run. Reads denied by bucket policy.',
      exportName: `${envName}-log-quarantine-prefix`,
    });

    new cdk.CfnOutput(this, 'DeliveryStreamName', {
      value: this.deliveryStream.deliveryStreamName,
      description: 'Firehose delivery stream the subscription filters write to',
      exportName: `${envName}-log-pipeline-stream`,
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: 'SNS topic the log pipeline alarms publish to',
      exportName: `${envName}-log-pipeline-alarm-topic`,
    });
  }
}
