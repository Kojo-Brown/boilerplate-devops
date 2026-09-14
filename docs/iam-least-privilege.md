# IAM least privilege

`CLAUDE.md` has said *"least privilege by default; document any wildcard in an
IAM policy"* since this repository started, and until now nothing checked it.
Every other gate here reasons about an artifact — what is inside the image, who
signed it, what it was built from. This one reasons about what the account lets
the pipeline *do*, which is the blast radius of all the others: an attacker who
gets a step to run arbitrary code inherits that job's role, and what happens
next is decided entirely by the role's policy.

## 1. Why there are two gates

| | `npm run audit:iam` | `iam-access-analyzer.yml` |
|---|---|---|
| Reads | `cdk.out/*.template.json` | the same templates |
| Needs an AWS account | no | yes |
| Runs on a fork's PR | yes | no — no OIDC token |
| Blocks the merge | **yes** | no |
| Coverage | curated | AWS's full authorization model |

The split is forced by one fact: `cfn-policy-validator` calls
`sts:GetCallerIdentity` before it does anything else and exits 1 without
credentials. A pull request from a fork gets no `id-token: write`, so it cannot
assume a role. Making the analyzer a required check would block every fork
contribution on a check that cannot pass, so the blocking gate is the offline
one.

That is a real limitation, not a preference, and it shapes what the offline
gate is allowed to be. **Every rule in `audit-iam-least-privilege.ts` reports
something that is a defect in this repository's source and fixable in this
repository's source.** It deliberately does *not* try to answer "does this
action accept a resource ARN?", because that is a property of AWS's
authorization model, changes without notice, and a hand-maintained table of it
goes stale in the direction that reports work nobody can do.

Concretely: 45 statements in this repository use `Resource: "*"`. Most of them
have to — `cloudwatch:GetMetricData`, `ec2:DescribeSubnets`,
`ecr:GetAuthorizationToken` and `ecs:RegisterTaskDefinition` take no resource at
all, and IAM accepts nothing but `*` for them. A gate that reported all 45
would have a baseline file within a week, and the six real findings would be
inside it. So `Resource: "*"` is a finding here only for the curated privileged
set in `PRIVILEGED_ACTIONS`, and the exhaustive answer comes from Access
Analyzer, which has the model.

## 2. What the first run found

Ten findings, all fixed in the same change rather than baselined.

**`iam:PassRole` on `"*"` in the GitHub deploy role.** This is the one worth
reading twice, because it had a condition and a sid that said what it was for:

```ts
new iam.PolicyStatement({
  sid: 'PassRoleToECS',
  actions: ['iam:PassRole'],
  resources: ['*'],
  conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
})
```

`iam:PassedToService` constrains **which service receives the role**, not
**which role is handed over**. Two statements above it, the same role held
`ecs:RegisterTaskDefinition` — so a workflow that could reach these credentials
could register a task definition naming *any* role in the account that ECS
tasks can assume, then start it. That is a privilege escalation to the most
privileged task role in the account, and it reads in review like the scoped
version of PassRole. The fix is a list of role ARNs
(`GitHubDeploymentScope.passableRoleArns`); the condition stays, because it is
still worth having, but the resource list is what makes it a scope.

**`ReadOnlyAccess` on a role any workflow on `main` could assume.** The names
differ by a word and the policies differ by the entire data plane:
`ReadOnlyAccess` grants `s3:GetObject`, `dynamodb:GetItem`,
`sqs:ReceiveMessage`, `ssm:GetParameter` and `lambda:GetFunction` — whose
response carries the function's environment variables — across the whole
account. "Read-only for dashboards and cost analysis" is `ViewOnlyAccess`,
which is metadata only, and is what the role now attaches.

**`ecr:PutImage` and `ecs:UpdateService` on `"*"`.** Push to any repository in
the account, update any service in it. Now scoped to the repository `EcrStack`
creates and the service `EcsStack` creates, with `GitHubDeploymentScope` to
override when yours are named differently. The two account-level actions that
genuinely cannot be scoped — `ecr:GetAuthorizationToken` and
`ecs:RegisterTaskDefinition` — were split into statements of their own, so the
remaining wildcard is the documented exception rather than the shape of the
whole statement.

**`codedeploy:StopDeployment` on `"*"` in `RollbackAutomationStack`.** This
Lambda could halt any deployment anywhere in the account, including one
belonging to a service it is not a rollback target for, at the moment that
deployment was shifting traffic. `SloBurnRateRollbackStack` has scoped the
identical three actions to deployment-group ARNs since PR #28; this one had
not, and the two are close enough that the difference was invisible in review.
That is the case for a gate rather than a review checklist.

## 3. The rules

| Rule | What it prevents |
|---|---|
| `action-wildcard` | `Action: "*"` in an Allow — administrator, whatever the resource half says |
| `service-action-wildcard` | `Action: "s3:*"` — every action the service has, including ones AWS adds later |
| `not-action-allow` | an Allow written by exclusion, which grants every future action nobody excluded |
| `not-resource-allow` | the same mistake on the resource half |
| `passrole-unscoped` | `iam:PassRole` on `"*"`, condition or not — see §2 |
| `admin-managed-policy` | `AdministratorAccess`, `PowerUserAccess`, `IAMFullAccess` |
| `account-wide-read-policy` | `ReadOnlyAccess` where `ViewOnlyAccess` was meant |
| `privileged-action-unscoped` | `Resource: "*"`, no condition, on an action that reads data, changes what runs, or grants access |
| `principal-wildcard` | `Principal: "*"` with no condition — every AWS account in the world |
| `github-oidc-trust-unscoped` | a trust missing its `aud` check, or whose `sub` is not pinned to one repository |
| `analyzer-report-missing` | nothing asks Access Analyzer |
| `analyzer-findings-ignored` | it runs and cannot fail |
| `analyzer-unpinned` | the validator's version floats |
| `audit-not-run-in-ci` | this gate is not wired into a job |

### The two carve-outs

Both are narrow, and both are printed or documented rather than silent.

**CDK-framework-owned resources.** The roles CDK creates for its own
custom-resource handlers, and for the EKS cluster it provisions, are written by
the framework, regenerated on every upgrade, and cannot be narrowed from this
repository's source. They are skipped by construct path, and the count is
printed on every successful run (`24 CDK-framework-owned resource(s)
skipped`) so the exemption cannot grow unnoticed.

**The KMS account-root statement.** Every KMS key policy carries

```json
{ "Effect": "Allow", "Principal": { "AWS": "arn:aws:iam::<account>:root" },
  "Action": "kms:*", "Resource": "*" }
```

which is not a grant of standing access — it is the documented way a key says
"IAM policies in this account govern me". AWS warns that removing it can make
the key unmanageable, and CDK writes it into every key. It is exempt in
**resource-based policies only, and only for this account's own root**; the same
wildcard in an identity policy is an administrator and is still reported. Six
stacks create keys, so without this the gate's first run was 22 findings of
which 12 were this statement doing its job.

## 4. Running it

```bash
cd aws/cdk
npx cdk synth --quiet     # the gate reads what synth wrote, not the TypeScript
npm run audit:iam
```

It reads the synthesised CloudFormation on purpose. Defaults, aspects, `grant*`
calls and escape hatches all resolve between `lib/*.ts` and the template, so a
role can end up holding something the source never said — which is also why
`audit:iam` runs *after* the synth step in `ci.yml` and fails outright when
`cdk.out` is empty, rather than reporting nothing.

## 5. The Access Analyzer report

`.github/workflows/iam-access-analyzer.yml` runs
`cfn-policy-validator validate` over every synthesised template and fails on
`ERROR` and `SECURITY_WARNING` findings. It needs two repository variables,
neither of them secret:

| Variable | Meaning |
|---|---|
| `IAM_ACCESS_ANALYZER_ROLE_ARN` | a role trusting this repository's OIDC subject, with `access-analyzer:ValidatePolicy` and `iam:GetPolicy`/`iam:GetPolicyVersion`. Unset, every job skips. |
| `AWS_REGION` | optional, defaults to `us-east-1` |

It runs on same-repository pull requests, on pushes to `main`, weekly, and on
demand. **Weekly matters on its own**: Access Analyzer's findings are not a pure
function of the template. AWS adds checks, so a policy that was clean in March
can be reported in June with nobody having touched it, and a gate that only runs
on a diff never notices.

When the job does not run, the `Access Analyzer status` job still does, and
writes to the run summary which of the two reasons applied — no role configured,
or a fork PR with no OIDC token. A check that silently stops running is the
failure this repository keeps finding, so "nothing has asked Access Analyzer
about these policies in three weeks" is visible in the run rather than being the
absence of a job nobody notices.

### How this gate gets switched off

Three flags, all of which leave the findings printed in the log, so the report
reads the same before and after. `npm run audit:iam` rejects each of them, in
the workflow and in `.github/scripts/run-iam-access-analyzer.sh` alike:

- `--ignore-finding` — suppress by finding code or resource name.
- `--treat-findings-as-non-blocking` — on `check-access-not-granted`.
- `--treat-finding-type-as-blocking` set to something narrower than
  `ERROR,SECURITY_WARNING`. Passing the flag reads like tightening; dropping
  `SECURITY_WARNING` from it is exactly where `PASS_ROLE_WITH_STAR_IN_RESOURCE`
  — the finding that started this item — stops failing the build.

Two more subtle ones the audit also checks: `continue-on-error: true` on the
step, and piping the validator into `tee` without `set -o pipefail`, which
reports `tee`'s exit status and is considerably harder to see than `|| true`.

## 6. What this does not cover

- **`check-access-not-granted` is not enabled.** It is the half that would
  express *this repository's* boundary — "no pipeline role may ever hold
  `iam:CreateAccessKey`" — the way the Conftest pack expresses what is true of
  our infrastructure rather than everyone's. It is not wired up because the
  action list has to be calibrated against an account first: CDK's own
  framework roles legitimately hold broad IAM, and a list written without
  running it turns the job red for something nobody can fix. The command is
  `cfn-policy-validator check-access-not-granted --template-path <t>
  --actions iam:CreateAccessKey,iam:UpdateAssumeRolePolicy`.
- **Nothing is enforced at the account.** A role created in the console, or by
  a stack outside this repository, never passes through either gate. That is
  what an SCP or a permissions boundary is for.
- **The analyzer has never run against a real account from this repository.**
  There is none to run it against; the workflow is wired and pinned, and its
  first real execution will be in a consumer's account.
- **Conditions are trusted.** `privileged-action-unscoped` skips any statement
  that carries a `Condition`, on the grounds that a condition is at least
  deliberate. Whether it actually narrows anything is Access Analyzer's
  question — `iam:PassedToService` is the case that proves a condition can look
  like a scope and not be one, which is why `passrole-unscoped` ignores
  conditions entirely.
- **Resource-based policies get one rule.** `principal-wildcard` catches the
  public-to-the-world case; the graded version is
  `cfn-policy-validator check-no-public-access`, which is not wired up for the
  same reason as above.
