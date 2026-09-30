# Runbooks: the alert carries the procedure, and its first step has already run

Every alarm in this repository reaches a topic. Until `RunbookStack` existed,
what arrived on that topic was an alarm name, a threshold and a state — and for
the SLO alarms only, a link to `docs/slo.md#7-responding-to-a-burn-rate-alert`,
whose first instruction is "open the `<env>-slo` dashboard".

Both are the same failure at different depths. A responder woken at 04:00 with a
link is a responder who now has to find a laptop, pick an account, pick a region
and know which of the nine dashboards is meant before they learn anything at all.
The link is not wrong. It is just not a step.

So each entry in `lib/runbooks.ts` declares a **first step**: a read-only SSM
Automation document that `RunbookStack` creates and that its enricher *starts*
when the alarm fires. The alert that arrives carries the runbook, the first
step's one-line summary, and the id of the execution already running. The first
human action is reading an answer rather than gathering one.

---

## 1. How it fits together

```
alarm → SNS (the topics that already existed)
           ├─ the subscribers that were already there — unchanged
           └─ runbook enricher (Lambda)
                ├─ match alarm name → runbook          lib/runbooks.ts
                ├─ ssm:StartAutomationExecution        the first step
                └─ SNS <env>-runbook-alerts            the rota
```

Three properties of that diagram are the design, and each was chosen against a
specific way this goes wrong.

**The enricher is subscribed alongside the existing subscribers, not put in
front of them.** A relay in the delivery path is a single point of failure on
the path that reports failures. Here the raw notification still arrives wherever
it always arrived; the enriched copy is a second, better one. An enricher that
is broken, throttled or mid-deployment costs a link, never a page. Adopting this
is therefore additive: subscribe the rota to `<env>-runbook-alerts`, watch it for
a week, and remove the old subscriptions only once the enriched copy has been
seen working.

**The first step runs itself.** Starting a read-only automation is something a
machine can do in the two hundred milliseconds between the alarm and the phone
buzzing, and it is the part of the first ten minutes that is pure latency.

**The first step cannot change anything.** Every document is a single
`aws:executeAwsApi` step on a `Describe`, `Get` or `List` call, running under a
role that holds only those reads, and `npm run audit:runbooks` refuses any other
verb. A one-click "restart the service" attached to a page is a way to turn a
degraded service into an outage while still half asleep. Remediation in this
repository lives behind a decision — `RollbackAutomationStack` and
`SloBurnRateRollbackStack` — and that is where it stays.

The runbooks below are the sections the alerts link to. Each one names the first
step the enricher will already have started by the time it is read.

---

## 2. The API is returning 5xx

**Alarms:** `*-alb-5xx-elb`, `*-alb-5xx-target`, `*-canary-5xx`, `*-canary-latency`
**Owner:** platform-team
**First step (already running):** `<env>-rb-ecs-service-state` — running against
desired task count, and any deployment in progress.

1. **Read the first step's output.** `RunningCount` below `DesiredCount` with a
   deployment in `deployments` is a rollout that is failing health checks, and
   the answer is the rollout, not the application. `RunningCount` at
   `DesiredCount` with no deployment means the tasks are up and the errors are
   inside them.
2. **Split ELB 5xx from target 5xx.** `*-alb-5xx-elb` counts responses the load
   balancer generated because it had nowhere to send the request — 502, 503,
   504. `*-alb-5xx-target` counts responses the application produced. The first
   is an infrastructure answer, the second is a code answer, and they are
   different alarms for that reason. See `docs/slo.md` §1.
3. **Check whether a deployment is in flight.** `docs/dora-metrics.md` has the
   deployment record; `BlueGreenDeployStack` and `CanaryDeployStack` roll back on
   their own alarms, so a canary alarm firing may already be self-resolving.
4. **Mitigate before diagnosing** if an error budget is going — see §4.

---

## 3. ECS tasks are saturated

**Alarms:** `*-ecs-cpu-high`, `*-ecs-memory-high`
**Owner:** platform-team
**First step (already running):** `<env>-rb-ecs-service-state`.

1. **Read the task counts first.** Saturation at a reduced `RunningCount` is
   usually a consequence, not a cause: tasks are being killed, and the survivors
   are carrying the traffic.
2. **Memory is not CPU.** A memory alarm that climbs monotonically between
   deployments is a leak and will not recover on its own; CPU tracks traffic and
   usually does.
3. **Nothing has failed yet.** This alarm fires before the 5xx one does, which
   is the whole reason it exists — scaling out now is cheaper than a §2 page in
   twenty minutes.

---

## 4. An error budget is burning

**Alarms:** `*-burn-fast`, `*-burn-medium`, `*-burn-slow`, `*-slo-burn-rate-*`,
`*-budget-low`, `*-budget-exhausted`, `*-availability-no-data`
**Owner:** platform-team
**First step (already running):** `<env>-rb-environment-alarm-state` — every
alarm in this environment currently in ALARM.

1. **Read the blast radius before the objective.** One SLO burning and nothing
   else red is a service problem. The same page with nine other alarms is an
   infrastructure problem, and the SLO is a symptom.
2. **Then read the budget, not just the alarm.** `ErrorBudgetRemainingPercent`
   on the `<env>-slo` dashboard decides how much room there is to investigate
   rather than mitigate: a `fast` page at 80% remaining is a different situation
   from the same page at 5%.
3. **Attribute it.** Did anything deploy inside the long window? The
   `<env>-slo-burn-rate-rollback` handler uses a 120-minute attribution window
   for the same reason.
4. **Mitigate before diagnosing** if the budget is going: roll back, disable the
   flag (`docs/feature-flags.md`), or shed load.
5. **A `slow` ticket is not an outage** and `*-budget-exhausted` is a release
   decision rather than an alarm to acknowledge. `docs/slo.md` §7 has the full
   reasoning behind both, and the arithmetic behind all of them.
6. **`*-availability-no-data` is never "the service is quiet."** Until it
   clears, every other alarm on that objective is reading a stale datapoint or
   none.

---

## 5. The database is running out of connections

**Alarms:** `*-rds-connections-high`
**Owner:** platform-team
**First step (already running):** `<env>-rb-rds-instance-state` — class, status,
Multi-AZ, and any pending modification.

1. **Read the instance class.** The connection ceiling is a function of it, so
   "how close to the limit" is not answerable without it. A `PendingModifiedValues`
   that is not empty means a change is queued and may apply at the next
   maintenance window, during which connections drop.
2. **A status that is not `available`** — `modifying`, `failing-over`,
   `storage-full` — is the answer, and the connection count is the symptom.
3. **Then look for the source.** A connection count that stepped rather than
   climbed is a deployment that changed a pool size; one that climbs steadily
   between deployments is a leak. `docs/expand-contract-migrations.md` covers the
   third case, a migration holding a lock.

---

## 6. The log pipeline is dropping or leaking records

**Alarms:** `*-log-pipeline-*`, `*-log-scrubber-failing`
**Owner:** platform-team
**First step (already running):** `<env>-rb-log-delivery-state` — the delivery
stream's status, destination, and whether a processor is attached.

1. **Check that a processor is attached at all.** A destination with no
   processor is the default shape of every Firehose example, and it is also the
   shape of an archive receiving unscrubbed records. `docs/log-pipeline.md` §3
   has the contract.
2. **Distinguish dropped from delayed.** `*-delivery-backlog` is delay and
   usually recovers; `*-records-dropped` and `*-oversize-dropped` are loss and do
   not.
3. **`*-log-pipeline-silent` is the serious one.** No records at all reads as a
   healthy pipeline on every delivery metric there is.
4. **`*-tokenization-unavailable` means records are arriving unscrubbed or not
   at all**, depending on the failure mode configured. Treat it as a data
   incident, not an availability one.

---

## 7. The synthetic canaries cannot reach the service

**Alarms:** `*-canary-health-*`, `*-canary-home-*`, `*-health-*-failed`,
`*-home-*-failed`
**Owner:** platform-team
**First step (already running):** `<env>-rb-environment-alarm-state`.

1. **Quorum or one region?** A `*-quorum` alarm means several probing regions
   agree and the service is unreachable from outside. A single
   `*-<region>-failed` ticket is one region's view and is as likely to be that
   region as the service.
2. **The canaries see what nothing inside the account sees:** DNS, the
   certificate, the CDN and the WAF. If §2's alarms are quiet and these are not,
   the fault is in front of the load balancer — start with the certificate
   expiry and the DNS record.
3. **A `*-silent` alarm is not a failure, it is an absence.** The canary stopped
   running: check the canary's own state before reading anything into the
   probes' results. `docs/synthetic-canaries.md` §5 covers it.

---

## 8. The WAF is blocking an unusual number of requests

**Alarms:** `*-waf-blocked-requests`
**Owner:** security-team
**First step (already running):** `<env>-rb-alarm-history` — this alarm's own
state transitions.

1. **Spike or new normal?** This is the one alarm here whose healthy value is
   not zero, so the history is the first thing that matters. A threshold that
   has been crossing daily since a traffic pattern changed is a threshold
   problem.
2. **Sample the blocked requests.** This is manual:
   `aws wafv2 get-sampled-requests` needs a `TimeWindow`, which is a structure
   an SSM document parameter cannot carry a default for, so it is not part of
   the automated first step.
3. **One client or many?** A single source address is a scanner and is being
   handled correctly. A distributed pattern against one path is worth paging
   someone about; blocked-at-the-WAF is the system working, and the question is
   whether the rate limit ahead of it is set correctly.

---

## 9. A platform component has stopped reporting

**Alarms:** `*-slo-budget-reporter-errors`, `*-runbook-enricher-errors`,
`*lead-time-unmeasurable`, `*expired-feature-flags`, `*unreadable-flag-manifest`,
`*-game-day-*`, `*-rehearsal-overdue-*`
**Owner:** platform-team
**First step (already running):** `<env>-rb-alarm-history`.

These are tickets, not pages. Each one means a signal above it is now reading
stale data or none, which is why they are alarmed on at all.

1. **How long has it been broken?** The alarm history answers that before the
   logs do, and it is the thing that decides whether this is worth interrupting
   anyone for.
2. **`*-slo-budget-reporter-errors`** means `ErrorBudgetRemainingPercent` is
   stale. Every release decision quoting it is quoting a number from before the
   failure.
3. **`*-runbook-enricher-errors`** means this system is the broken one. Alerts
   are still being delivered to the topics they were always delivered to; what
   has stopped is the link and the first step. Check
   `<env>-runbook-enricher-dlq` — anything in it is a notification that reached
   nobody. This alarm publishes to `<env>-runbook-alerts` **unenriched**, on
   purpose: the component that would enrich it is the one that failed, so an
   alert on that topic with no runbook attached is itself the signal.
4. **The feature-flag alarms** are described in `docs/feature-flags.md`; an
   unreadable manifest means the sweep is no longer removing anything.
5. **`*-game-day-probe-silent`** means the recovery objectives have no
   measurement behind them from now on. Nothing is known to be broken; what has
   broken is the ability to find out, and a game day run while this is red
   produces a record from a window with holes in it. `docs/game-days.md` §4.
6. **`*-rehearsal-overdue-*`** is not an outage and is not urgent this hour. It
   means an RTO in `lib/game-days.ts` is now a number from the last time
   somebody checked, and the fix is to schedule the exercise — not to widen the
   interval, which is the version of this that gets done instead.
7. **`*-game-day-endpoint-unresolvable`** is the one here that is not a ticket.
   During a promotion the endpoint record changes and keeps resolving; a name
   that resolves to nothing is a deleted instance, a deleted hosted zone, or a
   VPC that has lost DNS resolution, and a failover fixes none of them.

---

## 10. The database is unreachable, or its restore point has stopped advancing

**Alarms:** `*-db-connect-failing`, `*-restore-point-stale`
**Owner:** platform-team
**First step (already running):** `<env>-rb-rds-instance-state` — class, status,
Multi-AZ, and any pending modification.

**First, is a game day running?** `*-db-connect-failing` is the alarm a
Multi-AZ exercise is supposed to trip, and it is expected to be red for about
two minutes during one. Check `<env>-game-day` for an approval or a measurement
in the last half hour before treating this as an incident —
`docs/game-days.md` §6.

1. **`*-db-connect-failing` outside an exercise** means nothing in the VPC can
   open a socket to the endpoint. A status of `failing-over` is a promotion in
   progress and the right action is to wait: the probe recovers on its own and
   the measured outage is worth reading afterwards. A status of `available` with
   the probe still failing is the caller-side failure this whole item exists
   for — a pool holding connections to the address the endpoint used to resolve
   to, or a security group that no longer permits the subnet the promoted
   instance came up in.
2. **`*-game-day-endpoint-unresolvable` alongside it** narrows it to DNS and
   takes the database itself out of the picture.
3. **`*-restore-point-stale` is not an availability problem.** The instance is
   healthy, the backups are "enabled", and what has changed is that the data a
   point-in-time restore could recover is getting older. It is the only signal
   here that goes wrong with nothing failing. Check `BackupRetentionPeriod` is
   not zero — a retention of zero has no `LatestRestorableTime` at all, and the
   alarm breaches on the missing datapoint rather than on a large one — then
   check for a storage-full or a suspended-automated-backups condition.
4. **Both together** is an instance that is both down and unrestorable. Escalate
   before diagnosing further; `docs/game-days.md` §3 has the restore path and is
   explicit that its RTO has never been measured.

---

## 11. When the incident ends

A runbook's job finishes when the page clears. The next runbook being better
than this one is a separate piece of work, and it happens on Thursday afternoon
or not at all.

Which incidents owe a write-up is a fact about the incident rather than a
judgement made at the end of a long night —
[docs/postmortem.md#2-which-incidents-owe-one](./postmortem.md#2-which-incidents-owe-one)
is the trigger table. Every runbook above is named in one of its severity rows —
`npm run audit:postmortems` fails on one that is not — so an alarm that reached
you through this document has already been classified by the time it clears.

Two of the review's ten questions are about this file specifically: whether the
runbook worked, and whether it has been corrected. The gap between what the
runbook said and what actually helped is free to collect for a few days after an
incident and impossible afterwards, so the correction goes into
`lib/runbooks.ts` and this document while the incident is still fresh —
[docs/postmortem.md#7-the-blameless-review-checklist](./postmortem.md#7-the-blameless-review-checklist).

---

## 12. Adding a runbook

1. Add a section to this file. The heading's GitHub slug is the anchor.
2. Add an entry to `RUNBOOK_CATALOGUE` in `lib/runbooks.ts` with that anchor and
   the alarm-name patterns it answers for.
3. If its first step needs a read the existing documents do not make, add a
   `DocumentSpec` to `documentSpecs()` in `lib/runbook-stack.ts`. Every parameter
   needs a default, unless it is one the enricher fills from the notification —
   which today is `AlarmName` and nothing else, because a composite alarm's SNS
   message carries no metric, no namespace and no dimensions.
4. `npm run audit:runbooks` (after `npx cdk synth`) checks all of it.

---

## 13. The failures, and what each one looks like

| Rule | What it catches | What it looks like without the gate |
| --- | --- | --- |
| `alarm-without-runbook` | an alarm that wakes someone and matches no entry | a page with a threshold on it |
| `alarm-matches-two-runbooks` | two entries claim one alarm | a page carrying a confidently wrong procedure |
| `runbook-without-alarms` | an entry no alarm reaches | documentation shaped like coverage |
| `runbook-anchor-missing` | a renamed heading | GitHub answers 200 and lands on someone else's runbook |
| `first-step-document-missing` | a first step naming a document nobody creates | a console link discovered to 404 during an incident |
| `first-step-action-not-a-read` | a step that is not one `aws:executeAwsApi` call | code in a first step, reviewed as documentation |
| `first-step-not-read-only` | a verb that is not Describe/Get/List | one-click remediation attached to a page |
| `first-step-parameter-unfillable` | a parameter with no default the enricher cannot supply | a form where a step should be |
| `first-step-default-placeholder` | an empty or placeholder default | the execution fails on a resource that does not exist |
| `alarm-topic-without-enricher` | an alarm on a topic nothing enriches | everything works and nothing is connected |
| `exemption-matches-no-topic` | a hole held open for a topic that is gone | the next topic named close enough falls through |
| `enricher-without-dead-letter` | failed notifications dropped | no record that an alert reached nobody |

---

## 14. Known gaps

- **Nothing here has been deployed.** No automation in this repository has run
  against a real account, so the documents are checked for shape — a single
  read-only call whose parameters are all supplied — and not for output. The
  selectors in `documentSpecs()` are read off the API shapes, not off a response.
- **The per-region canary topics are not enriched.** An SNS topic delivers only
  to a Lambda in its own region, and the fleet aggregates in `eu-west-1` by
  default while `RunbookStack` lives in the primary region. The quorum topics —
  which are what pages — are subscribed automatically when the two regions
  match; the per-region ticket topics are exempted in `ENRICHMENT_EXEMPTIONS`
  with that reason. Enriching those needs a `RunbookStack` per probing region.
- **The enricher matches on alarm name alone.** It is the one field present in
  both a metric alarm's and a composite alarm's notification. Matching on
  dimensions would be more precise and would silently stop working for every
  composite alarm, which is ten of the ones that page.
- **A first step is one call.** Several of these runbooks would be better served
  by two or three reads, and `aws:executeAwsApi` composes fine. One is a
  deliberate floor rather than a limit: the rule that keeps a first step from
  growing into an unreviewed remediation script is easier to hold at one step
  than at "a few".
- **Alarm descriptions are unchanged.** The runbook reaches the responder
  through the enriched notification, not through the alarm's own description, so
  a responder reading the alarm in the CloudWatch console still sees what they
  saw before. Putting the link in both would mean twelve stacks importing the
  catalogue.
