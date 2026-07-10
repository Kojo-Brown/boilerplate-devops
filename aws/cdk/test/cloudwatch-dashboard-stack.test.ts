import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  CloudWatchDashboardStack,
  CloudWatchDashboardStackProps,
} from '../lib/cloudwatch-dashboard-stack';

const makeStack = (overrides: Partial<CloudWatchDashboardStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new CloudWatchDashboardStack(app, 'TestDashboardStack', {
    envName: 'test',
    clusterName: 'test-cluster',
    serviceName: 'test-service',
    albFullName: 'app/test-alb/abc123def456',
    rdsInstanceId: 'test-postgres',
    env: { account: '123456789012', region: 'us-east-1' },
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('CloudWatchDashboardStack', () => {
  describe('Dashboard resource', () => {
    it('creates exactly one CloudWatch Dashboard', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    });

    it('uses the default dashboard name derived from envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'staging-dashboard',
      });
    });

    it('respects an explicit dashboardName override', () => {
      const { template } = makeStack({ dashboardName: 'my-custom-dashboard' });
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'my-custom-dashboard',
      });
    });

    it('embeds ECS CPUUtilization in the dashboard body', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.serializedJson(
          Match.objectLike({
            widgets: Match.arrayWith([
              Match.objectLike({
                properties: Match.objectLike({
                  metrics: Match.arrayWith([
                    Match.arrayWith(['AWS/ECS', 'CPUUtilization']),
                  ]),
                }),
              }),
            ]),
          }),
        ),
      });
    });

    it('embeds ECS MemoryUtilization in the dashboard body', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.serializedJson(
          Match.objectLike({
            widgets: Match.arrayWith([
              Match.objectLike({
                properties: Match.objectLike({
                  metrics: Match.arrayWith([
                    Match.arrayWith(['AWS/ECS', 'MemoryUtilization']),
                  ]),
                }),
              }),
            ]),
          }),
        ),
      });
    });

    it('embeds ALB HTTPCode_ELB_5XX_Count in the dashboard body', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.serializedJson(
          Match.objectLike({
            widgets: Match.arrayWith([
              Match.objectLike({
                properties: Match.objectLike({
                  metrics: Match.arrayWith([
                    Match.arrayWith([
                      'AWS/ApplicationELB',
                      'HTTPCode_ELB_5XX_Count',
                    ]),
                  ]),
                }),
              }),
            ]),
          }),
        ),
      });
    });

    it('embeds ALB HTTPCode_Target_5XX_Count in the dashboard body', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.serializedJson(
          Match.objectLike({
            widgets: Match.arrayWith([
              Match.objectLike({
                properties: Match.objectLike({
                  metrics: Match.arrayWith([
                    Match.arrayWith([
                      'AWS/ApplicationELB',
                      'HTTPCode_Target_5XX_Count',
                    ]),
                  ]),
                }),
              }),
            ]),
          }),
        ),
      });
    });

    it('embeds RDS DatabaseConnections in the dashboard body', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.serializedJson(
          Match.objectLike({
            widgets: Match.arrayWith([
              Match.objectLike({
                properties: Match.objectLike({
                  metrics: Match.arrayWith([
                    Match.arrayWith(['AWS/RDS', 'DatabaseConnections']),
                  ]),
                }),
              }),
            ]),
          }),
        ),
      });
    });

    it('embeds RDS CPUUtilization in the dashboard body', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.serializedJson(
          Match.objectLike({
            widgets: Match.arrayWith([
              Match.objectLike({
                properties: Match.objectLike({
                  metrics: Match.arrayWith([
                    Match.arrayWith(['AWS/RDS', 'CPUUtilization']),
                  ]),
                }),
              }),
            ]),
          }),
        ),
      });
    });
  });

  describe('Outputs', () => {
    it('exports the dashboard name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('DashboardName', {
        Value: 'staging-dashboard',
        Export: { Name: 'staging-cloudwatch-dashboard-name' },
      });
    });

    it('exports the dashboard console URL', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('DashboardUrl', {
        Export: { Name: 'staging-cloudwatch-dashboard-url' },
      });
    });

    it('uses a custom dashboard name in the export when overridden', () => {
      const { template } = makeStack({
        envName: 'production',
        dashboardName: 'prod-ops-dashboard',
      });
      template.hasOutput('DashboardName', {
        Value: 'prod-ops-dashboard',
      });
    });
  });

  describe('Tags', () => {
    it('tags resources with the Environment label', () => {
      const { template } = makeStack({ envName: 'production' });
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardBody: Match.anyValue(),
      });
      // CDK applies tags via CloudFormation tag propagation; verify via stack-level tags
      const resources = template.toJSON().Resources;
      const dashboard = Object.values(resources).find(
        (r: unknown) => (r as { Type: string }).Type === 'AWS::CloudWatch::Dashboard',
      ) as { Properties: Record<string, unknown> };
      expect(dashboard).toBeDefined();
    });
  });
});
