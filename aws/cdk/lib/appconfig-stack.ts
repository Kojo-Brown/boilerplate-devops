import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { FEATURE_FLAG_MANIFEST_SCHEMA } from '../tools/audit-feature-flags';

export interface AppConfigEnvironmentConfig {
  /** Environment name, e.g. 'production' or 'staging' */
  readonly name: string;
  readonly description?: string;
}

export interface AppConfigStackProps extends cdk.StackProps {
  /**
   * AppConfig Application name — groups all environments and configuration
   * profiles for one service. Defaults to 'boilerplate'.
   */
  readonly appName?: string;

  /**
   * Environments to create. Defaults to production + staging.
   * Each environment gets its own deployment history and rollback monitors.
   */
  readonly environments?: AppConfigEnvironmentConfig[];

  /**
   * Traffic growth factor in percent per interval (default: 10).
   * With deploymentDurationMinutes = 10 this gives 10% per minute
   * over 10 minutes.
   */
  readonly deploymentGrowthFactor?: number;

  /**
   * Total deployment duration in minutes (default: 10).
   * Feature flags shift from 0 → 100% over this period.
   */
  readonly deploymentDurationMinutes?: number;

  /**
   * Final bake time in minutes after reaching 100% (default: 5).
   * AppConfig continues monitoring alarms before marking the deployment
   * Complete. Any alarm breach during bake triggers auto-rollback.
   */
  readonly finalBakeTimeMinutes?: number;

  /**
   * CloudWatch Alarm ARNs attached to every environment as rollback monitors.
   * When any alarm transitions to ALARM during a deployment, AppConfig
   * rolls back to the previous configuration version automatically.
   */
  readonly rollbackAlarmArns?: string[];

  /**
   * Feature flag manifest used to bootstrap the first configuration version.
   * Defaults to `aws/appconfig/feature-flags.example.json`.
   *
   * The default is the file the audit gate checks and the file the deploy
   * workflow ships, deliberately: a stack that bootstrapped from an inline
   * literal would put a set of flags into every new environment that nothing in
   * the repository validates and no manifest in the repository matches.
   */
  readonly featureFlagsManifestPath?: string;
}

/** `aws/appconfig/feature-flags.example.json`, resolved from this file. */
export const DEFAULT_FEATURE_FLAGS_MANIFEST_PATH = path.join(
  __dirname,
  '..',
  '..',
  'appconfig',
  'feature-flags.example.json',
);

/**
 * AWS AppConfig stack for feature flag deployment.
 *
 * Architecture:
 *   Application
 *     └─ DeploymentStrategy (linear 10 % / min, 10-min duration, 5-min bake)
 *     ├─ Environment: production  (+ CloudWatch rollback monitors)
 *     ├─ Environment: staging     (+ CloudWatch rollback monitors)
 *     └─ HostedConfiguration: feature-flags  (+ JSON Schema validator)
 *          └─ Deployment → all environments
 *
 * The configuration is the flag manifest described in `docs/feature-flags.md`,
 * bootstrapped from `aws/appconfig/feature-flags.example.json`. The manifest
 * schema is attached to the profile as a validator, so AppConfig rejects a
 * malformed version at CreateHostedConfigurationVersion rather than deploying
 * it — the last line of defence behind `npm run audit:flags`, and the only one
 * that still applies when somebody uploads a version by hand.
 *
 * Deployment flow (via workflow-templates/deploy-feature-flags.yml):
 *   1. CI validates the feature-flags manifest.
 *   2. aws appconfig create-hosted-configuration-version  → new version N+1
 *   3. aws appconfig start-deployment  → gradual rollout begins
 *   4. AppConfig shifts traffic 10 % per minute over 10 minutes.
 *   5. After 100 %, AppConfig bakes for 5 minutes monitoring alarms.
 *   6. On alarm breach → automatic rollback to version N.
 *
 * Runtime reads (ECS tasks / Lambda):
 *   Attach AppConfigReadPolicyArn to the task/execution role, then use the
 *   AWS AppConfig Data client (StartConfigurationSession + GetLatestConfiguration)
 *   to poll for flag updates without redeploying the container.
 *
 * Outputs (use as workflow inputs):
 *   ApplicationId       → --app-id
 *   ConfigProfileId     → --profile-id
 *   EnvId{production}   → --env-id  (for production deployments)
 *   EnvId{staging}      → --env-id  (for staging deployments)
 */
export class AppConfigStack extends cdk.Stack {
  public readonly application: appconfig.Application;
  public readonly deploymentStrategy: appconfig.DeploymentStrategy;
  public readonly featureFlagsConfig: appconfig.HostedConfiguration;
  /** Map of environment name → AppConfig Environment construct */
  public readonly environments: Record<string, appconfig.Environment> = {};
  /** Managed policy granting StartConfigurationSession + GetLatestConfiguration */
  public readonly taskReadPolicy: iam.ManagedPolicy;

  constructor(scope: Construct, id: string, props: AppConfigStackProps = {}) {
    super(scope, id, props);

    const appName = props.appName ?? 'boilerplate';
    const growthFactor = props.deploymentGrowthFactor ?? 10;
    const deploymentDurationMinutes = props.deploymentDurationMinutes ?? 10;
    const finalBakeTimeMinutes = props.finalBakeTimeMinutes ?? 5;
    const envConfigs: AppConfigEnvironmentConfig[] = props.environments ?? [
      { name: 'production', description: 'Production feature flags' },
      { name: 'staging', description: 'Staging / pre-production feature flags' },
    ];

    // ── AppConfig Application ─────────────────────────────────────────────────
    this.application = new appconfig.Application(this, 'Application', {
      applicationName: appName,
      description: `Feature flag application for ${appName}`,
    });

    // ── Gradual Rollout Deployment Strategy ───────────────────────────────────
    // Linear: +growthFactor% per (deploymentDurationMinutes / (100/growthFactor)) mins.
    // Default: +10% every 1 minute over 10 minutes, then 5-minute bake time.
    this.deploymentStrategy = new appconfig.DeploymentStrategy(this, 'DeploymentStrategy', {
      deploymentStrategyName: `${appName}-linear-${growthFactor}pct-1min`,
      description: [
        `Linear ${growthFactor}% growth,`,
        `${deploymentDurationMinutes}min duration,`,
        `${finalBakeTimeMinutes}min bake`,
      ].join(' '),
      rolloutStrategy: appconfig.RolloutStrategy.linear({
        growthFactor,
        deploymentDuration: cdk.Duration.minutes(deploymentDurationMinutes),
        finalBakeTime: cdk.Duration.minutes(finalBakeTimeMinutes),
      }),
    });

    // ── Environments with optional CloudWatch rollback monitors ───────────────
    for (const cfg of envConfigs) {
      const monitors: appconfig.Monitor[] = (props.rollbackAlarmArns ?? []).map((arn, i) => {
        const alarm = cloudwatch.Alarm.fromAlarmArn(
          this,
          `RollbackAlarm${cfg.name}${i}`,
          arn,
        );
        return appconfig.Monitor.fromCloudWatchAlarm(alarm);
      });

      const envId = cfg.name.charAt(0).toUpperCase() + cfg.name.slice(1);
      this.environments[cfg.name] = new appconfig.Environment(this, `Environment${envId}`, {
        environmentName: `${appName}-${cfg.name}`,
        application: this.application,
        description: cfg.description,
        monitors,
      });
    }

    // ── Feature Flags Hosted Configuration ────────────────────────────────────
    // FREEFORM rather than AppConfig's own FEATURE_FLAGS type. That type has a
    // fixed schema with nowhere to record who owns a flag or when it is due to
    // be removed, and the lifecycle machinery in `FeatureFlagLifecycleStack`
    // reads exactly those fields off the deployed configuration. A validator
    // gives back what the typed profile would have provided — server-side
    // rejection of a malformed version — for a shape that carries the metadata.
    //
    // The workflow manages subsequent versions; CDK bootstraps the first one
    // from the manifest in the repository and deploys it.
    const manifestPath = props.featureFlagsManifestPath ?? DEFAULT_FEATURE_FLAGS_MANIFEST_PATH;
    const manifest = fs.readFileSync(manifestPath, 'utf8');

    this.featureFlagsConfig = new appconfig.HostedConfiguration(this, 'FeatureFlags', {
      application: this.application,
      name: 'feature-flags',
      description: 'Feature flag manifest polled by application containers',
      content: appconfig.ConfigurationContent.fromInlineJson(manifest, 'application/json'),
      type: appconfig.ConfigurationType.FREEFORM,
      validators: [
        appconfig.JsonSchemaValidator.fromInline(JSON.stringify(FEATURE_FLAG_MANIFEST_SCHEMA)),
      ],
      deploymentStrategy: this.deploymentStrategy,
      deployTo: Object.values(this.environments),
    });

    // ── IAM Managed Policy — runtime reads for ECS tasks + Lambda ────────────
    // Attach this policy to any ECS task role or Lambda execution role that
    // needs to poll feature flags at runtime using the AppConfig Data client.
    this.taskReadPolicy = new iam.ManagedPolicy(this, 'AppConfigReadPolicy', {
      managedPolicyName: `${appName}-appconfig-read`,
      description: 'Read AppConfig feature flags — attach to ECS task role or Lambda execution role',
      statements: [
        new iam.PolicyStatement({
          sid: 'StartConfigurationSession',
          effect: iam.Effect.ALLOW,
          actions: ['appconfig:StartConfigurationSession'],
          resources: [
            // arn:aws:appconfig:*:account:application/app-id/environment/*
            `${this.application.applicationArn}/environment/*`,
          ],
        }),
        new iam.PolicyStatement({
          sid: 'GetLatestConfiguration',
          effect: iam.Effect.ALLOW,
          actions: ['appconfig:GetLatestConfiguration'],
          // The configuration token returned by StartConfigurationSession scopes
          // access; the resource ARN below restricts to this application.
          resources: [
            `arn:aws:appconfig:${this.region}:${this.account}:configuration/*`,
          ],
        }),
      ],
    });

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── CloudFormation Outputs ───────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApplicationId', {
      value: this.application.applicationId,
      description: 'AppConfig Application ID — pass as --app-id in workflow inputs',
      exportName: `${appName}-appconfig-app-id`,
    });

    new cdk.CfnOutput(this, 'ConfigProfileId', {
      value: this.featureFlagsConfig.configurationProfileId,
      description: 'Feature flags configuration profile ID — pass as --profile-id in workflow inputs',
      exportName: `${appName}-appconfig-flags-profile-id`,
    });

    new cdk.CfnOutput(this, 'DeploymentStrategyId', {
      value: this.deploymentStrategy.deploymentStrategyId,
      description: 'Gradual rollout deployment strategy ID — pass as --deployment-strategy-id to override',
      exportName: `${appName}-appconfig-deployment-strategy-id`,
    });

    new cdk.CfnOutput(this, 'AppConfigReadPolicyArn', {
      value: this.taskReadPolicy.managedPolicyArn,
      description: 'Attach this managed policy ARN to ECS task roles or Lambda execution roles',
      exportName: `${appName}-appconfig-read-policy-arn`,
    });

    for (const [envName, env] of Object.entries(this.environments)) {
      new cdk.CfnOutput(this, `EnvId${envName.charAt(0).toUpperCase()}${envName.slice(1)}`, {
        value: env.environmentId,
        description: `AppConfig environment ID for ${envName} — pass as --env-id in workflow inputs`,
        exportName: `${appName}-appconfig-env-${envName}-id`,
      });
    }
  }
}
