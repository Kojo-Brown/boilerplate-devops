import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  AppConfigStack,
  AppConfigStackProps,
  DEFAULT_FEATURE_FLAGS_MANIFEST_PATH,
} from '../lib/appconfig-stack';
import { auditFeatureFlags, FEATURE_FLAG_MANIFEST_SCHEMA } from '../tools/audit-feature-flags';
import { flattenIntrinsic, resourceProps, TOKEN } from './support/cfn';

/** The manifest CDK puts into the first hosted configuration version. */
const bootstrappedContent = (template: Template): unknown => {
  const versions = template.findResources('AWS::AppConfig::HostedConfigurationVersion');
  const resource = Object.values(versions)[0] as { Properties: { Content: string } };
  return JSON.parse(resource.Properties.Content) as unknown;
};

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
      // The Monitors property is always emitted; with no alarms it is an empty
      // list, so assert emptiness rather than absence.
      const monitors = resourceProps(template, 'AWS::AppConfig::Environment').map(
        (env) => (env.Monitors as unknown[]) ?? [],
      );
      expect(monitors).toHaveLength(2);
      for (const envMonitors of monitors) {
        expect(envMonitors).toHaveLength(0);
      }
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

    it('bootstraps from the manifest in the repository, byte for byte', () => {
      const { template } = makeStack();
      expect(bootstrappedContent(template)).toEqual(
        JSON.parse(fs.readFileSync(DEFAULT_FEATURE_FLAGS_MANIFEST_PATH, 'utf8')),
      );
    });

    it('bootstraps a manifest that passes the audit gate', () => {
      // The initial version is deployed to every environment the moment the
      // stack is created, and it is the one version no pull request reviews.
      // Without this, `npm run audit:flags` could be green while the flags CDK
      // actually ships are anything at all.
      const { template } = makeStack();
      expect(auditFeatureFlags(bootstrappedContent(template))).toEqual([]);
    });

    it('reads a caller-supplied manifest instead when given one', () => {
      const manifestPath = path.join(os.tmpdir(), 'feature-flags.override.test.json');
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          version: '1',
          flags: {
            killSwitch: {
              description: 'Stop serving writes.',
              kind: 'operational',
              owner: '@sre',
              createdOn: '2026-01-05',
              enabled: false,
            },
          },
        }),
      );

      try {
        const { template } = makeStack({ featureFlagsManifestPath: manifestPath });
        expect(bootstrappedContent(template)).toHaveProperty('flags.killSwitch');
      } finally {
        fs.unlinkSync(manifestPath);
      }
    });

    it('attaches the manifest schema as a JSON Schema validator', () => {
      // AppConfig applies validators on CreateHostedConfigurationVersion, which
      // is the only check still standing when someone uploads a version by hand
      // instead of through the workflow.
      const { template } = makeStack();
      template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
        Validators: [
          Match.objectLike({
            Type: 'JSON_SCHEMA',
            Content: Match.serializedJson(
              Match.objectLike({ required: ['version', 'flags'] }),
            ),
          }),
        ],
      });
    });

    it('validates the manifest schema against a flag missing its owner', () => {
      // Guards the schema itself: `additionalProperties: false` plus a required
      // list is easy to get subtly wrong, and a validator that accepts
      // everything looks identical to one that works.
      const validator = new Ajv({ strict: false }).compile(FEATURE_FLAG_MANIFEST_SCHEMA);
      const flag = {
        description: 'Rebuilt dashboard.',
        kind: 'release',
        owner: '@web-platform',
        createdOn: '2026-08-03',
        enabled: true,
      };

      expect(validator({ version: '1', flags: { newDashboard: flag } })).toBe(true);
      expect(
        validator({ version: '1', flags: { newDashboard: { ...flag, owner: undefined } } }),
      ).toBe(false);
      expect(
        validator({ version: '1', flags: { newDashboard: { ...flag, kind: 'temporary' } } }),
      ).toBe(false);
      expect(
        validator({ version: '1', flags: { newDashboard: { ...flag, rolloutPct: 50 } } }),
      ).toBe(false);
      expect(
        validator({ version: '1', flags: { newDashboard: { ...flag, rolloutPercentage: 101 } } }),
      ).toBe(false);
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
      const [policy] = resourceProps(template, 'AWS::IAM::ManagedPolicy');
      const { Statement } = policy.PolicyDocument as {
        Statement: { Sid: string; Resource: unknown }[];
      };
      const statement = Statement.find((s) => s.Sid === 'StartConfigurationSession');
      expect(statement).toBeDefined();

      // The resource ARN interpolates the application id, so it synthesizes to an
      // Fn::Join. Flattening it proves the grant is scoped to this application
      // rather than a bare wildcard.
      const resource = flattenIntrinsic(statement!.Resource);
      expect(resource).toContain(':appconfig:');
      expect(resource).toContain(`application/${TOKEN}`);
      expect(resource).not.toBe('*');
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
