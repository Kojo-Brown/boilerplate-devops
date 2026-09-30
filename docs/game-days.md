# Multi-AZ failover game days, and a recovery objective anybody has measured

`multiAz: true` is one line in `aws/cdk/lib/rds-stack.ts`. Until this item it was
also the whole of this repository's disaster-recovery story, and it is worth
being precise about what that line is: a claim about what AWS does, not about
what happens here.

**Who reads what.** `lib/game-days.ts` is the objectives and the scenarios as
data, plus the arithmetic that turns probe datapoints into a number.
`lib/failover-game-day-stack.ts` is the probe, the two gauges, and the automation
document. `npm run audit:gamedays` is the gate. This document is where the
numbers are written down, and §2 and §3 are the two entries an incident
commander should be able to find in thirty seconds.

---

## 1. What this exists to end

Before this, the answer to "how long is the database unavailable if we lose an
AZ?" was sixty seconds, and the provenance of that number was a product page.
Nobody had watched it happen. Three things follow from that, and each is worse
than the last.

**The number is about the wrong thing.** AWS undertakes to promote the standby.
What a dependent service needs to know is how long a connection attempt fails
for, and that is a larger number, because most of the gap is on the caller's
side of the endpoint: a pool holding sockets to the address the endpoint used to
resolve to, a resolver cache that outlives the endpoint's TTL, a health check
that keeps passing because the process is up. A promotion that AWS completes in
fifty seconds can be a three-minute outage for the application, and nothing in
the AWS console will ever tell you that.

**The two objectives were one.** A standby promotion loses nothing — the commit
is acknowledged only once the standby holds it — and takes a minute or two. A
point-in-time restore loses whatever has happened since `LatestRestorableTime`
and takes tens of minutes. A DR document with one pair of numbers for "the
database" has averaged those, and the pair it carries is reliably the flattering
one, which means the plan that would actually be executed during data loss is the
one nobody wrote down. That is why §2 and §3 are separate sections with separate
numbers, and why `validateGameDayCatalogue` refuses an RPO of zero on any path
whose basis is not synchronous replication.

**Nothing would have reported it going stale.** An engine upgrade, an
instance-class change, a new connection pool: each moves the RTO, and none of
them is a change anybody files under disaster recovery. Objectives therefore
carry a `rehearsalIntervalDays`, and `<env>-rehearsal-overdue-*` is the only
thing in this repository whose subject is a document quietly becoming untrue.

---

## 2. The database loses its writer

| | |
|---|---|
| **Recovery path** | Multi-AZ standby promotion |
| **RTO objective** | **120 seconds**, measured as a connection attempt from inside the VPC failing |
| **RPO objective** | **0 seconds**, on synchronous replication |
| **Status** | `rehearsed` — exercised by `<env>-gameday-rds-failover` |
| **Rehearsal interval** | 90 days |
| **Owner** | platform-team |

An AZ event, a failed writer, or a patch that reboots one takes the primary away.
The standby is promoted and the endpoint name comes to resolve to a different
address. Nothing committed is lost: that is what synchronous replication buys,
and it is the reason the RPO here is a zero anybody can defend rather than an
aspiration.

The RTO is 120 seconds and not the 60 the product page quotes. The extra minute
is not slack — it is the caller's resolver cache and pool recycling, which is the
part of the outage a database-side measurement cannot see and the part that
actually decides whether a dependent service returns a 503.

**What "measured" means here.** The probe in §4 tries to open a TCP connection
to the endpoint, by name, six times a minute. The RTO is the span from the first
failing sample to the first succeeding one afterwards, and it is reported with
its own uncertainty beside it. The exercise also records whether the endpoint's
address changed at all: if it did not, no promotion happened and the number
describes a reboot.

---

## 3. The data is wrong and has to be rolled back

| | |
|---|---|
| **Recovery path** | Point-in-time restore from automated backups |
| **RTO objective** | **1800 seconds**, and this one is a guess |
| **RPO objective** | **300 seconds**, on `LatestRestorableTime` |
| **Status** | `declared` — nothing exercises it |
| **Rehearsal interval** | 180 days |
| **Owner** | platform-team |

A bad migration or a bad deploy corrupts data. The promotion path in §2 cannot
help at all: the standby holds the same committed bytes, faithfully. Recovery
means a new instance restored to a second before the damage, and then a cutover.

**The RTO here has never been measured, and `status: 'declared'` is how that is
said out loud.** It stays in the catalogue anyway, because a dependency deciding
whether to queue or to fail needs an order of magnitude and "we have not
measured it" is one. What `declared` costs is the overdue alarm: only `rehearsed`
objectives are armed, since an alarm on an objective nothing can rehearse would
be red forever and would say nothing the status does not already say. The next
spec item after this one is the restore drill that makes this section honest.

**The RPO here, by contrast, is measured continuously** — see §5. It is the one
number in the whole of DR planning that is observable without running anything,
and in most accounts nobody is looking at it.

---

## 4. How the RTO is measured

The measurement has to work during the real event, at 04:00, with nobody awake
and no preparation. That rules out a stopwatch, and it is why the signal is
always on: the probe publishes whether or not anybody is running an exercise, so
the arithmetic below produces the same number for a real AZ failure as for a
scheduled one.

**The probe is inside the VPC, and that is the opposite of the synthetic
canaries.** `docs/synthetic-canaries.md` probes from outside the account, because
what those have to see — DNS, TLS, WAF — is invisible from within it. Here the
caller *is* inside: the application reaches a private endpoint over the same
subnets and the same security groups, so a probe anywhere else would be measuring
a path nothing uses, and would report healthy while the application could not
connect at all.

**It connects by name, never to the address it just resolved.** That is the whole
point. A client that cached the pre-failover address keeps failing after RDS
considers the promotion complete, and a probe that dialled the address it had
looked up a line earlier would never see it. The resolved address is recorded
separately, in an SSM parameter rather than in `/tmp` — a Lambda's `/tmp`
survives a warm invocation and nothing else, so with `/tmp` every cold start
would report an address change that did not happen, and the one signal that
distinguishes a failover from a reboot would be loudest exactly when nothing had
failed over.

**EventBridge cannot schedule anything faster than once a minute, and the event
being measured lasts two.** A once-a-minute probe therefore cannot resolve this
RTO to better than half of itself. The way past that: the probe is invoked once a
minute and connects six times while it is running, ten seconds apart, publishing
each result at its own timestamp. Which only works because the metric is
**high-resolution** — at standard resolution CloudWatch would aggregate the six
samples into the minute they landed in and hand back exactly the sixty-second
ruler this exists to escape. `audit:gamedays` checks both numbers, because
either one changing silently returns the measurement to useless while breaking no
test and no alarm.

Each sample is published as it is taken, rather than batched at the end. An
invocation that is killed at its timeout then costs the samples it had not taken
and none of the ones it had — the difference between a coarser measurement and a
refused one.

**`measureRto` refuses more often than it answers, and every refusal is a case
where the obvious implementation returns a flattering number:**

| Refusal | What the obvious implementation does instead |
|---|---|
| `no-datapoints` | averages an empty set to zero and reports a perfect RTO |
| `no-outage-observed` | reports zero, when the truth is that the fault missed or the probe did |
| `outage-began-before-window` | reports the span it can see, which is a lower bound wearing a measurement's clothes |
| `outage-unresolved-in-window` | reports "recovered" at the end of the window, because the window ended |
| `datapoint-gap-across-outage` | treats missing samples as healthy ones, turning a four-minute outage nobody observed into a twenty-second one |

A conclusive measurement carries `resolutionSeconds`: the larger of the two gaps
bounding the event — last success to first failure, and last failure to first
success. Measured from the data rather than assumed from the schedule, because a
probe that was running late produced a coarser number than one that was not, and
the record should say which. A gap wider than two sample intervals refuses
outright, which is also why `MIN_RTO_PERIODS` exists: with a floor of ten sample
intervals on any objective, the worst tolerated resolution is a fifth of the
number being measured. An objective below the floor is not a demanding target, it
is an unmeasurable one, and in a document the two look identical.

The verdict is three-valued for the same reason. A measured 122 seconds against a
120-second objective, from a probe whose resolution is 10 seconds, is not a
miss — it is indistinguishable from a pass, and calling it a miss is how a gate
teaches people that it is noise. `within-measurement-error` says what it is.

---

## 5. The RPO nobody watches

`LatestRestorableTime`, from `rds:DescribeDBInstances`, is how much data a
point-in-time restore would lose if you started one now. It is a timestamp on a
describe call rather than a metric, which means nothing can alarm on it until
something turns it into a gauge — and so, in most accounts, nothing does.

The failure it catches is the quietest one in this document. If the backup
pipeline stops, that timestamp stops advancing: the instance stays healthy, the
backups stay "enabled", every RDS metric stays flat, and the data you could get
back gets older every hour. There is no error, no alarm and nothing in
CloudFormation drift.

`<env>-game-day-recorder` publishes `RestorePointLagSeconds` every five minutes.
Two decisions in that are load-bearing:

**It publishes nothing for a reading it cannot make**, and the alarm breaches on
missing data. An instance with backup retention set to zero has no
`LatestRestorableTime` at all — and "there is no restore path" is not a small
lag. A timestamp in the future, which is clock skew or a parsing error, is
likewise dropped rather than clamped: clamping publishes a perfect RPO out of a
broken reading, which is the worst outcome available.

**The threshold is not the objective.** `LatestRestorableTime` advances in steps
of about one objective, so the observed lag sawtooths between nearly zero and one
full step, and a sampler can land anywhere in that tooth. What a five-minute
sampler sees therefore peaks at a step plus a sample interval — so a threshold
set at the 300-second objective is red during normal operation, and an alarm that
is usually red is an alarm with a filter rule on it. The threshold is
`rpoSeconds + 2 × recorder interval` = **900 seconds**, one sample interval clear
of the sawtooth, and still catching the failure that matters, which is not a late
backup but a backup pipeline that has stopped — at which point the lag climbs
without bound. `audit:gamedays` pins the synthesised threshold to that formula.

---

## 6. The alarm that is supposed to fire

`<env>-db-connect-failing` goes red during an exercise, for about two minutes.
That is not a side effect to be suppressed; it is most of the value.

An exercise in which the outage signal stays green has measured nothing, and a
game day is the only occasion on which anybody finds out whether the signal
works. Suppressing it would mean the one rehearsal of the alerting path is the one
where the alerting path is switched off.

So it pages, and the alert is expected:

* The approval request in the automation says so, in the message a human reads
  before approving: this will fail connections, and this alarm will page.
* The alarm's own description says so and links here, so somebody who finds the
  page without the context can tell in one read whether to escalate.
* `docs/runbooks.md` §10 opens with "first, is a game day running?" and says
  where to check.

`<env>-game-day-probe-silent` is its counterpart, and the two must not be one
alarm. A probe reporting failures and a probe reporting nothing are different
incidents with different first steps, and the second is the more dangerous: from
then on every RTO is measured over windows full of nothing, and nothing averages
to health. That alarm's subject is the absence of data, so it is the one alarm
here that breaches on missing data by design; `<env>-db-connect-failing` uses
`MISSING` instead, because paging twice for one cause is how a responder learns
to read one of the two.

---

## 7. Running an exercise

    approve → assert Multi-AZ → preflight → RebootDBInstance(ForceFailover)
            → settle → wait for available → measure → record
            └─ any failure: record the abort, with the step that failed on it

**`aws:approve` is step one, always.** Everything else this repository starts
automatically is read-only — `docs/runbooks.md` describes a gate that rejects any
runbook first step whose API call is not a `Describe` — and this is the one
automation that deliberately changes production. `approvalRequired` is a field on
the scenario rather than a constant so that turning it off is a diff somebody has
to defend, and the gate refuses a document whose first step is anything else,
because a document that begins with the fault can be started by a schedule.

**The blast radius is structural, not checked.** A scenario declares
`allowedEnvironments` and the stack builds a document only where this environment
is in that list. A run somewhere it was not sanctioned is not refused at run
time — there is nothing to run. That is stronger than a runtime check, whose
failure mode is a document that exists in production and declines, one
`--parameters` override away from not declining. `audit:gamedays` holds the
synthesised documents against the declaration, so a scenario narrowed in the
catalogue cannot leave a working exercise behind.

Production is in the list on purpose. A failover rehearsed only in staging
measures staging's connection pool, staging's DNS caching and staging's traffic,
which is to say it measures none of the things the number is for.

**The four preflight checks each exist because the exercise fails silently
without them:**

| Check | Without it |
|---|---|
| `multi-az-enabled` | a forced failover on a Single-AZ instance is a reboot; the exercise reports a measured RTO for a promotion that never happened |
| `probe-reporting` | the measurement window has holes in it, and a hole is not a fast recovery |
| `no-deployment-in-progress` | the exercise measures two changes and reports one |
| `no-alarm-in-alarm-state` | a game day during an incident is not a game day |

`multi-az-enabled` is asserted in the document itself, with
`aws:assertAwsResourceProperty`, so it is visible without reading a Lambda. The
other three need reads that are not a property of one resource and live in the
conductor.

**The preflight refuses more often than it passes, and that is the design.** An
aborted exercise is a result: three refusals in a row is a finding about the
environment. So every step routes its failure to one abort step that writes the
record, reads the execution to find out which step failed, and puts that on the
notification — because an exercise that stopped and left nothing behind cannot be
told apart from an exercise nobody ran, and the second is the story people tell
themselves.

**An abort never resets the rehearsal clock.** The record holds `lastAttempt` and
`lastMeasured` separately, and the freshness metric reads the second. With a
single record it would be enough to schedule an exercise, have the preflight
refuse, and have the objective look freshly rehearsed on the strength of an
exercise that injected nothing.

**The wait is a sleep, and then a status wait — in that order.** The obvious
shape is `aws:waitForAwsResourceProperty` on `DBInstanceStatus == available`, and
it has a trap: for a few seconds after `RebootDBInstance` returns the instance
still reads `available`, so that wait is satisfied immediately and the
measurement runs over a window in which nothing has happened. A fixed settle
period does not have that failure, and the status wait is kept — after the
sleep, where observing `available` means something — as the implementation of the
`instance-not-available-in-time` abort. The gate checks the ordering, because
ordering is what nobody reviews in a nine-step document.

---

## 8. What you have to set

* **`STAGING_GAME_DAY_APPROVER_ARNS` / `PRODUCTION_GAME_DAY_APPROVER_ARNS`** —
  comma-separated IAM principals who may approve. The default is the role *name*
  `platform-team-oncall`, which is a placeholder and not an ARN: an account id in
  `bin/app.ts` would be a hardcoded identifier in copy-paste material, and
  `npm run scan:identifiers` would be right to fail on it. An unset variable
  therefore produces a document nobody can approve rather than one anybody can.
* **Subscribe the rota to `<env>-game-day`.** The exercise's own notifications
  and the DR alarms both land there, and it is subscribed to the runbook enricher
  in `bin/app.ts` so the alerts arrive with §10 of `docs/runbooks.md` attached.
* **Expect `<env>-rehearsal-overdue-rds-multi-az-promotion` immediately.** An
  objective that has never been measured is overdue, by design: treating "no
  record" as "not due yet" would mean the alarm arms itself only once somebody
  has already done the thing it is reminding them of. Run the exercise in staging
  and it clears.
* **Run staging first.** Not as a substitute for production — see §7 — but
  because the first run of anything in this document is the one that finds out
  whether the approvers are right, whether the probe's security-group path works,
  and whether the preflight refuses for a reason nobody anticipated.

---

## 9. Cost

Small, and not nothing. Per environment, per month, at us-east-1 list prices:

* **The probe**: 43,200 invocations (one a minute), each about 55 seconds of
  wall-clock at 128 MB but mostly idle in `setTimeout`. Around $0.30 of duration
  and $0.01 of requests.
* **High-resolution custom metrics**: the probe publishes `ConnectSuccess` six
  times a minute. Custom metrics are charged per metric per month rather than per
  datapoint, so the six-a-minute sampling is free; the seven metric names in
  `Platform/GameDay` across their dimension combinations are about $2.40.
* **`PutMetricData` calls**: six a minute from the probe, one every five minutes
  from the recorder. The first million API requests a month are free, and this is
  about 268,000.
* **The recorder and the conductor**: 8,640 invocations and a handful. Under
  $0.05.

Call it **$3 a month per environment**, which buys an RTO number somebody has
watched happen and an RPO that is checked every five minutes. The one thing worth
watching is metric *dimensions*: adding a dimension to `ConnectSuccess`
multiplies the metric count, and that is where a custom-metric bill goes wrong.

---

## 10. The gate

`npm run audit:gamedays` runs in CI, after `cdk synth`, and reads the
synthesised templates rather than the TypeScript — defaults, aspects and
cross-stack references all resolve in between. Every rule is for something that
deploys cleanly:

* **`document-in-forbidden-environment`** — the blast radius is enforced by which
  documents exist, so a scenario narrowed from `['staging', 'production']` to
  `['staging']` leaves a working exercise in production.
* **`document-without-approval`**, **`approval-without-approvers`**,
  **`approval-without-notification`** — the three ways the human in front of a
  production outage is removed. The last is the quietest: an approval request
  with no `NotificationArn` reaches nobody, and the exercise times out an hour
  later.
* **`failover-without-force-failover`**, **`failover-without-multi-az-assert`** —
  the two ways a failover is a reboot.
* **`wait-before-settle`** — the ordering trap in §7.
* **`step-without-abort-path`**, **`abort-step-missing`** — the ways an exercise
  ends with no record.
* **`probe-not-in-vpc`**, **`probe-resolution-too-coarse`** — the ways the
  measurement quietly stops being able to resolve the thing it measures.
* **`restore-point-threshold-wrong`**, **`freshness-alarm-not-breaching`** — an
  alarm that is red in normal operation, and an alarm that cannot fire because
  its subject is an absence it was told to ignore.
* **`failover-write-unscoped`**, **`automation-role-holds-other-writes`** — this
  is the only role in the repository that can change production, and
  `rds:RebootDBInstance` on `"*"` reads in a diff exactly like the scoped
  version.
* **`objective-anchor-missing`**, **`doc-anchor-missing`** — a renamed heading
  here, which GitHub answers 200 for and lands the reader at the top of the page.

Plus every rule in `validateGameDayCatalogue`, which `FailoverGameDayStack` also
asserts at synth time so a bad catalogue fails the build rather than deploying.

---

## 11. Known gaps

* **Nothing has been deployed.** No failover has been forced in a real account,
  so no RTO in this document has been observed — the 120 seconds in §2 is still
  an objective and not a measurement, and the first exercise may well miss it.
  Every number in §9 is a list price rather than a bill.
* **The probe measures a TCP connection, not a query.** It answers "is the port
  answering", which is the failure a promotion produces, and it would not see a
  database that accepts connections and refuses to write — a read-only replica
  promoted into the wrong role, a full disk. That needs a client library in the
  probe, which means bundling, which this repository does not do.
* **The restore path's RTO is unmeasured**, as §3 says, and its RPO is read from
  an API rather than from a restore anybody performed. `LatestRestorableTime`
  advancing is evidence that backups are being taken, not that they can be
  restored.
* **The RPO of §2 is asserted, not measured.** Zero data loss is a property of a
  synchronous commit, and observing it from outside the engine is not something
  this probe or any other can do. What is enforced instead is that only a
  synchronous basis may claim zero.
* **One fault kind.** A forced failover is not an AZ outage: the subnets, the NAT
  gateway and the tasks in that AZ all stay up. AWS FIS templates are the spec
  item after next, and an AZ-level fault is where the interesting caller-side
  failures actually live.
* **Nothing schedules the exercise.** By design — `aws:approve` exists so that a
  machine cannot start one — but it means the overdue alarm is the only thing
  that makes a rehearsal happen, and it is a ticket rather than a page.
* **The conductor's RTO arithmetic is a second copy** of `measureRto`, because
  `lambda.Code.fromInline` cannot import. A differential test runs a table of
  hand-built outages through both and asserts they agree, which turns drift into
  a failing assertion rather than a number nobody can reproduce.
* **Two contracts in the automation document are unverified.**
  `aws:assertAwsResourceProperty` compares `DesiredValues` against the string
  form of whatever the selector returns, and the case SSM uses for a boolean is
  not documented, so `assertMultiAz` accepts both spellings; and the
  measurement reads `{{ preflight.startedAt }}` out of an
  `aws:invokeLambdaFunction` step's `Payload`, which the schema types as a
  string map. If either is wrong the step fails at resolution and the exercise
  routes to `recordAbort` with the reason on it — loud, on the first run, in
  staging, rather than silent — but neither has been run against SSM.
* **A late invocation can refuse a measurement.** EventBridge schedules are
  best-effort, and an invocation delayed past one sample interval leaves a hole
  wider than `MAX_RESOLUTION_SECONDS` in the series. The exercise then reports
  `datapoint-gap-across-outage` and has to be re-run. That is the correct
  direction — a refusal rather than a number with a hole in it — and it will
  occasionally cost an exercise.
* **`no-alarm-in-alarm-state` is account-wide within the environment prefix**, so
  an unrelated ticket-severity alarm being red refuses the exercise. That is the
  safe direction and it will be annoying, and the fix — a list of alarms a game
  day may proceed through — is a list that grows until it contains the ones that
  mattered.
