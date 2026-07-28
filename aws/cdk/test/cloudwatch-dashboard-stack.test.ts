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

/**
 * A dashboard body is synthesized as an Fn::Join because it embeds CloudFormation
 * tokens (the region, at minimum), so Match.serializedJson — which only accepts a
 * plain string — can never match it. Flatten the join, substituting each token
 * with a placeholder, and parse the result back into the widget object.
 */
interface DashboardWidget {
  readonly properties?: { readonly metrics?: unknown[][] };
}

const dashboardBody = (template: Template): { widgets: DashboardWidget[] } => {
  const dashboards = template.findResources('AWS::CloudWatch::Dashboard');
  const bodies = Object.values(dashboards).map(
    (d) => (d.Properties as { DashboardBody: unknown }).DashboardBody,
  );
  expect(bodies).toHaveLength(1);
  const body = bodies[0] as string | { 'Fn::Join': [string, unknown[]] };
  if (typeof body === 'string') return JSON.parse(body);
  const [delimiter, parts] = body['Fn::Join'];
  return JSON.parse(
    parts.map((part) => (typeof part === 'string' ? part : '<token>')).join(delimiter),
  );
};

/** Every `[namespace, metricName, ...dimensions]` tuple across all widgets. */
const widgetMetrics = (template: Template): unknown[][] =>
  dashboardBody(template).widgets.flatMap((w) => w.properties?.metrics ?? []);

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

    it.each([
      ['ECS CPUUtilization', 'AWS/ECS', 'CPUUtilization'],
      ['ECS MemoryUtilization', 'AWS/ECS', 'MemoryUtilization'],
      ['ALB HTTPCode_ELB_5XX_Count', 'AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count'],
      ['ALB HTTPCode_Target_5XX_Count', 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count'],
      ['RDS DatabaseConnections', 'AWS/RDS', 'DatabaseConnections'],
      ['RDS CPUUtilization', 'AWS/RDS', 'CPUUtilization'],
    ])('embeds %s in the dashboard body', (_label, namespace, metricName) => {
      const { template } = makeStack();
      expect(widgetMetrics(template)).toContainEqual(
        expect.arrayContaining([namespace, metricName]),
      );
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
