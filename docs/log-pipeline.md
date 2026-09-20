# The log pipeline: scrubbing PII before anything durable ingests it

An application logs an email address by accident roughly once per feature. Not
in a field called `email` — those get reviewed — but interpolated into a message
by a developer debugging a support ticket, or carried in the body of an
exception, or spread into a log line as `...req.body`. The line is correct, the
deploy is green, and the address is now in a store that is backed up, indexed,
queried by analytics tooling and kept for a year.

This is the pipeline that stops that at the last point where stopping it is
possible: after the application has emitted the line and before anything that
keeps it has written it down.

```
container stdout
   │  awslogs driver
   ▼
CloudWatch Logs ─── data protection policy: masked at ingest, findings audited
   │                 short retention: this is transit, not the archive
   │  subscription filter (every event)
   ▼
Kinesis Data Firehose
   │  Lambda transform: redact, tokenise, drop what it cannot read
   ▼
S3  scrubbed/dt=…/     ← the copy that is kept, queried and shared
    quarantine/…/      ← records the transform never saw. Denied by policy,
                         alarmed on, expires in 7 days.
```

Everything below is either a decision that is not obvious or a failure that is
invisible. The code is [`aws/cdk/lib/log-pipeline-stack.ts`](../aws/cdk/lib/log-pipeline-stack.ts)
(the infrastructure and the transform) and
[`aws/cdk/lib/log-scrubbing.ts`](../aws/cdk/lib/log-scrubbing.ts) (the rules).
`npm run audit:logs` is the gate.

---

## 1. "Before ingest" has to name an ingest

There are two stores here and a design that addresses one of them reads as
complete.

**CloudWatch Logs is not scrubbable.** The `awslogs` driver writes the line as
the container emits it; the write *is* the ingest, and there is no hook before
it. What CloudWatch offers instead is a **data protection policy**, which
matches managed data identifiers at ingest and masks them for every reader
without the `logs:Unmask` permission, recording a finding for each match.

Two things about that are worth being precise on, because the console is not:

- **Masking is a read-time control, not a deletion.** The raw bytes are stored.
  A principal with `logs:Unmask` sees the original, which is correct — that is
  how you investigate — and means the account still holds the data.
- **It is per log group unless it is per account.** A policy attached to a log
  group protects that group; a new service's group, created next month by the
  `awslogs` driver, is unprotected and nothing reports it. So this pipeline uses
  `AWS::Logs::AccountPolicy` with `scope: ALL`, which covers groups created
  after it.

What makes that tolerable is the second half: the CloudWatch copy is **transit**.
It expires in weeks. The copy that is kept for a year is the S3 archive, and
nothing reaches the archive without passing through the transform. That is where
"before ingest" is literal.

## 2. The transform, and the one decision everything follows from

Firehose's transform contract has three outcomes per record:

| Result | What Firehose does |
| --- | --- |
| `Ok` | delivers the transformed record |
| `Dropped` | discards it — nothing is written |
| `ProcessingFailed` | retries, then writes **the original record** to the error prefix |

`ProcessingFailed` is what every transform blueprint returns for a record it
could not handle. In a scrubbing pipeline it is the leak: the record that
defeated the scrubber is precisely the one that lands in S3 untouched.

**So this handler never returns it.** A record it cannot base64-decode, cannot
gunzip, cannot parse, or cannot fit in its response is `Dropped`, counted, and
alarmed on. Losing a log line is recoverable — the source group still holds it
for the transit window, and the alarm says how many. Writing it unscrubbed is
not recoverable.

That leaves Firehose's own `ExecuteProcessingFailure` — an invocation that
throws, times out or is throttled, which the function cannot influence — as the
only remaining path to the error prefix. §4 is about that prefix.

Three smaller parts of the contract are each a silent failure:

- **Firehose adds no separator between records.** A transform returning bare
  JSON produces S3 objects that are one unparseable line. Athena reports that as
  zero rows, not as an error. Every line the transform emits ends with `\n`.
- **The response is capped at 6 MB**, and the input is gzipped, so a full input
  batch expands past it. The processor buffer is therefore **0.2 MB** — the
  smallest Firehose accepts, and what its own CloudWatch Logs blueprint uses —
  and the handler tracks a base64 budget, dropping what no longer fits.
  `OversizeRecordsDropped` is the signal that the buffer is still too large for
  your compression ratio.
- **`CONTROL_MESSAGE` records** are CloudWatch's subscription health checks.
  They are dropped, and counted separately from `RecordsDropped` — folding them
  in would put a permanent floor under the drop alarm, which is how an alarm's
  threshold gets raised until it never fires.

## 3. The rules, and why the ruleset has a validator

Scrubbing is two passes over every record, because neither one subsumes the
other:

- **By key.** A JSON key matching `password`, `ssn`, `card_number`,
  `authorization` and the rest of `DEFAULT_SENSITIVE_KEYS` has its value
  replaced by `[REDACTED:FIELD]` whatever the value's type — an object under a
  key called `password` is not safer than a string. A value-only ruleset misses
  `"ssn": "not on file"` and `"password": 12345`.
- **By value.** Every string is scanned with the pattern rules. A key-only
  ruleset misses the address somebody interpolated into `message`, which is the
  common case.

Matching is span-based: every rule is applied to the **original** string, the
matched spans are merged, and the string is rewritten once. Rules never see each
other's output, so the result does not depend on rule order. Overlapping spans
merge rather than resolving by precedence — taking the first and skipping the
second would leave the part of the second that extends past the first in the
line. A span wholly inside another keeps the outer rule's marker; a partial
overlap becomes `[REDACTED:OVERLAPPING]`, because there is no honest label for a
region no single rule describes.

Two rules are worth reading twice:

- **Cards are Luhn-checked.** Without a check digit, a 13-to-19-digit pattern
  eats order ids, trace ids and microsecond durations. Luhn is a filter, not
  proof: about one in ten arbitrary digit runs passes it.
- **IPv4 is not in the default ruleset.** It is personal data in one reading and
  the primary correlation key in another — the field an abuse investigation, a
  rate-limit dispute and "which node served this" all start from. Add it
  deliberately:

  ```ts
  ruleset: extendRuleset(DEFAULT_SCRUBBING_RULESET, { rules: [IPV4_RULE] }),
  ```

`assertValidScrubbingRuleset` runs at **synth** time, because every way of
getting a ruleset wrong produces a pipeline that deploys and reports success:

| Refused | What it would do in production |
| --- | --- |
| a pattern that does not compile | throws at cold start; every retry fails the same way; the batch is delivered raw |
| a pattern matching the empty string | matches at every position — every line becomes redaction markers |
| a `g` or `y` flag | gives the shared RegExp a `lastIndex` that survives between records, so the same input is scrubbed on one invocation and passed through on the next |
| a replacement another rule matches | the marker is itself redacted and stops saying what was removed |
| a key both masked and tokenised | masking runs first: the join key becomes a constant, silently |
| a ruleset over the environment limit | Lambda rejects the function on update — a failed deploy at the end of the pipeline, from a diff that was a regex |

That last one is the least obvious: the ruleset travels to the function as an
environment variable, and **Lambda caps the whole environment at 4 KB**, keys
included. The default ruleset uses about 2.2 KB, so there is room for a handful
of local rules before the synth-time assert fires. It fires in a build, not in a
deploy.

## 4. The quarantine prefix holds unscrubbed records, by design

Firehose writes records it could not transform to `ErrorOutputPrefix`, in their
original form. There is no setting that turns this off; a delivery stream
without an error prefix writes them to the bucket root instead. So the design
treats that prefix as what it is — a small, short-lived store of exactly the
data the pipeline exists to remove:

- It is a **separate top-level prefix** (`quarantine/`), not a folder under
  `scrubbed/`. Whatever grant, lifecycle rule or Athena table covers the archive
  must not cover this.
- **Reads are denied by a bucket policy** to every principal not named in
  `quarantineReaderRoleArns`. With nothing named — the default — that includes
  administrators, and an incident that needs those records starts with a pull
  request adding a role. That friction is the point; the alternative is a prefix
  of raw records readable by everyone who can read the archive, which is the
  audience the scrubbing was for.
- It **expires in 7 days**, and that lifecycle rule is the only thing bounding
  how long unscrubbed data lives here.
- Anything landing there raises `…-processing-failures`. Treat it as a
  data-exposure event, not a delivery delay.

`S3BackupMode: Enabled` — Firehose's "source record backup" — writes the
untransformed records to S3 beside the transformed ones. It is one enum in a
template, one checkbox in the console, its prefix says `backup`, and it archives
precisely what the transform removed. `audit:logs` fails the build on it.

## 5. Tokenisation is pseudonymisation, not anonymisation

Masking an identifier makes the archive safe and makes it useless for the
question people actually ask: *what did this user do before the error?* So keys
in `DEFAULT_TOKENIZE_KEYS` — `email`, `user_id`, `customer_id` and their
spellings — are replaced by an HMAC instead:

```
"email": "ada@example.com"  →  "email": "tkn:email:9f2c…"
```

The same subject produces the same token on every record, so correlation still
works. Values are normalised (trimmed, lowercased) before hashing, because
`Ada@Example.com` and `ada@example.com` are one subject and two tokens would be
a join that silently returns half the rows. A value already carrying the `tkn:`
prefix is passed through unchanged, which makes a second pass idempotent.

**What this is not:** anonymisation. The input domain of an email address or a
user id is small enough to enumerate, so anyone holding the key and a candidate
list can confirm a match. It removes the value from the archive; it does not
remove the subject from the record. Treat the archive as pseudonymised personal
data, not as anonymous data — the distinction is the one GDPR Recital 26 draws,
and it decides whether a deletion request reaches this bucket.

The key is generated by Secrets Manager and never leaves it. **Rotating it is a
seam**: tokens minted after the rotation do not match tokens minted before, so
correlation stops at that boundary. It is a correlation key, not a credential —
it grants nothing — so it is not on a rotation schedule. Rotate it when you want
the seam.

If the key cannot be read, tokenisation **degrades to masking** rather than to
passing the value through. The archive stays safe, every correlation quietly
stops working, and `…-tokenization-unavailable` is the only thing that would
tell you.

## 6. What the pipeline publishes about itself

The transform emits EMF counters under the `LogPipeline` namespace and **never
logs any part of a record** — its own log group is the one group in the account
the pipeline cannot scrub, because it is written after the scrub. A
`console.log(record)` added there during a debugging session would bypass
everything in this document; the test suite asserts that no branch of the
handler writes record content anywhere.

| Metric | Read it as |
| --- | --- |
| `RecordsProcessed` | the pipeline is alive |
| `RecordsDropped` | data loss, never a leak |
| `OversizeRecordsDropped` | lower `processorBufferSizeMb` |
| `UnreadableRecordsDropped` | something is producing records this cannot parse |
| `RedactionsApplied` | how much is being removed — a step change is a new field somewhere |
| `TokensIssued` / `TokenizationUnavailable` | correlation working / silently off |
| `ValuesTruncated` / `SubtreesClipped` | the bounds are being hit |
| `ControlMessagesDropped` | routine; kept out of `RecordsDropped` on purpose |

Per-rule counts ride along as a `redactionsByRule` property rather than as
metric dimensions: a metric per rule multiplies the dimension set by the size of
the ruleset, and the question they answer — *which rule is firing on
everything?* — is asked from Logs Insights, not from an alarm.

Seven alarms. The one that matters most is `…-silent`: every other signal here
degrades to green when the pipeline stops receiving — no records, no failures,
no drops — so that alarm treats missing data as breaching. A pipeline that has
stopped and a pipeline that is healthy look identical on every other chart.

## 7. Querying the archive

Objects are gzipped, line-delimited JSON under `scrubbed/dt=YYYY-MM-DD/hour=HH/`.
Envelope fields carry an `@` prefix — CloudWatch's own convention — so an
application field called `timestamp` or `id` cannot overwrite where the record
came from:

```json
{"@timestamp":"2026-09-20T11:02:03.000Z","@id":"374…","@logGroup":"/ecs/production/api",
 "@logStream":"api/task/1a2b","level":"error","msg":"charge failed for [REDACTED:CARD]",
 "email":"tkn:email:9f2c…"}
```

An Athena table over `s3://<bucket>/scrubbed/` with `dt` and `hour` as partition
keys prunes by day; point it at the prefix, never at the bucket, or it reads
`quarantine/` as rows.

## 8. Known gaps

- **Nothing has run.** This repository deploys no application, so no record has
  been through this pipeline in an account. The transform is compiled and run
  against recorded Firehose events in `test/log-scrubber-handler.test.ts`; the
  infrastructure is asserted against the synthesised template. Neither is a
  delivery.
- **Oversize batches are dropped, not re-ingested.** AWS's blueprint re-ingests
  records that no longer fit the response via `PutRecordBatch`. That needs the
  function to hold a grant on the stream it is a transform of — a cycle in
  CloudFormation — and a second pass that is idempotent. The handler is
  idempotent already (§5), so this is a deliberate omission rather than a
  blocked one.
- **No Object Lock on the archive.** A WORM archive is the right answer for a
  compliance log and the wrong one for a boilerplate: it cannot be turned off,
  and it makes a non-production `cdk destroy` fail.
- **The source log groups are imported by name**, because the `awslogs` driver
  creates them the first time a task starts. A subscription filter on a group
  that does not exist yet fails the stack update, so on a brand-new service the
  pipeline is deployed after the first task has run. `LogInsightsStack` imports
  the same groups the same way.
- **The scrubber is the only enforcement point.** Nothing stops a second
  subscription filter on a source log group forwarding the same events
  elsewhere, except `audit:logs` reporting it at build time. Nothing stops a
  principal with `logs:Unmask` reading the transit copy.
- **Managed data identifiers are US-centric here.** The account policy names the
  US spellings of SSN, phone, passport and driver's licence. Add the
  jurisdictions you operate in; the list is in the stack and the identifiers are
  in CDK's `logs.DataIdentifier`.
- **Custom identifiers are not used in the CloudWatch policy.** The account
  policy masks with AWS's managed identifiers only, so an internal id format
  reaches the transit copy unmasked. It is scrubbed before the archive.
- **Deletion requests are not automated.** A tokenised archive answers "which
  records are this subject's" only if you can recompute the token, which needs
  the key. There is no tooling here for that.
