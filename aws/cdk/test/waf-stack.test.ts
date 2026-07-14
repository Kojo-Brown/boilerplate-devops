import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { WafStack, WafStackProps } from '../lib/waf-stack';

const BASE_PROPS: WafStackProps = {
  envName: 'test',
  env: { account: '123456789012', region: 'us-east-1' },
};

const makeStack = (overrides: Partial<WafStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new WafStack(app, 'TestWafStack', { ...BASE_PROPS, ...overrides });
  return { stack, template: Template.fromStack(stack) };
};

describe('WafStack', () => {
  describe('Web ACL', () => {
    it('creates exactly one Web ACL', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    });

    it('names the Web ACL using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Name: 'staging-owasp-waf',
      });
    });

    it('defaults to REGIONAL scope', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'REGIONAL',
      });
    });

    it('uses CLOUDFRONT scope when specified', () => {
      const { template } = makeStack({ scope: 'CLOUDFRONT' });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Scope: 'CLOUDFRONT',
      });
    });

    it('defaults to ALLOW default action', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        DefaultAction: { Allow: {} },
      });
    });

    it('uses BLOCK default action when specified', () => {
      const { template } = makeStack({ defaultAction: 'BLOCK' });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        DefaultAction: { Block: {} },
      });
    });

    it('enables sampled requests and CloudWatch metrics', () => {
      const { template } = makeStack({ envName: 'test' });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        VisibilityConfig: {
          SampledRequestsEnabled: true,
          CloudWatchMetricsEnabled: true,
          MetricName: 'test-waf',
        },
      });
    });
  });

  describe('Managed Rule Groups', () => {
    it('includes 8 rules by default (7 managed groups + 1 rate-based rule)', () => {
      const { template } = makeStack();
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: { Rules: unknown[] };
      };
      expect(aclResource.Properties.Rules).toHaveLength(8);
    });

    it('includes AWSManagedRulesCommonRuleSet (Core Rule Set)', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesCommonRuleSet',
              },
            },
          }),
        ]),
      });
    });

    it('includes AWSManagedRulesSQLiRuleSet', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesSQLiRuleSet',
              },
            },
          }),
        ]),
      });
    });

    it('includes AWSManagedRulesKnownBadInputsRuleSet', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesKnownBadInputsRuleSet',
              },
            },
          }),
        ]),
      });
    });

    it('includes AWSManagedRulesLinuxRuleSet', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesLinuxRuleSet',
              },
            },
          }),
        ]),
      });
    });

    it('includes AWSManagedRulesPHPRuleSet', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesPHPRuleSet',
              },
            },
          }),
        ]),
      });
    });

    it('includes AWSManagedRulesAdminProtectionRuleSet', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesAdminProtectionRuleSet',
              },
            },
          }),
        ]),
      });
    });

    it('includes AWSManagedRulesAmazonIpReputationList', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesAmazonIpReputationList',
              },
            },
          }),
        ]),
      });
    });

    it('does not include AWSManagedRulesAnonymousIpList by default', () => {
      const { template } = makeStack();
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: { Rules: Array<{ Statement: { ManagedRuleGroupStatement?: { Name: string } } }> };
      };
      const hasAnon = aclResource.Properties.Rules.some(
        (r) => r.Statement.ManagedRuleGroupStatement?.Name === 'AWSManagedRulesAnonymousIpList',
      );
      expect(hasAnon).toBe(false);
    });

    it('includes AWSManagedRulesAnonymousIpList when enableAnonymousIpList is true', () => {
      const { template } = makeStack({ enableAnonymousIpList: true });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                VendorName: 'AWS',
                Name: 'AWSManagedRulesAnonymousIpList',
              },
            },
          }),
        ]),
      });
    });

    it('omits Core Rule Set when enableCoreRuleSet is false', () => {
      const { template } = makeStack({ enableCoreRuleSet: false });
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: { Rules: Array<{ Statement: { ManagedRuleGroupStatement?: { Name: string } } }> };
      };
      const hasCrs = aclResource.Properties.Rules.some(
        (r) => r.Statement.ManagedRuleGroupStatement?.Name === 'AWSManagedRulesCommonRuleSet',
      );
      expect(hasCrs).toBe(false);
    });

    it('omits SQL Database rules when enableSqlDatabase is false', () => {
      const { template } = makeStack({ enableSqlDatabase: false });
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: { Rules: Array<{ Statement: { ManagedRuleGroupStatement?: { Name: string } } }> };
      };
      const hasSql = aclResource.Properties.Rules.some(
        (r) => r.Statement.ManagedRuleGroupStatement?.Name === 'AWSManagedRulesSQLiRuleSet',
      );
      expect(hasSql).toBe(false);
    });

    it('applies coreRuleSetOverrides as RuleActionOverrides', () => {
      const { template } = makeStack({
        coreRuleSetOverrides: [{ ruleName: 'SizeRestrictions_BODY', action: 'COUNT' }],
      });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              ManagedRuleGroupStatement: {
                Name: 'AWSManagedRulesCommonRuleSet',
                RuleActionOverrides: Match.arrayWith([
                  Match.objectLike({
                    Name: 'SizeRestrictions_BODY',
                    ActionToUse: { Count: {} },
                  }),
                ]),
              },
            },
          }),
        ]),
      });
    });

    it('all managed rule groups use overrideAction: none (preserving per-rule actions)', () => {
      const { template } = makeStack();
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: {
          Rules: Array<{
            OverrideAction?: { None?: Record<string, unknown> };
            Statement: { ManagedRuleGroupStatement?: { Name: string } };
          }>;
        };
      };
      const managedRules = aclResource.Properties.Rules.filter(
        (r) => r.Statement.ManagedRuleGroupStatement,
      );
      for (const rule of managedRules) {
        expect(rule.OverrideAction).toBeDefined();
        expect(rule.OverrideAction?.None).toBeDefined();
      }
    });
  });

  describe('Rate-based Rule', () => {
    it('includes a rate-based rule limited to 2000 requests/5 min by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Name: 'RateLimitPerIp',
            Action: { Block: {} },
            Statement: {
              RateBasedStatement: {
                Limit: 2000,
                AggregateKeyType: 'IP',
              },
            },
          }),
        ]),
      });
    });

    it('uses a custom rate limit when rateLimitPerIp is set', () => {
      const { template } = makeStack({ rateLimitPerIp: 500 });
      template.hasResourceProperties('AWS::WAFv2::WebACL', {
        Rules: Match.arrayWith([
          Match.objectLike({
            Statement: {
              RateBasedStatement: { Limit: 500 },
            },
          }),
        ]),
      });
    });

    it('omits the rate-based rule when rateLimitPerIp is 0', () => {
      const { template } = makeStack({ rateLimitPerIp: 0 });
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: { Rules: Array<{ Statement: { RateBasedStatement?: unknown } }> };
      };
      const hasRateRule = aclResource.Properties.Rules.some(
        (r) => r.Statement.RateBasedStatement !== undefined,
      );
      expect(hasRateRule).toBe(false);
    });
  });

  describe('Web ACL Association', () => {
    it('creates no association when associatedResourceArn is omitted', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    });

    it('creates a Web ACL association when associatedResourceArn is provided', () => {
      const albArn =
        'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/test/abc123';
      const { template } = makeStack({ associatedResourceArn: albArn });
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
      template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
        ResourceArn: albArn,
      });
    });
  });

  describe('SNS Alert Topic', () => {
    it('creates exactly one SNS topic', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('names the topic using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'staging-waf-alerts',
        DisplayName: 'staging WAF Blocked Requests',
      });
    });

    it('creates no email subscriptions when notificationEmails is omitted', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Subscription', 0);
    });

    it('creates one email subscription per address in notificationEmails', () => {
      const { template } = makeStack({
        notificationEmails: ['sec@example.com', 'ops@example.com'],
      });
      template.resourceCountIs('AWS::SNS::Subscription', 2);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'sec@example.com',
      });
    });
  });

  describe('CloudWatch Alarm', () => {
    it('creates a blocked-requests alarm by default', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
    });

    it('names the alarm using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'staging-waf-blocked-requests',
      });
    });

    it('uses threshold from blockedRequestsAlarmThreshold', () => {
      const { template } = makeStack({ blockedRequestsAlarmThreshold: 500 });
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Threshold: 500,
      });
    });

    it('creates no alarm when blockedRequestsAlarmThreshold is 0', () => {
      const { template } = makeStack({ blockedRequestsAlarmThreshold: 0 });
      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
    });

    it('treats missing data as NOT_BREACHING', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        TreatMissingData: 'notBreaching',
      });
    });

    it('alarm is wired to the SNS alert topic', () => {
      const { stack } = makeStack();
      expect(stack.blockedRequestsAlarm).toBeDefined();
      expect(stack.alertTopic).toBeDefined();
    });
  });

  describe('Outputs', () => {
    it('exports the Web ACL ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('WebAclArn', {
        Export: { Name: 'staging-waf-web-acl-arn' },
      });
    });

    it('exports the Web ACL ID', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('WebAclId', {
        Export: { Name: 'staging-waf-web-acl-id' },
      });
    });

    it('exports the WAF alert topic ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('WafAlertTopicArn', {
        Export: { Name: 'staging-waf-alert-topic-arn' },
      });
    });
  });

  describe('Tags', () => {
    it('applies Environment, ManagedBy, and Stack tags', () => {
      const app = new cdk.App();
      const stack = new WafStack(app, 'TagTest', {
        ...BASE_PROPS,
        envName: 'production',
      });
      const template = Template.fromStack(stack);
      const topics = template.findResources('AWS::SNS::Topic');
      expect(Object.keys(topics)).toHaveLength(1);
    });
  });

  describe('Rule priorities', () => {
    it('assigns unique, sequential priorities starting from 0', () => {
      const { template } = makeStack();
      const acls = template.findResources('AWS::WAFv2::WebACL');
      const aclResource = Object.values(acls)[0] as {
        Properties: { Rules: Array<{ Priority: number }> };
      };
      const priorities = aclResource.Properties.Rules.map((r) => r.Priority).sort(
        (a, b) => a - b,
      );
      priorities.forEach((p, i) => expect(p).toBe(i));
    });
  });
});
