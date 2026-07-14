import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface SecurityHubStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** Enable GuardDuty threat detection (default: true) */
  readonly enableGuardDuty?: boolean;
  /** Enable GuardDuty CloudTrail management events data source (default: true) */
  readonly enableGuardDutyCloudTrail?: boolean;
  /** Enable GuardDuty S3 data events data source (default: true) */
  readonly enableGuardDutyS3Logs?: boolean;
  /** Enable GuardDuty Kubernetes audit log data source (default: false) */
  readonly enableGuardDutyKubernetesLogs?: boolean;
  /** Enable GuardDuty Malware Protection (EBS volume scanning) (default: false) */
  readonly enableGuardDutyMalwareProtection?: boolean;
  /**
   * How often GuardDuty publishes updated findings.
   * FIFTEEN_MINUTES | ONE_HOUR | SIX_HOURS (default: SIX_HOURS)
   */
  readonly guardDutyPublishingFrequency?: 'FIFTEEN_MINUTES' | 'ONE_HOUR' | 'SIX_HOURS';
  /** Enable AWS Foundational Security Best Practices standard (default: true) */
  readonly enableFsbpStandard?: boolean;
  /** Enable CIS AWS Foundations Benchmark v1.4.0 (default: true) */
  readonly enableCisStandard?: boolean;
  /** Enable PCI DSS v3.2.1 standard (default: false) */
  readonly enablePciStandard?: boolean;
  /**
   * Minimum finding severity level that triggers an SNS alert.
   * MEDIUM | HIGH | CRITICAL (default: HIGH)
   */
  readonly findingAlertSeverity?: 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Email addresses to subscribe to the security findings SNS topic */
  readonly notificationEmails?: string[];
}

/**
 * AWS GuardDuty + Security Hub baseline configuration.
 *
 * Resources created:
 *   - GuardDuty Detector        — threat detection (CloudTrail + S3 sources by default)
 *   - Security Hub CfnHub       — aggregates findings from GuardDuty and AWS services
 *   - Security Standards        — FSBP (always), CIS Benchmark (always), PCI DSS (optional)
 *   - SNS Topic                 — receives HIGH/CRITICAL security finding alerts
 *   - EventBridge Rule (GD)     — GuardDuty HIGH+ numeric severity → SNS
 *   - EventBridge Rule (SH)     — Security Hub HIGH+ label severity → SNS
 *
 * NOTE: GuardDuty and Security Hub are regional; deploy one stack per region.
 * Only one GuardDuty detector can exist per account per region — if a detector
 * already exists, import it with CfnDetector and remove the enableGuardDuty prop.
 */
export class SecurityHubStack extends cdk.Stack {
  public readonly alertTopic: sns.Topic;
  public readonly securityHub: securityhub.CfnHub;
  public readonly guardDutyDetector: guardduty.CfnDetector | undefined;

  constructor(scope: Construct, id: string, props: SecurityHubStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const enableGuardDuty = props.enableGuardDuty ?? true;
    const enableFsbp = props.enableFsbpStandard ?? true;
    const enableCis = props.enableCisStandard ?? true;
    const enablePci = props.enablePciStandard ?? false;
    const severityLabel = props.findingAlertSeverity ?? 'HIGH';
    const notificationEmails = props.notificationEmails ?? [];
    const publishingFrequency = props.guardDutyPublishingFrequency ?? 'SIX_HOURS';

    // ── SNS Topic ────────────────────────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'SecurityFindingsTopic', {
      topicName: `${envName}-security-findings`,
      displayName: `${envName} Security Findings`,
    });

    // EventBridge needs permission to publish finding alerts to the topic.
    this.alertTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgePublish',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['SNS:Publish'],
        resources: [this.alertTopic.topicArn],
      }),
    );

    for (const email of notificationEmails) {
      this.alertTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── GuardDuty Detector ───────────────────────────────────────────────────
    if (enableGuardDuty) {
      const dataSources: guardduty.CfnDetector.CFNDataSourceConfigurationsProperty = {
        cloudTrail: { enable: props.enableGuardDutyCloudTrail ?? true },
        s3Logs: { enable: props.enableGuardDutyS3Logs ?? true },
      };

      if (props.enableGuardDutyKubernetesLogs) {
        dataSources.kubernetes = { auditLogs: { enable: true } };
      }

      if (props.enableGuardDutyMalwareProtection) {
        dataSources.malwareProtection = {
          scanEc2InstanceWithFindings: { ebsVolumes: true },
        };
      }

      this.guardDutyDetector = new guardduty.CfnDetector(this, 'GuardDutyDetector', {
        enable: true,
        findingPublishingFrequency: publishingFrequency,
        dataSources,
      });
    }

    // ── Security Hub ─────────────────────────────────────────────────────────
    // enableDefaultStandards: false — all standards are managed explicitly below
    // so that every re-deploy produces a deterministic set of enabled standards.
    this.securityHub = new securityhub.CfnHub(this, 'SecurityHub', {
      enableDefaultStandards: false,
      autoEnableControls: true,
    });

    // ── Security Standards ───────────────────────────────────────────────────
    if (enableFsbp) {
      const fsbp = new securityhub.CfnStandard(this, 'FsbpStandard', {
        standardsArn: `arn:${this.partition}:securityhub:${this.region}::standards/aws-foundational-security-best-practices/v/1.0.0`,
      });
      fsbp.addDependency(this.securityHub);
    }

    if (enableCis) {
      // CIS AWS Foundations Benchmark v1.4.0 — global ARN (no region segment)
      const cis = new securityhub.CfnStandard(this, 'CisStandard', {
        standardsArn: `arn:${this.partition}:securityhub:::ruleset/cis-aws-foundations-benchmark/v/1.4.0`,
      });
      cis.addDependency(this.securityHub);
    }

    if (enablePci) {
      const pci = new securityhub.CfnStandard(this, 'PciStandard', {
        standardsArn: `arn:${this.partition}:securityhub:${this.region}::standards/pci-dss/v/3.2.1`,
      });
      pci.addDependency(this.securityHub);
    }

    // ── EventBridge: GuardDuty findings → SNS ────────────────────────────────
    // GuardDuty severity is numeric (0–10). Map label → minimum integer:
    //   MEDIUM ≥ 4.0, HIGH ≥ 7.0, CRITICAL ≥ 9.0
    if (enableGuardDuty) {
      const gdMinSeverity = severityLabel === 'CRITICAL' ? 9 : severityLabel === 'HIGH' ? 7 : 4;

      new events.Rule(this, 'GuardDutyFindingsRule', {
        ruleName: `${envName}-guardduty-findings`,
        description: `GuardDuty findings with numeric severity >= ${gdMinSeverity} → SNS`,
        eventPattern: {
          source: ['aws.guardduty'],
          detailType: ['GuardDuty Finding'],
          detail: {
            severity: [{ numeric: ['>=', gdMinSeverity] }],
          },
        },
        targets: [
          new events_targets.SnsTopic(this.alertTopic, {
            message: events.RuleTargetInput.fromEventPath('$.detail'),
          }),
        ],
      });
    }

    // ── EventBridge: Security Hub findings → SNS ─────────────────────────────
    new events.Rule(this, 'SecurityHubFindingsRule', {
      ruleName: `${envName}-securityhub-findings`,
      description: `Security Hub ${severityLabel}+ findings → SNS`,
      eventPattern: {
        source: ['aws.securityhub'],
        detailType: ['Security Hub Findings - Imported'],
        detail: {
          findings: {
            Severity: {
              Label: this.severityLabelsFrom(severityLabel),
            },
            RecordState: ['ACTIVE'],
            Workflow: {
              Status: ['NEW'],
            },
          },
        },
      },
      targets: [
        new events_targets.SnsTopic(this.alertTopic, {
          message: events.RuleTargetInput.fromEventPath('$.detail'),
        }),
      ],
    });

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SecurityFindingsTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for security finding alerts',
      exportName: `${envName}-security-findings-topic-arn`,
    });

    if (this.guardDutyDetector) {
      new cdk.CfnOutput(this, 'GuardDutyDetectorId', {
        value: this.guardDutyDetector.attrDetectorId,
        description: 'GuardDuty detector ID',
        exportName: `${envName}-guardduty-detector-id`,
      });
    }
  }

  private severityLabelsFrom(minimum: 'MEDIUM' | 'HIGH' | 'CRITICAL'): string[] {
    const ordered = ['MEDIUM', 'HIGH', 'CRITICAL'] as const;
    const idx = ordered.indexOf(minimum);
    return ordered.slice(idx);
  }
}
