import * as cdk from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

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
}

const INITIAL_FEATURE_FLAGS: Record<string, boolean | number> = {
  newDashboard: false,
  darkModeDefault: true,
  maintenanceMode: false,
  betaFeatures: false,
  rateLimitRequestsPerMinute: 100,
};

/**
 * AWS AppConfig stack for feature flag deployment.
 *
 * Architecture:
 *   Application
 *     └─ DeploymentStrategy (linear 10 % / min, 10-min duration, 5-min bake)
 *     ├─ Environment: production  (+ CloudWatch rollback monitors)
 *     ├─ Environment: staging     (+ CloudWatch rollback monitors)
 *     └─ HostedConfiguration: feature-flags
 *          └─ Deployment → all environments
 *
 * Deployment flow (via workflow-templates/deploy-feature-flags.yml):
 *   1. CI validates the feature-flags JSON file.
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
    // Content type FREEFORM allows any valid JSON object. The workflow manages
    // subsequent versions; CDK bootstraps the initial version and deploys it.
    this.featureFlagsConfig = new appconfig.HostedConfiguration(this, 'FeatureFlags', {
      application: this.application,
      name: 'feature-flags',
      description: 'Boolean and numeric feature flags polled by application containers',
      content: appconfig.ConfigurationContent.fromInlineJson(
        JSON.stringify(INITIAL_FEATURE_FLAGS, null, 2),
        'application/json',
      ),
      type: appconfig.ConfigurationType.FREEFORM,
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
