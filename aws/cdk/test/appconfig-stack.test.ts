import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AppConfigStack, AppConfigStackProps } from '../lib/appconfig-stack';

const makeStack = (props: AppConfigStackProps = {}) => {
  const app = new cdk.App();
  const stack = new AppConfigStack(app, 'TestAppConfigStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('AppConfigStack', () => {
  describe('Application', () => {
    it('creates exactly one AppConfig application', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::AppConfig::Application', 1);
    });

    it('uses the default app name boilerplate', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::Application', {
        Name: 'boilerplate',
      });
    });

    it('respects a custom appName', () => {
      const { template } = makeStack({ appName: 'my-service' });
      template.hasResourceProperties('AWS::AppConfig::Application', {
        Name: 'my-service',
      });
    });

    it('includes a description', () => {
      const { template } = makeStack({ appName: 'svc' });
      template.hasResourceProperties('AWS::AppConfig::Application', {
        Description: Match.stringLikeRegexp('svc'),
      });
    });
  });

  describe('DeploymentStrategy', () => {
    it('creates exactly one deployment strategy', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::AppConfig::DeploymentStrategy', 1);
    });

    it('uses a linear growth type', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        GrowthType: 'LINEAR',
      });
    });

    it('uses the default 10% growth factor', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        GrowthFactor: 10,
      });
    });

    it('uses the default 10-minute deployment duration', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        DeploymentDurationInMinutes: 10,
      });
    });

    it('uses the default 5-minute final bake time', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        FinalBakeTimeInMinutes: 5,
      });
    });

    it('respects custom growthFactor and durations', () => {
      const { template } = makeStack({
        deploymentGrowthFactor: 25,
        deploymentDurationMinutes: 4,
        finalBakeTimeMinutes: 2,
      });
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        GrowthFactor: 25,
        DeploymentDurationInMinutes: 4,
        FinalBakeTimeInMinutes: 2,
      });
    });

    it('does NOT replicate to SSM documents', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        ReplicateTo: 'NONE',
      });
    });

    it('names the strategy with appName prefix', () => {
      const { template } = makeStack({ appName: 'api' });
      template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
        Name: Match.stringLikeRegexp('^api-'),
      });
    });
  });

  describe('Environments', () => {
    it('creates exactly two environments by default (production + staging)', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::AppConfig::Environment', 2);
    });

    it('creates a production environment', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasResourceProperties('AWS::AppConfig::Environment', {
        Name: 'myapp-production',
      });
    });

    it('creates a staging environment', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasResourceProperties('AWS::AppConfig::Environment', {
        Name: 'myapp-staging',
      });
    });

    it('respects custom environment list', () => {
      const { template } = makeStack({
        environments: [
          { name: 'dev', description: 'Dev env' },
          { name: 'qa', description: 'QA env' },
          { name: 'prod', description: 'Prod env' },
        ],
      });
      template.resourceCountIs('AWS::AppConfig::Environment', 3);
    });

    it('attaches rollback alarm monitors when rollbackAlarmArns provided', () => {
      const alarmArn = 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:error-rate';
      const { template } = makeStack({ rollbackAlarmArns: [alarmArn] });
      // Each of the 2 default environments should have a monitor entry
      const envs = template.findResources('AWS::AppConfig::Environment', {
        Properties: Match.objectLike({
          Monitors: Match.arrayWith([
            Match.objectLike({ AlarmArn: alarmArn }),
          ]),
        }),
      });
      expect(Object.keys(envs)).toHaveLength(2);
    });

    it('creates environments without monitors when no alarms are supplied', () => {
      const { template } = makeStack();
      const envsWithMonitors = template.findResources('AWS::AppConfig::Environment', {
        Properties: Match.objectLike({
          Monitors: Match.anyValue(),
        }),
      });
      // Monitors property may be absent or empty when no alarms are given
      expect(Object.keys(envsWithMonitors)).toHaveLength(0);
    });
  });

  describe('HostedConfiguration (Feature Flags)', () => {
    it('creates exactly one configuration profile', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::AppConfig::ConfigurationProfile', 1);
    });

    it('names the profile feature-flags', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
        Name: 'feature-flags',
        LocationUri: 'hosted',
      });
    });

    it('uses the Freeform configuration type', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
        Type: 'AWS.Freeform',
      });
    });

    it('creates exactly one hosted configuration version', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::AppConfig::HostedConfigurationVersion', 1);
    });

    it('stores the initial config as application/json', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::HostedConfigurationVersion', {
        ContentType: 'application/json',
      });
    });

    it('includes all default feature flags in the initial config', () => {
      const { template } = makeStack();
      const versions = template.findResources('AWS::AppConfig::HostedConfigurationVersion');
      const resource = Object.values(versions)[0] as { Properties: { Content: string } };
      const content = JSON.parse(resource.Properties.Content) as Record<string, unknown>;
      expect(content).toHaveProperty('newDashboard', false);
      expect(content).toHaveProperty('darkModeDefault', true);
      expect(content).toHaveProperty('maintenanceMode', false);
      expect(content).toHaveProperty('betaFeatures', false);
      expect(content).toHaveProperty('rateLimitRequestsPerMinute', 100);
    });
  });

  describe('Initial Deployments', () => {
    it('creates one deployment per default environment (2 total)', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::AppConfig::Deployment', 2);
    });

    it('creates one deployment per custom environment', () => {
      const { template } = makeStack({
        environments: [
          { name: 'alpha' },
          { name: 'beta' },
          { name: 'gamma' },
        ],
      });
      template.resourceCountIs('AWS::AppConfig::Deployment', 3);
    });

    it('each deployment references the application and configuration profile', () => {
      const { template } = makeStack();
      const deployments = template.findResources('AWS::AppConfig::Deployment');
      for (const deployment of Object.values(deployments)) {
        const props = (deployment as { Properties: Record<string, unknown> }).Properties;
        expect(props).toHaveProperty('ApplicationId');
        expect(props).toHaveProperty('EnvironmentId');
        expect(props).toHaveProperty('DeploymentStrategyId');
        expect(props).toHaveProperty('ConfigurationProfileId');
        expect(props).toHaveProperty('ConfigurationVersion');
      }
    });
  });

  describe('IAM Managed Policy', () => {
    it('creates exactly one managed policy', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::IAM::ManagedPolicy', 1);
    });

    it('names the policy with appName prefix', () => {
      const { template } = makeStack({ appName: 'svc' });
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        ManagedPolicyName: 'svc-appconfig-read',
      });
    });

    it('grants StartConfigurationSession', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'appconfig:StartConfigurationSession',
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });

    it('grants GetLatestConfiguration', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'appconfig:GetLatestConfiguration',
              Effect: 'Allow',
            }),
          ]),
        }),
      });
    });

    it('scopes StartConfigurationSession to this application', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::IAM::ManagedPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'StartConfigurationSession',
              Resource: Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.anyValue(),
                  Match.arrayWith([
                    Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }),
                  ]),
                ]),
              }),
            }),
          ]),
        }),
      });
    });
  });

  describe('Tags', () => {
    it('tags resources with ManagedBy CDK', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::Application', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });

    it('tags resources with the Stack id', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::Application', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Stack', Value: 'TestAppConfigStack' }),
        ]),
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the application ID', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasOutput('ApplicationId', {
        Export: { Name: 'myapp-appconfig-app-id' },
      });
    });

    it('exports the configuration profile ID', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasOutput('ConfigProfileId', {
        Export: { Name: 'myapp-appconfig-flags-profile-id' },
      });
    });

    it('exports the deployment strategy ID', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasOutput('DeploymentStrategyId', {
        Export: { Name: 'myapp-appconfig-deployment-strategy-id' },
      });
    });

    it('exports the managed policy ARN', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasOutput('AppConfigReadPolicyArn', {
        Export: { Name: 'myapp-appconfig-read-policy-arn' },
      });
    });

    it('exports an environment ID for each environment', () => {
      const { template } = makeStack({ appName: 'myapp' });
      template.hasOutput('EnvIdProduction', {
        Export: { Name: 'myapp-appconfig-env-production-id' },
      });
      template.hasOutput('EnvIdStaging', {
        Export: { Name: 'myapp-appconfig-env-staging-id' },
      });
    });

    it('exports custom environment IDs when overriding environments', () => {
      const { template } = makeStack({
        appName: 'api',
        environments: [{ name: 'dev' }, { name: 'prod' }],
      });
      template.hasOutput('EnvIdDev', {
        Export: { Name: 'api-appconfig-env-dev-id' },
      });
      template.hasOutput('EnvIdProd', {
        Export: { Name: 'api-appconfig-env-prod-id' },
      });
    });
  });
});
