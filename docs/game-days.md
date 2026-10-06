# Recovery objectives anybody has measured: a failover game day and a restore drill

`multiAz: true` and `backupRetention: 7` are two lines in
`aws/cdk/lib/rds-stack.ts`. Between them they were, until these items, the whole
of this repository's disaster-recovery story, and it is worth being precise about
what they are: claims about what AWS does, not about what happens here. The first
says a standby will be promoted and says nothing about how long a caller waits.
The second says backups are being taken and says nothing about whether anything
can be restored from them.

There are two recovery paths over this one database and they are rehearsed by two
exercises of deliberately different shapes. §2 is the promotion path: a human
approves it, it breaks a live primary on purpose, and the outage is read off a
probe that was already running. §3 is the restore path: nobody approves it, it
runs every thirty days, and it restores the database into a copy and proves the
copy is the data. Why one has an approval and the other must not is §13, and it
is the single decision in this document most worth disagreeing with carefully.

**Who reads what.** `lib/game-days.ts` is the objectives and the scenarios as
data, plus the arithmetic that turns datapoints and timestamps into numbers.
`lib/failover-game-day-stack.ts` is the probe, the two gauges, and the failover
automation document; `lib/backup-restore-drill-stack.ts` is the restore drill,
its verifier and its sweeper. `npm run audit:gamedays` is the gate over both.
This document is where the numbers are written down, and §2 and §3 are the two
entries an incident commander should be able to find in thirty seconds.

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

**A backup that is taken is not a backup that restores.**
`LatestRestorableTime` advancing is a real signal and §5 publishes it every five
minutes, but what it establishes is that the pipeline is running. The question
backups exist to answer — can this be restored, and is what comes back the data
— cannot be answered by watching anything. It can only be answered by restoring,
which is §12.

**Nothing would have reported any of it going stale.** An engine upgrade, an
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
| **RTO objective** | **1800 seconds** |
| **RPO objective** | **300 seconds**, on `LatestRestorableTime` |
| **Status** | `rehearsed` by `rds-pitr-drill` — see §12 |
| **Rehearsal interval** | 30 days |
| **Owner** | platform-team |

A bad migration or a bad deploy corrupts data. The promotion path in §2 cannot
help at all: the standby holds the same committed bytes, faithfully. Recovery
means a new instance restored to a second before the damage, and then a cutover.

**The RTO here carried `status: 'declared'` for one spec item, which is how "this
number is a guess" was said out loud.** It is now `rehearsed`: `rds-pitr-drill`
restores the database into a copy every thirty days, verifies the copy, publishes
the seconds it took as `MeasuredRestoreSeconds`, and deletes it. See §12.

The 1800 seconds has deliberately **not** been moved to whatever a drill
reported. An objective edited to match the last measurement is not an objective,
and the gap between the two is the finding. The interval came down from 180 days
to 30 because a drill nobody has to approve can run monthly, and because the
restore path's RTO moves with the volume's size — which grows continuously, so a
number from six months ago is a number about a smaller database.

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
* **Expect both `<env>-rehearsal-overdue-*` alarms immediately.** An objective
  that has never been measured is overdue, by design: treating "no record" as
  "not due yet" would mean the alarm arms itself only once somebody has already
  done the thing it is reminding them of. The promotion one clears when somebody
  runs the exercise in staging; the restore one clears by itself, within thirty
  days, the first time a drill verifies a copy — which is the whole point of §13.
* **Subscribe the rota to `<env>-restore-drill` as well.** The drill's results
  and its two findings land there, enriched with §11 of `docs/runbooks.md`. The
  one to read is `<env>-restore-drill-instance-orphaned`: it is the only alarm in
  this document that is about money and about a second copy of production's data
  existing. See §15.
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

* **The restore drill**: one `db.t3.medium` with 100 GiB of gp3, for about 45
  minutes, once a month, plus the sweeper's 720 invocations. At list prices that
  is roughly **$0.06 of instance time and $0.02 of storage per drill** — the
  storage is billed per GiB-month and a 45-minute instance is a thousandth of
  one. Add the restore's own I/O, which gp3 includes up to its baseline.

Call it **$3 a month per environment**, which buys an RTO number somebody has
watched happen, an RPO that is checked every five minutes, and a monthly
demonstration that the backups restore. The one thing worth watching is metric
*dimensions*: adding a dimension to `ConnectSuccess` multiplies the metric count,
and that is where a custom-metric bill goes wrong.

The drill's cost is proportional to the source's volume and its instance class,
because it restores onto the same class — deliberately, see §12 — so on a 2 TiB
`db.r6g.4xlarge` it is dollars rather than cents per drill, and the thing that
makes it expensive is not the drill but a copy that outlives it. That is §15.

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

The restore drill is the other half of the gate, and its rules are about the
opposite failures — an exercise nothing starts rather than one anything can:

* **`drill-document-with-approval`**, **`drill-schedule-missing`**,
  **`drill-schedule-interval-wrong`** — the three ways a drill nobody has to
  approve stops running. The first is the subtlest: an `aws:approve` step in a
  scheduled document produces an execution that starts on time, asks a question
  into an empty room, and times out an hour later, every month.
* **`drill-restore-publicly-accessible`** — `RestoreDBInstanceToPointInTime`
  takes `PubliclyAccessible` from the request and defaults it from the subnet
  group, so an absent flag is a full copy of the database on a public endpoint.
* **`drill-restore-not-point-in-time`**, **`drill-restore-deletion-protected`** —
  a drill that restores from something other than a point in time, and a copy the
  teardown cannot delete.
* **`drill-verification-missing`**, **`drill-teardown-missing`** — a drill that
  checks nothing, checks after it has already reported, or leaves the copy
  running. Each of them is a drill that looks like it worked.
* **`drill-delete-not-scoped-to-the-copy`**, **`drill-role-can-write-the-source`**
  — the safety argument for running an exercise unattended is that it cannot
  touch anything live, and that argument is an IAM policy rather than an
  intention.
* **`restore-unverified-not-alarmed`**, **`drill-orphan-not-alarmed`**,
  **`drill-sweeper-missing`** — a drill has to end green so that its teardown
  runs, so its findings reach people through metrics and alarms or not at all.

Plus every rule in `validateGameDayCatalogue`, which both stacks assert at synth
time so a bad catalogue fails the build rather than deploying — including the
trigger rules: a destructive fault on a schedule, a scheduled scenario with no
cadence, and a cadence slower than its objective's shelf life.

---

## 12. The restore drill, and what it does not cover

`BackupRestoreDrillStack` is the other half of this item: every thirty days, in
each environment, it restores the database into `<env>-dr-drill`, verifies the
copy, publishes how long that took, and deletes it.

```
schedule (every 30 days, no approval)
  └─ preflight  → there is a restore point, and no copy is already up
     restore    → RestoreDBInstanceToPointInTime, latest restorable time
     wait       → the copy reports available
     verify     → seven checks, from inside the VPC (§14)
     measure    → InstanceCreateTime → verified-at = MeasuredRestoreSeconds
     teardown   → delete the copy
     └─ any failure: abort, which deletes the copy and records why

sweeper (every hour)
  └─ a copy older than six hours with no drill running → delete it (§15)
```

**Why this is not covered by the RPO signal that already existed.** §5 publishes
`RestorePointLagSeconds` every five minutes, and it is a good signal: when the
backup pipeline stops, that number stops advancing. What it establishes is that
backups are being *taken*. It says nothing about whether anything can be restored
*from* them, and the two claims are indistinguishable on a dashboard. The only
way to find out is to restore, which is this.

**The copy is restored onto the source's own instance class and parameter
group**, both read by the preflight. A cheaper class would measure a recovery
nobody would perform: the volume hydrates at a rate the instance's own throughput
caps, so a `db.t3.micro` restoring a 2 TiB volume produces a number that has
nothing to do with the real thing. The one way the copy deliberately differs is
`MultiAZ: false` — a standby adds nothing to a copy deleted within the hour, and
a real recovery would enable Multi-AZ after the cutover rather than waiting for
it during the outage.

**It is unreachable from the application.** Its own DB subnet group, its own
security group with no egress and a single ingress rule from the verifier. A
drill that restored production's data into the application's security group would
have left a stale, writable copy of the database one connection-string typo away
from live traffic, once a month.

### What it does not cover

* **No queries run against the copy.** There is no PostgreSQL client in this
  repository — `lambda.Code.fromInline` is how every function here ships, and a
  driver means bundling — so the drill cannot `SELECT` anything. The two checks
  that would have been queries are replaced in §14 by two that reach the same
  findings from outside the engine. What stays out of reach is anything about
  *specific* data: a table that came back empty while the volume came back full,
  a constraint that did not survive, a sequence that is behind.
* **The restore is to the latest restorable point, never to a chosen second.**
  Which is the easy half of a point-in-time restore. The hard half of a real
  recovery is deciding *which* second — the one before the bad migration — and
  the drill deliberately does not rehearse that, because a fixed or
  operator-supplied timestamp is a second thing that can be stale and wrong, and
  when it is, the drill restores a copy from a point nobody asked for and
  verifies it happily.
* **There is no cutover.** The drill proves a copy can be produced and is the
  data. It does not redirect the application at it, which is the rest of the
  1800 seconds and is where a real recovery's surprises live: the endpoint name,
  the connection pool, the migration state the application expects.
* **Static parameters land `pending-reboot`.** The copy comes up with the
  source's parameter group, and a static parameter such as
  `shared_preload_libraries` is not in effect until a reboot. That is also true
  of a real recovery, and seeing it in a drill is better than discovering it
  during one — but the drill does not reboot the copy, so the verified instance
  is not running those parameters.

---

## 13. The drill nobody has to approve

This is the one exercise in the repository that **runs on a schedule**, and it is
worth being explicit about why, because §7 says the opposite about the failover
and both are right.

A forced failover reboots a live primary. Connections fail, `<env>-db-connect-failing`
pages, and the only thing that makes it safe is that a human looked at the
environment and said now. So that document begins with `aws:approve` and nothing
can start it on a timer.

A point-in-time restore injects nothing. It reads the automated backups into a
second instance and never touches the live one. The reasoning inverts: there is
nothing for a human to weigh, and a restore drill behind a human gate is a
restore drill that runs once, in the week the item shipped. §3 of this document
carried an unmeasured RTO for a whole spec item; behind an approval it would have
stayed unmeasured.

The distinction is **data rather than convention**, in `lib/game-days.ts`:

* `DESTRUCTIVE_FAULTS` lists the faults that change something live.
* `GameDayScenario.trigger` is `'approval'` or `'schedule'`.
* `validateGameDayCatalogue` refuses a destructive fault whose trigger is not
  `approval`, a scheduled scenario with no `scheduleIntervalDays`, a cadence
  slower than the objective's `rehearsalIntervalDays`, and an approval-triggered
  scenario that declares a cadence nothing honours.

The last of those is worth a sentence. A drill every 60 days against a 30-day
shelf life means `<env>-rehearsal-overdue-rds-point-in-time-restore` is red for
half of every cycle, with nothing anybody can do about it except widen the
interval they just chose — which is how an alarm about a stale DR number acquires
a filter rule.

**`no-alarm-in-alarm-state` is deliberately not one of the drill's preflights.**
It is the check that most often refuses a *failover*, and refusing is right
there: a game day during an incident is not a game day. Here it would be a
monthly drill gated on an account-wide alarm prefix, which stops happening during
exactly the months when something is always red — the months you most want to
know the backups restore.

---

## 14. What the drill verifies

Seven checks, in this order, and the verdict is **unanimity**: any failure, or
any check that did not produce a result, is `failed`. There are no advisory
checks and no warnings, because every entry here is one the drill is worthless
without — and the first optional check is how a verification suite becomes a
dashboard nobody reads.

| Check | What it rules out |
|---|---|
| `instance-available` | nothing, on its own — and until this drill existed it was the whole of what most restore "tests" check. RDS reports `available` as soon as the engine starts, and an instance restored from a backup of an empty volume starts perfectly. |
| `not-publicly-accessible` | a full copy of production's data on a public endpoint. Asserted against the instance that exists, not against the request that was made, because those are different claims. |
| `storage-encrypted` | a copy of an encrypted source that is not encrypted. |
| `engine-negotiates-tls` | a port that answers without a database behind it. The verifier sends PostgreSQL's own eight-byte `SSLRequest` and requires an `S` back, which every backend answers before any session exists — so a listener with no postmaster fails here while passing a TCP connect, and an instance still replaying WAL does not get this far either. |
| `certificate-names-the-instance` | "something answered". The certificate the engine presents has to name the endpoint the drill restored. |
| `restored-bytes-match-source` | **the restore that completed and brought back nothing.** This is the replacement for the query nobody can run here, and it is the most important check in the table. `FreeStorageSpace` is published by RDS for both instances, once a minute; used bytes are computed from each one's own `AllocatedStorage`, and the copy has to be within 20% of the source. An empty database against a populated one is not a near miss — it is one to two orders of magnitude. |
| `restore-point-not-stale` | a copy from a point nobody asked for. The restored instance's `InstanceCreateTime` must be at most two RPOs after the `LatestRestorableTime` the preflight read, so the two bracket the point the data is from. This is the failure a point-in-time restore exists to avoid: you restore to a second before the bad migration and get the bad migration, and every other check in this table passes. |

**The TLS chain is not validated, on purpose.** RDS serves certificates from
Amazon's own CAs, which are in no default trust store. The three ways to validate
the chain were each worse than not doing it: pinning the PEM puts a 60 KB
certificate blob in copy-paste material and a rotation deadline in somebody
else's calendar; fetching the bundle at run time puts an internet dependency on
the path of the thing that verifies the backups; and a parameter group with
`rds.force_ssl = 0` turns the encryption off on a copy of production rather than
checking it. What the connection is for is the identity check in the row below
it, which does not need a chain — nothing is sent to the engine past the
handshake and nothing is read from it but the certificate. The reason travels
with the result: `RESTORE_TLS_CHAIN_UNVERIFIED` is quoted in the check's own
detail string.

**A missing `FreeStorageSpace` datapoint is a failure, not a pass.** RDS
publishes it a minute or two after the instance reports `available`, so the
obvious implementation reads once, finds nothing, and skips the only check that
can see an empty restore — on exactly the drills that ran fastest. The verifier
polls for five minutes and fails the check if it still has nothing.

### A failed verification is a successful execution

The drill has to delete its copy whatever it finds, so the SSM execution ends
green even when the copy is unusable. **The execution's status is not the
signal.** Three things are:

1. `RestoreVerified` is published as `0`, and `<env>-restore-unverified` goes red.
2. The record in `/<env>/game-day/rds-point-in-time-restore/last-rehearsal` holds
   `lastAttempt.checksFailed`, with the detail each failing check reported.
3. **The rehearsal clock is not reset.** `lastMeasured` is only moved by a
   verified drill, so `<env>-rehearsal-overdue-rds-point-in-time-restore` stays
   exactly as red as it was — there is still no verified restore for this
   objective, which is true.

`MeasuredRestoreSeconds` is published only for a verified copy. A restore time
for a copy that came back wrong is a number about how long it took to produce
something unusable, and on a graph next to the objective it is indistinguishable
from a good result.

---

## 15. The copy that outlives the drill

Every step in the drill routes its failure to an abort step whose first act —
before the record, before reading the execution to find out what went wrong,
before notifying anybody — is to delete the copy. A failure to explain an abort
is a worse record. A failure to delete the copy is a bill.

There is still one path that leaves a full-size copy of the database running, and
it is a human: **SSM does not run a step's `onFailure` for a *cancelled*
execution.** Somebody stopping a drill between the restore and the teardown
leaves `<env>-dr-drill` up with nothing that would ever remove it. That copy is
the quietest failure in this item — it serves no traffic, breaches no threshold,
has no alarms of its own, and looks exactly like a database somebody meant to
create.

So there is a sweeper, hourly:

* It publishes `DrillInstanceAgeSeconds`, and **publishes zero when there is no
  copy.** The obvious implementation publishes nothing, which makes "no copy" and
  "the sweeper has stopped" identical on the graph — and the second is the state
  in which an orphan runs forever. Publishing zero lets
  `<env>-restore-drill-instance-orphaned` breach on missing data, so the
  sweeper's own silence pages.
* Past six hours — against a drill that takes about forty-five minutes — it
  deletes the copy, **unless an execution of the drill document is
  `InProgress`.** Without that check the one thing worse than an orphan becomes
  possible: a copy deleted out from under a verification that was still running,
  reported as a restore that could not be verified, sending somebody to look at
  the backups.
* Both deletes — the sweeper's and the conductor's teardown — pass
  `DeleteAutomatedBackups: true`. Without it RDS keeps the deleted copy's
  automated backups for the source's retention period, so every drill leaves a
  month of a full copy of production's data somewhere nobody is looking and
  nothing is alarming on.

Every grant that can delete a database in this repository is scoped to one
literal ARN, `db:<env>-dr-drill`, which is why the drill identifier is a fixed
name rather than one with an execution id in it. With a generated name the grant
would have to be a prefix at best, and the difference between a prefix and a name
is the difference between "can delete the drill copy" and "can delete anything
somebody names like one". The drill's *automation* role — the identity an
EventBridge schedule hands to SSM unattended — holds no delete at all.

---

## 16. Known gaps

* **Nothing has been deployed.** No failover has been forced and no restore has
  been performed in a real account, so no RTO in this document has been observed
  — the 120 seconds in §2 and the 1800 in §3 are objectives and not
  measurements, and the first exercise of either may well miss. Every number in
  §9 is a list price rather than a bill.
* **The drill's own contracts are unverified against SSM**, in the same way §2's
  are. `aws:executeAwsApi` is given `RestoreDBInstanceToPointInTime` with
  booleans the schema types loosely, the verify step reads
  `{{ preflight.restorePoint }}` out of a `Payload` the schema types as a string
  map, and the `rate(30 days)` EventBridge target points at an
  `automation-definition/<name>:$DEFAULT` ARN. If any of them is wrong the step
  fails at resolution and the drill routes to its abort, which deletes the copy
  and records the reason — loud, on the first run, in staging — but none has
  been run against SSM.
* **The probe measures a TCP connection, not a query.** It answers "is the port
  answering", which is the failure a promotion produces, and it would not see a
  database that accepts connections and refuses to write — a read-only replica
  promoted into the wrong role, a full disk. That needs a client library in the
  probe, which means bundling, which this repository does not do. The drill's
  `engine-negotiates-tls` check (§14) is the nearest thing available without one,
  and it is not available to the probe: it is a handshake per invocation, which
  is far too much to do six times a minute forever.
* **The restore drill does not query the copy**, so "the volume came back full"
  stands in for "the data came back". A table that is empty inside a volume that
  is the right size, a constraint that did not survive, a sequence that is
  behind: none of those is visible here. See §12 and §14 — it needs a client
  library, which means bundling, which this repository does not do.
* **The restore drill rehearses the easy half.** It restores to the latest
  restorable point and never to a chosen second, and it does not cut anything
  over to the copy. The rest of the 1800 seconds is the part a real recovery
  finds surprising.
* **The RPO of §2 is asserted, not measured.** Zero data loss is a property of a
  synchronous commit, and observing it from outside the engine is not something
  this probe or any other can do. What is enforced instead is that only a
  synchronous basis may claim zero.
* **One fault kind.** A forced failover is not an AZ outage: the subnets, the NAT
  gateway and the tasks in that AZ all stay up. AWS FIS templates are the spec
  item after next, and an AZ-level fault is where the interesting caller-side
  failures actually live.
* **Nothing schedules the *failover* exercise.** By design — `aws:approve` exists
  so that a machine cannot start one — but it means the overdue alarm is the only
  thing that makes that rehearsal happen, and it is a ticket rather than a page.
  The restore drill is the counter-example and the argument for the distinction:
  §13.
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
