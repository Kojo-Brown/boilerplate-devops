# Chaos engineering with AWS FIS

Three experiment templates, one per fault the architecture in this repository
implicitly claims to tolerate: a task disappears, the network gets slow, an
Availability Zone is cut off. They are built by
[`aws/cdk/lib/chaos-fis-stack.ts`](../aws/cdk/lib/chaos-fis-stack.ts) from the
catalogue in [`aws/cdk/lib/fis-experiments.ts`](../aws/cdk/lib/fis-experiments.ts),
and `npm run audit:chaos` holds both to the rules in §6.

## 1. Why these are not game days

`FailoverGameDayStack` and `BackupRestoreDrillStack` already exercise two
recovery paths, and they are not the same kind of thing as what is here.

A game day rehearses a **mechanism we believe in**: force a Multi-AZ promotion
and measure how long the caller is unserved; restore a copy from backups and
measure how long that takes. The procedure is known, the outcome is a number, and
the thing being tested is whether the number is still what `docs/game-days.md`
says it is.

A chaos experiment asks whether the application survives a fault **nobody wrote a
procedure for**. There is no mechanism to rehearse. The output is not a number,
it is a hypothesis that survived or did not — which is why every entry in the
catalogue carries a `hypothesis` field stating what would refute it. "The system
is resilient" is not a hypothesis; an experiment with no stated expectation
cannot fail, so whatever happens gets written up as a learning and nothing is
decided.

Nothing here is scheduled. The templates are inert until somebody calls
`StartExperiment`, which is the same line `lib/game-days.ts` draws for a
destructive fault: an `aws:ecs:stop-task` experiment on a cron is an outage
nobody chose, arriving at the traffic peak because that is when the cron fired.

Start one with:

```bash
aws fis start-experiment \
  --experiment-template-id "$(aws cloudformation describe-stacks \
      --stack-name ChaosFisStack-Staging \
      --query "Stacks[0].Outputs[?ExportName=='staging-chaos-ecs-task-loss-template-id'].OutputValue" \
      --output text)"
```

Target resolution and the timeline land in `/aws/fis/<env>-chaos-experiments`.
Read them before writing anything up: which AZ the stopped task was in, and which
AZ its replacement landed in, is the difference between a result about the
service and a result about the AZ layout.

## 2. A task disappears

**Fault.** `aws:ecs:stop-task`, `COUNT(1)` of the service's two tasks.
**Duration.** Instantaneous; the recovery is what takes time.

**Hypothesis.** Stopping one of the two tasks is absorbed by the remaining task
and by the deployment controller replacing it: the load balancer drains the
stopped target rather than serving it, no 5XX reaches a caller, and the
replacement is healthy inside one deregistration delay. Refuted by any
ELB-generated 5XX, or by a replacement that does not pass its health check.

`COUNT(1)` rather than `PERCENT(50)`, which resolves to the same one task today.
The difference is what happens after somebody raises `desiredCount`: the
percentage silently becomes a bigger fault, and the count stays the experiment
that was signed off on.

## 3. The network gets slow rather than broken

**Fault.** `aws:ecs:task-network-latency`, 200 ms added to egress, `COUNT(1)` of
two tasks.
**Duration.** `PT5M`.

**Hypothesis.** Two hundred milliseconds of added egress latency degrades
response times and nothing else: no request fails, the connection pool does not
saturate, and the health check — which crosses the same interface — keeps
passing. Refuted by a target 5XX, by an unhealthy target, or by latency that
outlasts the fault, which means a queue that did not drain.

This is the failure mode that looks like health. A dependency that is **absent**
trips every circuit breaker in the stack; one that is merely **slow** is answered
by every health check, reported as available by every dashboard, and fills the
pool behind it until the pool is the outage. Two hundred milliseconds is FIS's
own default and is well inside every timeout here — the interesting number is the
one at which the hypothesis starts failing, and finding it means running this
again with a larger delay.

See §5 for what this experiment needs from `EcsStack`, which is the part of it
most likely to quietly stop being true.

## 4. An Availability Zone is cut off

**Fault.** `aws:network:disrupt-connectivity`, `scope: availability-zone`, over
every subnet of one AZ.
**Duration.** `PT10M`. **Staging only.**

**Hypothesis.** Partitioning one AZ from the others leaves the application served
from the surviving AZ: the load balancer stops sending to targets it can no
longer reach, the database either was not in the partitioned AZ or is promoted
out of it, and the probe keeps connecting. Refuted by the probe losing the
database for longer than the promotion RTO in
[docs/game-days.md](./game-days.md), or by sustained ELB 5XX from the surviving
AZ.

Three decisions in this one are worth stating, because each has a plausible
alternative that makes the experiment mean something else.

**`availability-zone`, not `all`.** The action also accepts `all`, which denies
everything to and from the subnet rather than only traffic crossing an AZ
boundary. That is the harsher experiment and it is not the one to run first: a
subnet denied everything cannot be reached by the game-day probe either, so the
measurement goes dark along with the application and the result is
indistinguishable from the experiment having broken the measurement.
`availability-zone` leaves intra-AZ traffic alone, which keeps "did the surviving
AZ serve the application" answerable. The scopes FIS also accepts — `s3`,
`dynamodb`, `prefix-list` — are dependency-isolation experiments, and the
catalogue refuses them on an experiment labelled as this one is.

**Every subnet of one AZ, listed explicitly.** The shape most examples use is
`resourceTags` plus `selectionMode: COUNT(1)`, and it selects *one subnet*: FIS
counts resources, and the resource type is a subnet. This VPC has a public and a
private subnet per AZ, so a template reading as "one Availability Zone"
partitions a quarter of the VPC — and which quarter is whatever FIS picked that
run, which cannot be compared with the last run. Leaving one subnet group
connected is also a different experiment: with the public subnet still reachable,
the load balancer node in that AZ stays advertised in DNS and keeps accepting
requests it can no longer serve.

**Staging only.** This is the one fault here that cannot be undone faster than
FIS's own rollback — the action creates a deny-all network ACL and re-associates
the target subnets with it for the duration, then puts the original association
back. A mistake in target selection is a production AZ off the air until the
experiment ends or somebody re-associates by hand. It graduates to production
when it has run in staging, which is a decision with a date on it rather than a
default.

## 5. What the latency experiment needs from this stack

`aws:ecs:task-network-latency` reaches inside a running task, and on Fargate that
needs **three** independent things to line up:

| Property | Where it lives |
| --- | --- |
| `useEcsFaultInjectionEndpoints: 'true'` on the action | `ChaosFisStack` |
| `pidMode: task` on the task definition | `EcsStack` |
| `enableFaultInjection: true` on the task definition | `EcsStack` |

Two of the three are in a stack this experiment does not own, which has its own
tests, none of which know the experiment exists. **Every combination of the three
deploys cleanly.** The service stays healthy, the experiment template still
synthesises, FIS still resolves the tasks, and the failure arrives when somebody
starts the experiment — during the exercise, in front of the people who booked
the hour. That is the entire reason `tools/audit-fis-experiments.ts` reads the
synthesised `EcsStack` template rather than trusting the catalogue.

Setting `pidMode` drags a fourth property in with it: CDK refuses a Fargate task
definition that sets `pidMode` without `runtimePlatform.operatingSystemFamily`,
and AWS only supports `pidMode: task` on Linux platform 1.4.0 or later. So the
task definition now states its platform explicitly, which was previously an
implicit default.

`enableFaultInjection` is the one with a cost attached, and it is worth being
explicit about: it lets a process inside the container reach the ECS
fault-injection endpoint. It is set in **every** environment rather than staging
only, because a task definition that differs in shape between environments means
the latency experiment is rehearsed against something other than what production
runs — which is the failure the experiment exists to rule out.

## 6. The guardrails, and the three ways they are decoration

An FIS experiment template requires `stopConditions` and accepts
`[{ source: 'none' }]`. Everything below is about that.

### 6.1 `none` is the default in every example

Including AWS's own CloudFormation sample for
`aws:network:disrupt-connectivity`, which ships `StopConditions: [{ Source:
'none' }]`. In review it reads as "no stop condition configured yet"; what it
means is that the fault runs its full declared duration whatever happens to the
application, in whichever account the template was copied into. The catalogue
refuses it and `audit:chaos` refuses it in the synthesised template, because the
catalogue cannot see a template somebody adds outside it.

### 6.2 A traffic-derived guardrail is weakest when you need it

The obvious stop condition is the ALB 5XX alarm `CloudWatchAlarmsStack` already
owns, and under load it is the best signal here — it counts responses the load
balancer generated itself, which is exactly what a tasks-all-gone fault produces.

With no load it counts nothing. All three faults **reduce** the requests that
reach a target, and a count of errors in an environment nobody is calling is zero
whether the application is healthy or on fire. Staging is quiet by construction
and production at 03:00 is quiet enough, and quiet is exactly when somebody
chooses to run a chaos experiment.

So every experiment carries at least one stop condition whose metric is published
**on a schedule**: `Platform/GameDay` `ConnectSuccess`, which
`FailoverGameDayStack`'s probe emits every minute whether or not anybody is
running anything. `TRAFFIC_INDEPENDENT_METRICS` in `lib/fis-experiments.ts` is
the list, and it is a table rather than a comment so that adding a stop condition
forces the question.

Two caveats, stated because they bound what this guardrail can do:

- The probe alarm's `treatMissingData` is `MISSING`, which holds the last known
  state rather than inventing one. If the probe itself stops during an
  experiment, the alarm stays in whatever state it was in rather than going red.
  `<env>-game-day-probe-silent` is the alarm for that and is **not** usable here:
  it breaches on missing data, so it reports the probe's health rather than the
  application's.
- The synthetic canaries would also qualify and are deliberately absent: they run
  in `SyntheticCanaryStack`'s own regions and aggregate in
  `canaryAggregationRegion`, and an FIS stop condition is an alarm ARN in the
  experiment's own region.

### 6.3 A guardrail slower than the experiment cannot fire

A CloudWatch alarm needs `period x evaluationPeriods` of agreement before it
changes state. `CloudWatchAlarmsStack`'s ALB alarms are five-minute periods over
two evaluations, so they cannot change state inside ten minutes — and a
five-minute experiment guarded only by one of them has a guardrail that is
guaranteed to still be evaluating when the fault ends.

Nothing about such a template looks wrong. The stop condition is present, the
alarm is real, the experiment completes, and the report says the fault was
tolerated. So every experiment's duration must clear the **fastest** stop
condition's detection window by a factor of `STOP_CONDITION_MARGIN` (two): one
window to notice the fault, one to act on it before the fault ends by itself.

It is the fastest rather than every one deliberately. At a ten-minute window the
ALB alarm cannot stop any experiment this catalogue is willing to declare, and
holding every condition to the margin would mean either dropping it — losing the
signal that actually fires under load — or declaring half-hour faults to
accommodate it.

The numbers the catalogue does this arithmetic against are a **copy** of
properties other stacks own, so `audit:chaos` reads the real `Period` and
`EvaluationPeriods` out of the synthesised alarms and reports
`stop-condition-window-drift` when they disagree. Raising `periodMinutes` in
`CloudWatchAlarmsStack` is otherwise a change with no diff here at all: the
arithmetic stays internally correct and starts being about an alarm that no
longer exists.

### 6.4 The blast radius is arithmetic, not a word in the description

`selectionMode: 'ALL'` against a service running two tasks is a total outage
described as an experiment — there is no survivor to observe, so the result is
"everything broke", which was knowable without running it. `PERCENT(25)` against
the same service is either one task or none, depending on a rounding rule the
template does not state: the experiment then starts, injects nothing, succeeds,
and produces a report saying the application was unaffected.

`resolvedTargetRange` computes the interval of target counts a selection mode can
produce — a range rather than a number, precisely because the rounding is not
something the template says — and the catalogue refuses a selection that can take
every member and one that can take none.

### 6.5 The AZ experiment inherits the VPC's NAT layout

`VpcStack` takes `natGateways`, defaulting to one per AZ but documented as "1
(cost-optimised)". With a single NAT gateway, every private subnet in the VPC
egresses through whichever AZ holds it. Partitioning **that** AZ is not an AZ
fault: it is a total loss of outbound connectivity for the whole application,
including from the AZ that was supposed to survive and serve.

The experiment then "fails", and the write-up records that the application does
not tolerate losing an AZ — a conclusion about `VpcStack`'s `natGateways` wearing
an answer to a question the experiment was not asking. `audit:chaos` counts NAT
gateways against AZs and reports `single-nat-gateway`.

## 7. The role

An FIS experiment template names a role FIS assumes, and whatever that role can
do is what a started experiment can do.

AWS publishes managed policies for exactly this —
`AWSFaultInjectionSimulatorNetworkAccess`, `...ECSAccess` — and they are what
every tutorial attaches. They are also account-wide:
`AWSFaultInjectionSimulatorECSAccess` permits `ecs:StopTask` against every task
in the account, which makes the experiment template's target selection the only
thing standing between the role and another team's cluster — and target selection
is editable in the console by anyone who can reach the template.

So the policies are written out and scoped: `ecs:StopTask` to this cluster's
tasks, the log writes to this stack's own log group, the network ACL calls to
this account and region. Two statements genuinely cannot name a resource, and
both are conditioned rather than left open:

- `ec2:CreateNetworkAcl` creates the resource, so there is no ARN to name. The
  condition is `aws:RequestTag/managedByFIS`, which is the tag FIS puts on the
  ACL it creates. Without it this is "create any network ACL in the account",
  which is a resource a deny-all rule can be attached to and then associated with
  a subnet nobody is experimenting on.
- `ec2:CreateTags` is a privileged action in this repository's own IAM audit,
  because tags decide what other policies apply. The condition is
  `ec2:CreateAction: CreateNetworkAcl` — the tagging that happens as part of the
  create above, not a re-tag of something that already exists.

The `Describe*` statements on the VPC are `Resource: "*"` because those calls
take no resource in IAM's model. That is the documented wildcard `CLAUDE.md`
asks for: they read the layout FIS has to resolve the subnet target against, and
change nothing.

`ecs:DescribeTaskDefinition` is **not** among them. FIS reads the task definition
to establish that the latency fault may run — `PidMode` and
`EnableFaultInjection` are properties of the definition, not of the task — and a
task definition's response carries its containers' environment variables, so an
unscoped read here would be a read of every service's configuration in the
account. It is scoped to this account and region's task definitions; the
revision in the ARN is not knowable from this stack, which is the only reason
the resource is a pattern at all.

One grant is **deliberately absent**: `ssm:SendCommand` on AWS's `AWSFIS-Run-*`
documents. There are two ways FIS reaches inside an ECS task — the older one
registers the task as an SSM managed instance through an SSM-agent sidecar and
runs a document against it, and the newer one goes through the ECS
fault-injection endpoints, which is what the `aws:ecs:task-network-*` actions use
on Fargate and what `useEcsFaultInjectionEndpoints: 'true'` selects. This
repository's task definition has no SSM-agent sidecar, so the SSM path could not
work here even if the role permitted it, and granting it anyway would be
`ssm:SendCommand` against every managed instance in the account in exchange for a
capability nothing uses.

A future experiment on one of the other `aws:ecs:task` actions —
`task-cpu-stress`, `task-io-stress`, `task-kill-process` — needs both halves: the
sidecar in `EcsStack` and the grant here. It is a deliberate addition, not an
oversight.

One statement is deliberately **not** conditioned, and the asymmetry is the most
considered line in the stack. `ec2:ReplaceNetworkAclAssociation` both starts and
**ends** the AZ fault: FIS points the subnets at its deny-all ACL, and at the end
of the duration it points them back. The two directions do not see the same tags
— the ACL being associated on the way out is the VPC's original, which carries no
`managedByFIS` tag, and the subnet never carries one either. A tag condition here
is therefore a condition that can fail on the **rollback**, and a failed rollback
is not a failed experiment: it is one AZ of the VPC left behind a deny-all ACL
until somebody re-associates it by hand, which is the single worst outcome
anything in this stack can produce.

What the privilege actually is, bounded: re-point a subnet in this account and
region at an ACL that already exists. It adds nothing the role cannot already do
— it can create a deny-all ACL under the tag condition above and associate it —
and the role is assumable only by `fis.amazonaws.com`. The two calls that write
rules into an ACL and delete one *are* tag-conditioned, because neither has a
rollback direction to break.

## 8. Writing up a run

The log group holds what FIS did. What it cannot hold is whether the hypothesis
survived, which is the only output of an experiment.

1. **Name the hypothesis and whether it was refuted.** The catalogue states each
   one and what refutes it; copy both into the write-up before looking at
   anything, so the result is not fitted to the data afterwards.
2. **Record which targets resolved**, from the log group. A task-loss result is
   about the service; a task-loss result where the replacement landed in the same
   AZ is also about the AZ layout, and the two write-ups recommend different
   things.
3. **Record whether a stop condition fired.** An experiment that was stopped is a
   refuted hypothesis with a guardrail that worked, which is a better outcome
   than a completed experiment nobody was watching.
4. **If the hypothesis survived, raise the fault.** 200 ms that changed nothing
   is not a finding about the application; it is a finding about 200 ms. The
   interesting number is the one at which it starts failing.
5. **If it was refuted, the finding goes where the fix goes** — a postmortem if
   it was a surprise (`docs/postmortem.md`), a `SPEC.md` item if it was not.

## 9. Rules `npm run audit:chaos` enforces

Offline, over `cdk.out/*.template.json`, this doc and `.github/workflows/ci.yml`.
Catalogue rules (`validateChaosCatalogue`) also fail `cdk synth`.

| Rule | Failure it prevents |
| --- | --- |
| `stop-condition-none` | a template whose guardrail is FIS's `none` |
| `stop-conditions-all-traffic-dependent` | every guardrail derived from traffic the fault removes |
| `duration-within-detection-window` | a guardrail still evaluating when the fault ends |
| `stop-condition-window-drift` | the alarm's real window is not what the duration was sized against |
| `stop-condition-alarm-missing` | a declared guardrail no stack creates |
| `selection-takes-every-target` | a total outage described as an experiment |
| `selection-may-resolve-no-targets` | a fault that injects nothing and reports success |
| `target-selection-widened` | a template not carrying the selection the rules checked |
| `az-target-spans-azs` | a partition of the VPC from itself, with no AZ left to serve |
| `az-target-partial-az` | an AZ left half-connected, so its ALB node stays advertised |
| `single-nat-gateway` | an AZ experiment that is really a region-wide egress outage |
| `latency-endpoints-unset` | the action parameter without which the latency fault cannot run |
| `task-definition-pid-mode` | `PidMode` removed from `EcsStack` by an unrelated tidy-up |
| `task-definition-fault-injection` | `EnableFaultInjection` removed the same way |
| `action-target-key-wrong` | an action pointing at its target under a key it does not define |
| `experiment-without-logs` | a run with no record of which targets it resolved |
| `experiment-template-missing` | a catalogue entry that exists nowhere but the catalogue |
| `experiment-anchor-missing` | a template pointing at a section of this doc that is gone |
| `audit-not-run-in-ci` | every rule above becoming a test nobody runs |
