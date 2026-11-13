# Cost allocation: the SCP that enforces tagging, and the dashboard that says whether it worked

This repository already had a tagging gate. `policy/cloudformation/tags.rego`
holds every resource in `cdk.out/` to `ManagedBy` and `Stack`, fails the build
when one is missing, and has done so since the policy pack was introduced.

It governs exactly one population: the resources this CDK app creates. It is
silent about the console, about another team's pipeline, about a Terraform
workspace in the same account, and about everything that already existed — which
is the population a bill is actually made of.

An SCP is the half that covers the rest, and it is not a stronger rego pack. It
is a different mechanism with a narrower reach, and the headline is
uncomfortable:

> **An SCP cannot require a tag on a resource whose create API has no tag
> parameter.** `s3:CreateBucket` is one. So is `cloudfront:CreateDistribution`.
> A `Deny` conditioned on a missing `aws:RequestTag` on either of those denies
> *every* create, including the compliant one — so those actions cannot be in
> the policy at all, and the resources behind them are a permanent, visible
> share of the untagged slice on the dashboard.

`lib/tagging-policy.ts` is the catalogue and the generator.
`policy/organizations/` holds the two documents it generates.
`lib/cost-allocation-stack.ts` is the daily measurement.
`npm run audit:tagging` holds all of them to each other.

---

## 1. The two documents, and why neither is deployed from here

| File | What it is | Where it is attached |
| --- | --- | --- |
| `policy/organizations/tag-enforcement-scp.json` | Service control policy: denies a create that omits `ManagedBy` or `Stack`, denies a value outside the allowed set, denies removing a governed tag | The organization's **management** account, to the root or an OU |
| `policy/organizations/cost-allocation-tag-policy.json` | Organizations tag policy: declares the canonical spelling of each key and its closed value set | The same place |

Neither is a CloudFormation resource and neither is deployed by `cdk deploy`.
Both are attached in the management account, by hand or by a pipeline that runs
there. That is why they are checked in as files: the file is the artefact
somebody copies.

Both are **generated**. Run `npm run policy:organizations` after any change to
`lib/tagging-policy.ts` and commit the result; `npm run audit:tagging` fails when
the checked-in bytes are not what the catalogue generates today. A hand-edited
SCP is the failure that pair exists to prevent, and it is a quiet one: the file
still attaches, the catalogue still validates, and the two simply stop describing
the same organization.

### Attaching them

```bash
# From the management account, with credentials that can write Organizations policies.
aws organizations create-policy \
  --name tag-enforcement \
  --type SERVICE_CONTROL_POLICY \
  --description 'Deny untagged resource creation' \
  --content file://policy/organizations/tag-enforcement-scp.json

aws organizations create-policy \
  --name cost-allocation-tags \
  --type TAG_POLICY \
  --description 'Canonical spelling and values for cost allocation tags' \
  --content file://policy/organizations/cost-allocation-tag-policy.json

# Then attach each to the root or to an OU. Attach to a test OU first.
aws organizations attach-policy --policy-id <policy-id> --target-id <ou-id>
```

Both policy types must be **enabled** in the organization first
(`aws organizations enable-policy-type`), and the organization must have all
features enabled rather than consolidated billing only.

---

## 2. Four properties of an SCP that decide what it can enforce

**`aws:RequestTag` only exists on an API that accepts tags at create time.**
`lambda:CreateFunction` takes `Tags`; `s3:CreateBucket` does not — a bucket is
tagged by a separate `PutBucketTagging` call, so `aws:RequestTag/ManagedBy` is
absent from *every* `CreateBucket` request, compliant or not. `SCP_ACTION_CATALOGUE`
in `lib/tagging-policy.ts` records both halves: the actions that are enforced, and
the ones that cannot be, each with the reason. An action quietly left off a list
is indistinguishable from one nobody thought of, which is why the reason is
required by the validator.

**One `Null` block with two keys is an AND.** This:

```json
{ "Null": { "aws:RequestTag/ManagedBy": "true", "aws:RequestTag/Stack": "true" } }
```

denies a request missing *both* tags. Supplying either one passes. It reads as
"require both" and enforces "require at least one". Each required key therefore
gets a statement of its own, and `validateTaggingPolicy` reports
`conjoined-null-condition` on a document that merges them.

**There is no wildcard for tag removal.** IAM actions are `service:Action` and
the service prefix may not wildcard, so `*:Untag*` is not an action IAM accepts —
the policy is rejected at `CreatePolicy` time in the management account, where
nobody is looking at the change that introduced it. Each service also invented
its own name: `UntagResource`, `UntagQueue`, `RemoveTags`,
`RemoveTagsFromResource`, `DeleteTags`. They are listed per service, next to the
create action they belong with, and `invalid-action-format` is the rule that
catches the wildcard.

**An SCP is capped at 5,120 bytes.** That cap is what makes "just list every
create action" fail, and it fails at `AttachPolicy` time in the management
account — a long way from the change that grew the list. Every required tag key
repeats the whole action list once more, so the document grows with
*keys × actions*. The gate measures the document as written, which is never
smaller than what Organizations counts, so it fires before AWS would.

**An SCP never applies to the management account**, however it is attached, and
never to a service-linked role. Resources created in the management account are
untagged whatever this document says. That is not a hole to be closed; it is a
documented share of the untagged slice.

---

## 3. The tag catalogue

| Key | Enforcement | Cost allocation | Why |
| --- | --- | --- | --- |
| `ManagedBy` | denied on create | not activated | Says the resource belongs to a deployment tool and must not be edited in the console. Not a cost grouping: it separates tools, not spend |
| `Stack` | denied on create | not activated | Names the stack that would recreate it. Free-form by necessity, and a per-stack breakdown is already available through CloudFormation |
| `Environment` | value constrained | **activated** | `staging` / `production` / `preview`. Deliberately *not* required on create — see below |
| `Project` | advisory | **activated** | Applied by every stack through the stack `tags` prop, so a create-time deny would protect nothing here |
| `CostCenter` | advisory | **activated** | The same. The spelling is what is worth governing: `CostCentre` is a different key to both IAM and Cost Explorer |

`Environment` is value-constrained rather than required, and that matches the
rego pack exactly. Five stacks here are account-scoped — `AppConfigStack`,
`DoraMetricsStack`, `FeatureFlagLifecycleStack`, `RightSizingStack`, and now
`CostAllocationStack` itself — and carry no `Environment` tag because there is no
true value to give them. Inventing `shared` would read in Cost Explorer as a
fourth environment rather than as "spans all of them". So an absent `Environment`
is allowed and a misspelt one is not.

The two sets of allowed environment values — here and `allowed_environments` in
`policy/cloudformation/tags.rego` — are two copies of one fact, and
`environment-values-drift` is the rule that keeps them equal. A value in one list
only is either denied at create time after passing review, or accepted at create
time and reported as a fourth environment.

---

## 4. Activation is a separate act, and it is not retroactive

A tag key is only usable as a Cost Explorer grouping once it is **activated** in
Billing → Cost allocation tags. There is no CloudFormation resource for it; the
API is `ce:UpdateCostAllocationTagsStatus`, and the reporter's role deliberately
does not hold it — a role that could activate a tag could make its own coverage
metric go green.

Two consequences, and both of them look like something else:

* **An un-activated key is not an error.** Cost Explorer accepts the grouping and
  returns no groups. Every series renders flat at zero, which is exactly what a
  tag nobody spends against looks like. So activation is read first and alone,
  via `ce:ListCostAllocationTags`, and published as `TagActivated` — the same
  shape as the Compute Optimizer enrolment read in `docs/right-sizing.md`, for
  the same reason.

* **Activation is not retroactive.** A key activated today carries no data for
  last month and never will. A freshly activated key's widget is therefore
  *correct* and empty. The dashboard's text widget leads with this, because the
  alternative is a reader concluding the account spent nothing.

An account may activate at most 500 cost allocation tag keys, which is why
`Stack` is governed but not activated.

---

## 5. The dashboard, and the four things it measures

`CostAllocationStack` runs one Lambda a day. For each activated key it makes one
`ce:GetCostAndUsage` call grouped by that tag over a trailing window of whole
days, and publishes:

| Metric | Dimensions | What it answers |
| --- | --- | --- |
| `TagActivated` | `TagKey` | Does Billing have this key activated at all |
| `AttributedCost` | `TagKey`, `TagValue` | Spend carrying each declared value |
| `UnattributedCost` | `TagKey` | Spend carrying **no** value for this key |
| `UnattributedSharePercent` | `TagKey` | The untagged slice as a share of the window's total |
| `UnexpectedTagValue` | `TagKey` | How many values appeared that the catalogue does not declare |
| `ReportSuccess` | `Scope` | The report ran to completion |

Three details in there are load-bearing.

**The untagged bucket is the group `Environment$`** — the key, the separator, and
nothing. That is how Cost Explorer reports spend with no value for the grouping
tag. A reporter that treated an empty value as a parse failure and skipped it
would publish a dashboard on which 100% of cost is attributed. It is the one
series here that is supposed to shrink, so it gets its own metric and its own
alarm.

**A value nobody declared is counted, not dropped.** A CloudWatch widget names
its dimensions up front, so spend tagged `Environment=Prod` would appear in no
series *and* in no untagged bucket: the chart would silently stop summing to the
bill. `UnexpectedTagValue` is that count, and a non-zero reading means either a
resource that predates the SCP or a spelling the tag policy is not attached to.

**The window is half-open and excludes today.** Cost Explorer's `End` is
exclusive and the current day's figures are partial until the day closes. A
window that included today would make every series fall at midnight and climb
back through the day — on all of them at once, which reads as a real change.

Every cost metric is graphed as `MAXIMUM` rather than `SUM`, because each run
republishes the same trailing window: summing two runs in one period would double
the bill on the chart every time a retry succeeded.

---

## 6. Why the untagged share is not alarmed at zero

The default ceiling is **15%**, and no tagging policy can drive the figure to
nought. Three things land in the untagged bucket no matter what the SCP says:

1. **Charges with no taggable resource.** Tax, support charges, and most
   inter-AZ data transfer are not attached to a resource at all, so Cost Explorer
   files them under the untagged bucket for every key that exists.
2. **The account-scoped stacks.** Five stacks here carry no `Environment` tag on
   purpose, including `CostAllocationStack` itself. Their spend is genuinely
   untagged for that key and genuinely should be.
3. **The management account.** No SCP reaches it, so anything created there is
   untagged whatever the policy says.

The alarm is on the share crossing the headroom those three need together — a
trend, not an absolute. `cost-allocation-unattributed-<key>` is the alarm;
`unattributedSharePercent` on the stack props raises or lowers it, overall or per
key, and lowering it to zero would page on arithmetic.

---

## 7. The alarms

All five alarm families reach `CloudWatchAlarmsStack-Production`'s topic, which
`RunbookStack-Production` already enriches, and all of them sit in runbook §9 —
"A platform component has stopped reporting". That includes the
unattributed-share alarm, which is the least obviously an instrument and the most
clearly covered by that section's own sentence: a rising untagged share means the
attributed figures are increasingly not the bill, and a cost review reading them
would not notice.

| Alarm | Means |
| --- | --- |
| `cost-allocation-tag-not-activated-<key>` | Billing does not have the key activated. Every series for it is flat zero for that reason alone |
| `cost-allocation-unattributed-<key>` | More of the bill carries no value for this key than the headroom allows |
| `cost-allocation-report-stale` | No successful report in the staleness window. The dashboard is still drawing the last figures it was given |
| `cost-allocation-reporter-errors` | The reporter threw. Distinct from staleness: a run that throws partway leaves a dashboard that is partly fresh |
| `cost-allocation-report-undelivered` | EventBridge could not deliver a scheduled report. The schedule exists and is not reaching the function |

Only `cost-allocation-report-stale` treats missing data as breaching. Absence has
one cause and gets one ticket; every other alarm here tolerates missing data so
that a report which never ran does not produce 2n + 1 pages for it.

---

## 8. What it costs

`ce:GetCostAndUsage` is billed **per request** — $0.01 at the time of writing —
and the reporter makes one per *activated* key per run. Three keys on a daily
schedule is about $0.11 a month. An un-activated key makes no call at all, which
is deliberate: a zero published for a grouping AWS never had is worse than no
datapoint, and it would be a paid-for zero.

Lowering `reportScheduleHours` multiplies that figure directly. Cost Explorer's
own data refreshes at most once a day, so anything under 24 hours buys nothing.

---

## 9. The gate

`npm run audit:tagging` runs in the `cdk` job on every pull request. Beyond every
rule in `validateTaggingPolicy`, it checks:

| Rule | Catches |
| --- | --- |
| `policy-file-missing` / `policy-file-drift` | A generated document that is absent or hand-edited |
| `invalid-action-format` | An action IAM's grammar rejects, such as a wildcard service prefix |
| `removal-unprotected` | An enforced create whose tags can be taken off the moment the resource exists |
| `rego-required-tag-missing` | A key `tags.rego` requires that the SCP does not |
| `scp-required-tag-missing` | A key the SCP requires that `tags.rego` does not, so a stack here passes review and is denied at deploy |
| `environment-values-drift` | The two copies of the environment set disagree |
| `resource-type-uncovered` | A type `tags.rego` governs that no catalogued action creates — and no reason recorded for why it cannot be |
| `dashboard-not-wired` | A catalogue, an SCP and a tag policy with nothing measuring whether any of it worked |
| `tag-key-undocumented` | A governed key this page never names |
| `activation-undocumented` | This page not saying that activation is not retroactive |

---

## 10. Known gaps

* **Nothing here attaches the policies.** Attachment happens in the management
  account, and this repository deploys into member accounts. The gate holds the
  files to the catalogue; it cannot tell you whether anybody attached them. The
  untagged share on the dashboard is the only evidence that they were.
* **The SCP governs creation, not drift.** `DenyRemovalOfGovernedTags` names each
  service's own removal action — `UntagResource`, `UntagQueue`, `RemoveTags`,
  `RemoveTagsFromResource`, `DeleteTags`, since IAM's action grammar has no
  wildcard that spans a service prefix and `*:Untag*` is simply an invalid
  action — but a tag *edited* to another allowed value is a `TagResource` call
  that the policy permits by design.
* **S3, CloudFront, log groups, EventBridge rules and IAM roles are not enforced
  at create time**, each for a recorded reason in `SCP_ACTION_CATALOGUE`. The
  rego pack still covers the ones this repository creates; nothing covers the
  ones it does not.
* **Tag policies report rather than enforce.** Without a per-resource-type
  enforcement block the tag policy marks a resource non-compliant and allows the
  request, and even with one it governs `TagResource` rather than creation. It is
  here for the canonical spelling, not for enforcement.
