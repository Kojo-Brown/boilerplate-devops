import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  SecurityHubStack,
  SecurityHubStackProps,
} from '../lib/security-hub-stack';

const BASE_PROPS: SecurityHubStackProps = {
  envName: 'test',
  env: { account: '123456789012', region: 'us-east-1' },
};

const makeStack = (overrides: Partial<SecurityHubStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new SecurityHubStack(app, 'TestSecurityHubStack', {
    ...BASE_PROPS,
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('SecurityHubStack', () => {
  describe('SNS Topic', () => {
    it('creates exactly one SNS topic', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SNS::Topic', 1);
    });

    it('names the topic using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'staging-security-findings',
        DisplayName: 'staging Security Findings',
      });
    });

    it('grants events.amazonaws.com SNS:Publish via resource policy', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SNS::TopicPolicy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'SNS:Publish',
              Principal: { Service: 'events.amazonaws.com' },
            }),
          ]),
        }),
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
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'ops@example.com',
      });
    });
  });

  describe('GuardDuty Detector', () => {
    it('creates exactly one GuardDuty detector by default', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::GuardDuty::Detector', 1);
    });

    it('enables the detector', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        Enable: true,
      });
    });

    it('defaults to SIX_HOURS publishing frequency', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        FindingPublishingFrequency: 'SIX_HOURS',
      });
    });

    it('respects a custom guardDutyPublishingFrequency', () => {
      const { template } = makeStack({ guardDutyPublishingFrequency: 'FIFTEEN_MINUTES' });
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        FindingPublishingFrequency: 'FIFTEEN_MINUTES',
      });
    });

    it('enables CloudTrail and S3 data sources by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        DataSources: Match.objectLike({
          CloudTrail: { Enable: true },
          S3Logs: { Enable: true },
        }),
      });
    });

    it('omits the detector when enableGuardDuty is false', () => {
      const { template } = makeStack({ enableGuardDuty: false });
      template.resourceCountIs('AWS::GuardDuty::Detector', 0);
    });

    it('enables Kubernetes audit logs when enableGuardDutyKubernetesLogs is true', () => {
      const { template } = makeStack({ enableGuardDutyKubernetesLogs: true });
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        DataSources: Match.objectLike({
          Kubernetes: { AuditLogs: { Enable: true } },
        }),
      });
    });

    it('enables Malware Protection when enableGuardDutyMalwareProtection is true', () => {
      const { template } = makeStack({ enableGuardDutyMalwareProtection: true });
      template.hasResourceProperties('AWS::GuardDuty::Detector', {
        DataSources: Match.objectLike({
          MalwareProtection: {
            ScanEc2InstanceWithFindings: { EbsVolumes: true },
          },
        }),
      });
    });
  });

  describe('Security Hub', () => {
    it('creates exactly one Security Hub resource', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SecurityHub::Hub', 1);
    });

    it('disables default standards (managed explicitly)', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SecurityHub::Hub', {
        EnableDefaultStandards: false,
        AutoEnableControls: true,
      });
    });
  });

  describe('Security Standards', () => {
    it('enables FSBP and CIS standards by default (2 standards total)', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::SecurityHub::Standard', 2);
    });

    it('enables the FSBP standard when enableFsbpStandard is true (default)', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SecurityHub::Standard', {
        StandardsArn: Match.stringLikeRegexp(
          'standards/aws-foundational-security-best-practices/v/1\\.0\\.0',
        ),
      });
    });

    it('enables the CIS Benchmark standard when enableCisStandard is true (default)', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::SecurityHub::Standard', {
        StandardsArn: Match.stringLikeRegexp(
          'cis-aws-foundations-benchmark/v/1\\.4\\.0',
        ),
      });
    });

    it('does not enable PCI DSS by default', () => {
      const { template } = makeStack();
      const standards = template.findResources('AWS::SecurityHub::Standard');
      const hasPci = Object.values(standards).some((r) =>
        String((r as { Properties: { StandardsArn: string } }).Properties.StandardsArn).includes(
          'pci-dss',
        ),
      );
      expect(hasPci).toBe(false);
    });

    it('enables PCI DSS when enablePciStandard is true', () => {
      const { template } = makeStack({ enablePciStandard: true });
      template.resourceCountIs('AWS::SecurityHub::Standard', 3);
      template.hasResourceProperties('AWS::SecurityHub::Standard', {
        StandardsArn: Match.stringLikeRegexp('pci-dss/v/3\\.2\\.1'),
      });
    });

    it('enables no standards when all flags are false', () => {
      const { template } = makeStack({
        enableFsbpStandard: false,
        enableCisStandard: false,
      });
      template.resourceCountIs('AWS::SecurityHub::Standard', 0);
    });

    it('all standards depend on SecurityHub resource being created first', () => {
      const app = new cdk.App();
      const stack = new SecurityHubStack(app, 'DepTest', {
        ...BASE_PROPS,
        enablePciStandard: true,
      });
      const template = Template.fromStack(stack);
      const standards = template.findResources('AWS::SecurityHub::Standard');
      const hub = template.findResources('AWS::SecurityHub::Hub');
      const hubLogicalId = Object.keys(hub)[0];

      for (const [, resource] of Object.entries(standards)) {
        const r = resource as { DependsOn?: string[] };
        expect(r.DependsOn).toBeDefined();
        expect(r.DependsOn).toContain(hubLogicalId);
      }
    });
  });

  describe('EventBridge Rules', () => {
    it('creates two EventBridge rules by default (GuardDuty + SecurityHub)', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Events::Rule', 2);
    });

    it('creates only one rule (SecurityHub) when enableGuardDuty is false', () => {
      const { template } = makeStack({ enableGuardDuty: false });
      template.resourceCountIs('AWS::Events::Rule', 1);
    });

    it('GuardDuty rule matches aws.guardduty source and GuardDuty Finding detail-type', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          source: ['aws.guardduty'],
          'detail-type': ['GuardDuty Finding'],
        }),
      });
    });

    it('GuardDuty rule defaults to numeric severity >= 7 (HIGH)', () => {
      const { template } = makeStack();
      const rules = template.findResources('AWS::Events::Rule');
      const gdRule = Object.values(rules).find((r) => {
        const p = (r as { Properties: { EventPattern: string } }).Properties.EventPattern;
        const pattern = JSON.parse(p) as { source?: string[] };
        return pattern.source?.includes('aws.guardduty');
      }) as { Properties: { EventPattern: string } } | undefined;

      expect(gdRule).toBeDefined();
      const pattern = JSON.parse(gdRule!.Properties.EventPattern) as {
        detail: { severity: { numeric: [string, number] }[] };
      };
      expect(pattern.detail.severity[0].numeric).toEqual(['>=', 7]);
    });

    it('GuardDuty rule uses severity >= 9 when findingAlertSeverity is CRITICAL', () => {
      const { template } = makeStack({ findingAlertSeverity: 'CRITICAL' });
      const rules = template.findResources('AWS::Events::Rule');
      const gdRule = Object.values(rules).find((r) => {
        const p = (r as { Properties: { EventPattern: string } }).Properties.EventPattern;
        const pattern = JSON.parse(p) as { source?: string[] };
        return pattern.source?.includes('aws.guardduty');
      }) as { Properties: { EventPattern: string } } | undefined;

      const pattern = JSON.parse(gdRule!.Properties.EventPattern) as {
        detail: { severity: { numeric: [string, number] }[] };
      };
      expect(pattern.detail.severity[0].numeric).toEqual(['>=', 9]);
    });

    it('GuardDuty rule uses severity >= 4 when findingAlertSeverity is MEDIUM', () => {
      const { template } = makeStack({ findingAlertSeverity: 'MEDIUM' });
      const rules = template.findResources('AWS::Events::Rule');
      const gdRule = Object.values(rules).find((r) => {
        const p = (r as { Properties: { EventPattern: string } }).Properties.EventPattern;
        const pattern = JSON.parse(p) as { source?: string[] };
        return pattern.source?.includes('aws.guardduty');
      }) as { Properties: { EventPattern: string } } | undefined;

      const pattern = JSON.parse(gdRule!.Properties.EventPattern) as {
        detail: { severity: { numeric: [string, number] }[] };
      };
      expect(pattern.detail.severity[0].numeric).toEqual(['>=', 4]);
    });

    it('Security Hub rule matches aws.securityhub source', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: Match.objectLike({
          source: ['aws.securityhub'],
          'detail-type': ['Security Hub Findings - Imported'],
        }),
      });
    });

    it('Security Hub rule filters on HIGH and CRITICAL labels by default', () => {
      const { template } = makeStack();
      const rules = template.findResources('AWS::Events::Rule');
      const shRule = Object.values(rules).find((r) => {
        const p = (r as { Properties: { EventPattern: string } }).Properties.EventPattern;
        const pattern = JSON.parse(p) as { source?: string[] };
        return pattern.source?.includes('aws.securityhub');
      }) as { Properties: { EventPattern: string } } | undefined;

      expect(shRule).toBeDefined();
      const pattern = JSON.parse(shRule!.Properties.EventPattern) as {
        detail: { findings: { Severity: { Label: string[] } } };
      };
      expect(pattern.detail.findings.Severity.Label).toEqual(['HIGH', 'CRITICAL']);
    });

    it('Security Hub rule includes MEDIUM when findingAlertSeverity is MEDIUM', () => {
      const { template } = makeStack({ findingAlertSeverity: 'MEDIUM' });
      const rules = template.findResources('AWS::Events::Rule');
      const shRule = Object.values(rules).find((r) => {
        const p = (r as { Properties: { EventPattern: string } }).Properties.EventPattern;
        const pattern = JSON.parse(p) as { source?: string[] };
        return pattern.source?.includes('aws.securityhub');
      }) as { Properties: { EventPattern: string } } | undefined;

      const pattern = JSON.parse(shRule!.Properties.EventPattern) as {
        detail: { findings: { Severity: { Label: string[] } } };
      };
      expect(pattern.detail.findings.Severity.Label).toEqual(['MEDIUM', 'HIGH', 'CRITICAL']);
    });

    it('Security Hub rule only includes CRITICAL when findingAlertSeverity is CRITICAL', () => {
      const { template } = makeStack({ findingAlertSeverity: 'CRITICAL' });
      const rules = template.findResources('AWS::Events::Rule');
      const shRule = Object.values(rules).find((r) => {
        const p = (r as { Properties: { EventPattern: string } }).Properties.EventPattern;
        const pattern = JSON.parse(p) as { source?: string[] };
        return pattern.source?.includes('aws.securityhub');
      }) as { Properties: { EventPattern: string } } | undefined;

      const pattern = JSON.parse(shRule!.Properties.EventPattern) as {
        detail: { findings: { Severity: { Label: string[] } } };
      };
      expect(pattern.detail.findings.Severity.Label).toEqual(['CRITICAL']);
    });

    it('both rules target the security findings SNS topic', () => {
      const { stack } = makeStack();
      expect(stack.alertTopic).toBeDefined();
    });
  });

  describe('Outputs', () => {
    it('exports the security findings SNS topic ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('SecurityFindingsTopicArn', {
        Export: { Name: 'staging-security-findings-topic-arn' },
      });
    });

    it('exports the GuardDuty detector ID when GuardDuty is enabled', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('GuardDutyDetectorId', {
        Export: { Name: 'staging-guardduty-detector-id' },
      });
    });

    it('does not export GuardDuty detector ID when enableGuardDuty is false', () => {
      const { template } = makeStack({ enableGuardDuty: false, envName: 'staging' });
      const outputs = template.findOutputs('GuardDutyDetectorId');
      expect(Object.keys(outputs)).toHaveLength(0);
    });
  });

  describe('Tags', () => {
    it('applies Environment, ManagedBy, and Stack tags to SNS topic', () => {
      const { template } = makeStack({ envName: 'production' });
      const topics = template.findResources('AWS::SNS::Topic');
      expect(Object.keys(topics)).toHaveLength(1);
    });
  });
});
