import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/** Scope a trust condition to a specific GitHub repo, branch, environment, or tag. */
export interface GitHubTrustCondition {
  /**
   * GitHub organisation or user name (case-insensitive).
   * Example: "my-org"
   */
  readonly owner: string;
  /**
   * Repository name without the owner prefix.
   * Example: "my-service"
   */
  readonly repo: string;
  /**
   * Optional: narrow the trust to a specific ref, environment, or wildcard.
   * Matches the `sub` claim emitted by GitHub Actions.
   *
   * Examples:
   *   "ref:refs/heads/main"                    — only main branch
   *   "environment:production"                 — only `production` environment
   *   "ref:refs/tags/*"                        — any tag push
   *   "*"                                       — any ref in this repo (default)
   *
   * The full claim becomes: repo:{owner}/{repo}:{filter}
   */
  readonly filter?: string;
}

/** Named role definition within the OIDC stack. */
export interface GitHubRole {
  /**
   * Logical name for this role (used in CloudFormation and export name).
   * Must be unique within the stack.  Example: "CI", "Deploy", "ReadOnly"
   */
  readonly name: string;
  /** Human-readable description attached to the IAM role. */
  readonly description: string;
  /**
   * GitHub Actions contexts that may assume this role.
   * Each entry produces one `StringLike` condition on `sub`.
   */
  readonly conditions: GitHubTrustCondition[];
  /** Additional managed policy ARNs to attach. */
  readonly managedPolicies?: string[];
  /** Inline policy statements to attach. */
  readonly inlineStatements?: iam.PolicyStatement[];
  /** Maximum duration for assumed-role sessions (default: 1 hour). */
  readonly maxSessionDuration?: cdk.Duration;
}

/**
 * The resources the default `Deploy` and `CI` roles are allowed to touch.
 *
 * Every field defaults to the name the corresponding stack in this repository
 * creates, so the default roles are scoped out of the box rather than scoped
 * "once you get around to it". Override them when your resources are named
 * something else; `passableRoleArns` is the one worth reading twice.
 */
export interface GitHubDeploymentScope {
  /**
   * ECR repositories the Deploy role may push to.
   * Defaults to the repository `EcrStack` creates: `{envName}-app`.
   */
  readonly ecrRepositoryNames?: string[];
  /**
   * ECS cluster holding the services the Deploy role may update.
   * Defaults to the cluster `EcsStack` creates: `{envName}-cluster`.
   */
  readonly ecsClusterName?: string;
  /**
   * ECS services the Deploy role may update.
   * Defaults to the service `EcsStack` creates: `{envName}-service`.
   */
  readonly ecsServiceNames?: string[];
  /**
   * Task-definition family prefix the Deploy role may deregister and describe.
   * Defaults to `{envName}-`, which covers every family this repository names.
   */
  readonly taskDefinitionFamilyPrefix?: string;
  /**
   * Roles the Deploy role may hand to ECS with `iam:PassRole`.
   *
   * This is the list that decides how far a compromised workflow reaches. An
   * `iam:PassedToService` condition is not a substitute: it constrains which
   * service receives the role, not which role is handed over, so with
   * `ecs:RegisterTaskDefinition` alongside it, `Resource: "*"` here means the
   * workflow can run a task as the most privileged role in the account that
   * ECS tasks can assume.
   *
   * Defaults to the two roles `EcsStack` creates for the task itself.
   */
  readonly passableRoleArns?: string[];
}

export interface GitHubOidcStackProps extends cdk.StackProps {
  /** Environment tag applied to all resources. Defaults to "shared". */
  readonly envName?: string;
  /**
   * Resources the default roles are scoped to. Ignored when `roles` is given,
   * since those statements are yours.
   */
  readonly deploymentScope?: GitHubDeploymentScope;
  /**
   * Thumbprint list for the GitHub OIDC provider.
   * GitHub rotates its OIDC CA periodically; the thumbprint below is current as
   * of 2024 but should be re-verified before deploying to production:
   *
   *   openssl s_client -connect token.actions.githubusercontent.com:443 2>/dev/null \
   *     | openssl x509 -fingerprint -noout -sha1 \
   *     | sed 's/://g' | tr '[:upper:]' '[:lower:]'
   *
   * Defaults to the well-known GitHub thumbprint.
   */
  readonly thumbprints?: string[];
  /**
   * Named IAM roles to create, each with its own GitHub trust conditions.
   * If omitted, three default roles are created: CI, Deploy, and ReadOnly.
   */
  readonly roles?: GitHubRole[];
  /**
   * When true, a single IAM OIDC provider is created in this stack.
   * Set to false when the provider already exists in the account (only one
   * provider per URL is allowed per AWS account).
   * Defaults to true.
   */
  readonly createOidcProvider?: boolean;
  /**
   * ARN of an existing GitHub OIDC provider to import.
   * Required when createOidcProvider is false.
   */
  readonly existingOidcProviderArn?: string;
}

const GITHUB_OIDC_URL = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com';
const DEFAULT_THUMBPRINT = '6938fd4d98bab03faadb97b34396831e3780aea1';

/**
 * GitHub Actions OIDC → AWS role assumption pattern.
 *
 * Provisions a GitHub OIDC identity provider and one or more IAM roles that
 * GitHub Actions workflows can assume without storing any long-lived AWS
 * credentials in GitHub Secrets.  Each role's trust policy uses `StringLike`
 * on the `sub` claim so that trust can be scoped to a repo, branch,
 * environment, or tag — preventing other repos from assuming the role.
 *
 * Architecture overview:
 *   1. GitHub Actions requests a short-lived OIDC token signed by GitHub.
 *   2. The workflow calls `aws-actions/configure-aws-credentials` with
 *      `role-to-assume` pointing at one of the exported role ARNs.
 *   3. AWS STS verifies the token against the OIDC provider and issues
 *      temporary credentials (max session duration is configurable).
 *   4. Subsequent steps in the job use those credentials transparently.
 *
 * One provider per account:
 *   AWS allows only one OIDC identity provider per URL.  If you already have
 *   the GitHub provider in the account, set `createOidcProvider: false` and
 *   supply `existingOidcProviderArn`.
 *
 * Least-privilege principle:
 *   Attach only the permissions each role needs.  The default roles demonstrate
 *   the pattern; adjust or replace them for your workloads.
 *
 * Deployment:
 *   cdk deploy GitHubOidcStack-Staging
 *
 * Then copy the exported role ARNs into GitHub Actions secrets:
 *   STAGING_CI_ROLE_ARN       → CfnOutput: GitHubCIRoleArn
 *   STAGING_DEPLOY_ROLE_ARN   → CfnOutput: GitHubDeployRoleArn
 *
 * Workflow usage (see workflow-templates/assume-role.yml for a full example):
 *   - uses: aws-actions/configure-aws-credentials@v4
 *     with:
 *       role-to-assume: ${{ secrets.STAGING_DEPLOY_ROLE_ARN }}
 *       aws-region: us-east-1
 */
export class GitHubOidcStack extends cdk.Stack {
  /** The OIDC provider (created or imported). */
  public readonly provider: iam.IOpenIdConnectProvider;

  /** Map of role name → created IAM role. */
  public readonly roles: Map<string, iam.Role> = new Map();

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'shared';
    const thumbprints = props.thumbprints ?? [DEFAULT_THUMBPRINT];
    const createProvider = props.createOidcProvider ?? true;
    const roleDefinitions = props.roles ?? defaultRoles(props);

    // ── OIDC Provider ─────────────────────────────────────────────────────────
    if (createProvider) {
      this.provider = new iam.OpenIdConnectProvider(this, 'GitHubProvider', {
        url: GITHUB_OIDC_URL,
        clientIds: [GITHUB_OIDC_AUDIENCE],
        thumbprints,
      });
    } else {
      const arn =
        props.existingOidcProviderArn ??
        `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;
      this.provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
        this,
        'GitHubProviderImport',
        arn,
      );
    }

    // ── IAM Roles ─────────────────────────────────────────────────────────────
    for (const def of roleDefinitions) {
      const subConditions = def.conditions.map(
        (c) =>
          `repo:${c.owner}/${c.repo}:${c.filter ?? '*'}`,
      );

      const principal = new iam.FederatedPrincipal(
        this.provider.openIdConnectProviderArn,
        {
          StringEquals: {
            [`${GITHUB_OIDC_URL}:aud`]: GITHUB_OIDC_AUDIENCE,
          },
          StringLike: {
            [`${GITHUB_OIDC_URL}:sub`]:
              subConditions.length === 1 ? subConditions[0] : subConditions,
          },
        },
        'sts:AssumeRoleWithWebIdentity',
      );

      const role = new iam.Role(this, `Role${def.name}`, {
        roleName: `github-actions-${envName}-${def.name.toLowerCase()}`,
        description: def.description,
        assumedBy: principal,
        maxSessionDuration: def.maxSessionDuration ?? cdk.Duration.hours(1),
      });

      for (const policyArn of def.managedPolicies ?? []) {
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName(policyArn));
      }

      for (const statement of def.inlineStatements ?? []) {
        role.addToPolicy(statement);
      }

      cdk.Tags.of(role).add('Environment', envName);
      cdk.Tags.of(role).add('ManagedBy', 'GitHubOidcStack');

      this.roles.set(def.name, role);

      new cdk.CfnOutput(this, `GitHub${def.name}RoleArn`, {
        value: role.roleArn,
        description: `ARN of the GitHub Actions ${def.name} role (${envName})`,
        exportName: `${this.stackName}-${def.name}RoleArn`,
      });
    }

    // ── Provider ARN output ───────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'OidcProviderArn', {
      value: this.provider.openIdConnectProviderArn,
      description: 'ARN of the GitHub OIDC identity provider',
      exportName: `${this.stackName}-OidcProviderArn`,
    });

    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'GitHubOidcStack');
    // Every other stack here tags `Stack` with its own id; this one did not,
    // which left three IAM roles per environment with no tag saying what would
    // recreate them. Long-lived deploy roles are exactly the resources an
    // account sweep finds and cannot attribute. See docs/policy-as-code.md.
    cdk.Tags.of(this).add('Stack', id);
  }
}

/**
 * Default role set used when `props.roles` is not specified.
 *
 * Override these in the app.ts instantiation with roles scoped to your
 * actual organisation and repositories.
 */
function defaultRoles(props: GitHubOidcStackProps): GitHubRole[] {
  const owner = 'YOUR_ORG';
  const repo = 'YOUR_REPO';
  const envName = props.envName ?? 'shared';
  const deploymentScope = props.deploymentScope ?? {};

  // Defaults track the names the other stacks in this repository create, so
  // that "the default roles" and "scoped to the resources that exist" are the
  // same thing. Region and account are left as `*` because these roles are
  // created once and used from every region the application deploys to.
  const ecrRepositoryArns = (deploymentScope.ecrRepositoryNames ?? [`${envName}-app`]).map(
    (name) => `arn:aws:ecr:*:*:repository/${name}`,
  );
  const clusterName = deploymentScope.ecsClusterName ?? `${envName}-cluster`;
  const serviceArns = (deploymentScope.ecsServiceNames ?? [`${envName}-service`]).map(
    (name) => `arn:aws:ecs:*:*:service/${clusterName}/${name}`,
  );
  const taskDefinitionArn =
    `arn:aws:ecs:*:*:task-definition/${deploymentScope.taskDefinitionFamilyPrefix ?? `${envName}-`}*`;
  const passableRoleArns = deploymentScope.passableRoleArns ?? [
    // The two roles EcsStack creates for the task itself. Anything else the
    // workflow needs to pass has to be named here, which is the point: this
    // list is the ceiling on what a compromised workflow can become.
    `arn:aws:iam::*:role/${envName}-ecs-execution-role`,
    `arn:aws:iam::*:role/${envName}-ecs-task-role`,
  ];

  return [
    {
      name: 'CI',
      description: 'Read-only AWS access for CI checks (lint, test, typecheck, SAST)',
      conditions: [
        {
          owner,
          repo,
          filter: 'ref:refs/heads/*',
        },
      ],
      inlineStatements: [
        // `ecr:GetAuthorizationToken` is an account-level call — it takes no
        // resource at all, so IAM accepts nothing but `*` for it. Keeping it in
        // its own statement is what lets the actions that *do* take a
        // repository ARN be scoped to one, and makes the remaining wildcard the
        // documented exception rather than the shape of the whole statement.
        new iam.PolicyStatement({
          sid: 'ECRAuthToken',
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'ECRReadOnly',
          actions: [
            'ecr:BatchGetImage',
            'ecr:GetDownloadUrlForLayer',
            'ecr:DescribeRepositories',
          ],
          resources: ecrRepositoryArns,
        }),
        new iam.PolicyStatement({
          sid: 'SSMReadOnly',
          actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
          resources: [`arn:aws:ssm:*:*:parameter/app/${envName}/*`],
        }),
      ],
    },
    {
      name: 'Deploy',
      description: 'Deployment permissions: ECR push, ECS update, SSM read',
      conditions: [
        {
          owner,
          repo,
          filter: `environment:${envName}`,
        },
      ],
      maxSessionDuration: cdk.Duration.hours(2),
      inlineStatements: [
        // Same split as the CI role, for the same reason.
        new iam.PolicyStatement({
          sid: 'ECRAuthToken',
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'ECRPush',
          actions: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:InitiateLayerUpload',
            'ecr:UploadLayerPart',
            'ecr:CompleteLayerUpload',
            'ecr:PutImage',
          ],
          resources: ecrRepositoryArns,
        }),
        // `ecs:RegisterTaskDefinition` and `ecs:DescribeTaskDefinition` are
        // account-level: a task definition that does not exist yet has no ARN
        // to authorize against, and IAM accepts only `*` for both. Split for
        // the same reason as the ECR token call — the two actions that take a
        // resource are the ones that matter here, and they are scoped.
        new iam.PolicyStatement({
          sid: 'ECSRegisterTaskDefinition',
          actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'ECSDeregisterTaskDefinition',
          actions: ['ecs:DeregisterTaskDefinition'],
          resources: [taskDefinitionArn],
        }),
        new iam.PolicyStatement({
          sid: 'ECSUpdate',
          actions: ['ecs:UpdateService', 'ecs:DescribeServices'],
          resources: serviceArns,
        }),
        // `iam:PassedToService` was the only thing narrowing this and it is not
        // a scope: it says the role must end up at ECS, not which role may go
        // there. With `ecs:RegisterTaskDefinition` two statements up, `"*"`
        // here let this workflow run a task as any role in the account that
        // ECS tasks can assume — including roles belonging to services this
        // pipeline has nothing to do with. The condition stays because it is
        // still worth having; the resource list is what makes it a scope.
        new iam.PolicyStatement({
          sid: 'PassRoleToECS',
          actions: ['iam:PassRole'],
          resources: passableRoleArns,
          conditions: {
            StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
          },
        }),
        new iam.PolicyStatement({
          sid: 'SecretsRead',
          actions: ['secretsmanager:GetSecretValue'],
          resources: [`arn:aws:secretsmanager:*:*:secret:/app/${envName}/*`],
        }),
        new iam.PolicyStatement({
          sid: 'SSMRead',
          actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
          resources: [`arn:aws:ssm:*:*:parameter/app/${envName}/*`],
        }),
      ],
    },
    {
      name: 'ReadOnly',
      description: 'Metadata-only access for audit, cost analysis, or dashboards',
      conditions: [
        {
          owner,
          repo,
          filter: 'ref:refs/heads/main',
        },
      ],
      // `ViewOnlyAccess`, not `ReadOnlyAccess`. The names differ by a word and
      // the policies differ by the data plane: `ReadOnlyAccess` grants
      // `s3:GetObject`, `dynamodb:GetItem`, `sqs:ReceiveMessage`,
      // `ssm:GetParameter` and `lambda:GetFunction` — whose response carries
      // the function's environment variables — across the entire account. On a
      // role any workflow on `main` can assume, that made every object in the
      // account readable by anyone who could get a job to run. Dashboards and
      // cost analysis want the metadata, which is what `ViewOnlyAccess` is.
      managedPolicies: ['job-function/ViewOnlyAccess'],
    },
  ];
}
