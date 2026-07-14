import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatch_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_sub from 'aws-cdk-lib/aws-sns-subscriptions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

export type WafScope = 'REGIONAL' | 'CLOUDFRONT';

export interface WafRuleOverride {
  /** Name of the rule inside the managed rule group */
  readonly ruleName: string;
  /** Override action: COUNT (observe only) or BLOCK */
  readonly action: 'COUNT' | 'BLOCK';
}

export interface WafStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /**
   * Scope of the Web ACL.
   * REGIONAL — protects ALB, API Gateway, AppSync (deploy in the service region).
   * CLOUDFRONT — must be deployed in us-east-1 and associated with a CloudFront distribution.
   * Default: REGIONAL
   */
  readonly scope?: WafScope;
  /**
   * ARN of the ALB (or other resource) to associate the Web ACL with.
   * Omit to create the ACL without an association; associate manually afterwards.
   */
  readonly associatedResourceArn?: string;
  /** Enable the AWS Core Rule Set (CRS) — covers OWASP A1-A10 broadly (default: true) */
  readonly enableCoreRuleSet?: boolean;
  /**
   * Per-IP rate limit (requests per 5-minute window).
   * Set to 0 to disable rate limiting.  Default: 2000
   */
  readonly rateLimitPerIp?: number;
  /** Enable the Known Bad Inputs managed rule group (default: true) */
  readonly enableKnownBadInputs?: boolean;
  /** Enable the SQL Database managed rule group (default: true) */
  readonly enableSqlDatabase?: boolean;
  /** Enable the Linux operating system managed rule group (default: true) */
  readonly enableLinuxRuleSet?: boolean;
  /** Enable the PHP managed rule group (default: true) */
  readonly enablePhpRuleSet?: boolean;
  /** Enable the Admin Protection managed rule group (default: true) */
  readonly enableAdminProtection?: boolean;
  /** Enable the Amazon IP Reputation List (default: true) */
  readonly enableAmazonIpReputation?: boolean;
  /** Enable the Anonymous IP List (Tor, VPNs, hosting providers) (default: false) */
  readonly enableAnonymousIpList?: boolean;
  /**
   * Per-rule overrides — use to COUNT instead of BLOCK during an evaluation period
   * before fully enabling a rule.  E.g. [{ ruleName: 'SizeRestrictions_BODY', action: 'COUNT' }]
   */
  readonly coreRuleSetOverrides?: WafRuleOverride[];
  /** Email addresses to subscribe to the blocked-requests SNS topic */
  readonly notificationEmails?: string[];
  /**
   * Threshold for the BlockedRequests CloudWatch alarm.
   * Triggers when blocked requests per 5 minutes exceed this value.
   * Set to 0 to disable the alarm.  Default: 100
   */
  readonly blockedRequestsAlarmThreshold?: number;
  /**
   * Default action when no rule matches.
   * ALLOW (default) — pass the request through.
   * BLOCK — deny all requests not explicitly allowed by a rule (inverted allowlist mode).
   */
  readonly defaultAction?: 'ALLOW' | 'BLOCK';
}

/**
 * AWS WAFv2 Web ACL with OWASP Top 10 managed rule groups.
 *
 * Managed rule groups enabled by default:
 *   AWSManagedRulesAmazonIpReputationList — blocks known malicious IPs (OWASP A7)
 *   AWSManagedRulesCommonRuleSet          — CRS: XSS (A7), injection (A1), RCE, path traversal
 *   AWSManagedRulesKnownBadInputsRuleSet  — log4j, Spring4Shell, SSRF payloads
 *   AWSManagedRulesSQLiRuleSet            — SQL injection (OWASP A1)
 *   AWSManagedRulesLinuxRuleSet           — LFI, command injection (OWASP A1/A3)
 *   AWSManagedRulesPHPRuleSet             — PHP injection and unsafe function calls
 *   AWSManagedRulesAdminProtectionRuleSet — restricts access to /admin/* paths (OWASP A5)
 *
 * Additionally:
 *   Rate-based rule — per-IP rate limit (default 2,000 req/5 min) (OWASP A6 / DoS)
 *   BlockedRequests alarm — CloudWatch alarm when blocked count exceeds threshold
 *
 * Scope notes:
 *   REGIONAL stacks can be deployed in any region.
 *   CLOUDFRONT stacks MUST be deployed in us-east-1.
 */
export class WafStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly alertTopic: sns.Topic;
  public readonly blockedRequestsAlarm: cloudwatch.Alarm | undefined;

  constructor(scope: Construct, id: string, props: WafStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const wafScope = props.scope ?? 'REGIONAL';
    const defaultAction = props.defaultAction ?? 'ALLOW';
    const rateLimitPerIp = props.rateLimitPerIp ?? 2000;
    const blockedAlarmThreshold = props.blockedRequestsAlarmThreshold ?? 100;
    const notificationEmails = props.notificationEmails ?? [];

    // ── SNS Alert Topic ──────────────────────────────────────────────────────
    this.alertTopic = new sns.Topic(this, 'WafAlertTopic', {
      topicName: `${envName}-waf-alerts`,
      displayName: `${envName} WAF Blocked Requests`,
    });

    for (const email of notificationEmails) {
      this.alertTopic.addSubscription(new sns_sub.EmailSubscription(email));
    }

    // ── WAF Rules ────────────────────────────────────────────────────────────
    const rules: wafv2.CfnWebACL.RuleProperty[] = [];
    let priority = 0;

    // Amazon IP Reputation List — blocks IPs flagged by Amazon threat intelligence
    if (props.enableAmazonIpReputation !== false) {
      rules.push(
        this.managedRuleGroup(
          'AmazonIpReputationList',
          'AWSManagedRulesAmazonIpReputationList',
          priority++,
          [],
        ),
      );
    }

    // Anonymous IP List — Tor exit nodes, VPN providers, hosting ranges
    if (props.enableAnonymousIpList === true) {
      rules.push(
        this.managedRuleGroup(
          'AnonymousIpList',
          'AWSManagedRulesAnonymousIpList',
          priority++,
          [],
        ),
      );
    }

    // Core Rule Set — broad OWASP coverage (XSS, injection, RCE, SSRF, etc.)
    if (props.enableCoreRuleSet !== false) {
      rules.push(
        this.managedRuleGroup(
          'CoreRuleSet',
          'AWSManagedRulesCommonRuleSet',
          priority++,
          props.coreRuleSetOverrides ?? [],
        ),
      );
    }

    // Known Bad Inputs — log4j (CVE-2021-44228), Spring4Shell, Host header SSRF
    if (props.enableKnownBadInputs !== false) {
      rules.push(
        this.managedRuleGroup(
          'KnownBadInputs',
          'AWSManagedRulesKnownBadInputsRuleSet',
          priority++,
          [],
        ),
      );
    }

    // SQL Database — SQL injection patterns (OWASP A1)
    if (props.enableSqlDatabase !== false) {
      rules.push(
        this.managedRuleGroup(
          'SQLiRuleSet',
          'AWSManagedRulesSQLiRuleSet',
          priority++,
          [],
        ),
      );
    }

    // Linux OS — LFI, path traversal, command injection (OWASP A1/A3)
    if (props.enableLinuxRuleSet !== false) {
      rules.push(
        this.managedRuleGroup(
          'LinuxRuleSet',
          'AWSManagedRulesLinuxRuleSet',
          priority++,
          [],
        ),
      );
    }

    // PHP — PHP-specific injection and unsafe function calls
    if (props.enablePhpRuleSet !== false) {
      rules.push(
        this.managedRuleGroup(
          'PHPRuleSet',
          'AWSManagedRulesPHPRuleSet',
          priority++,
          [],
        ),
      );
    }

    // Admin Protection — blocks access to admin panels and sensitive paths (OWASP A5)
    if (props.enableAdminProtection !== false) {
      rules.push(
        this.managedRuleGroup(
          'AdminProtection',
          'AWSManagedRulesAdminProtectionRuleSet',
          priority++,
          [],
        ),
      );
    }

    // Rate-based rule — per-source-IP limit (OWASP A6 / DoS mitigation)
    if (rateLimitPerIp > 0) {
      rules.push({
        name: 'RateLimitPerIp',
        priority: priority++,
        action: { block: {} },
        visibilityConfig: {
          sampledRequestsEnabled: true,
          cloudWatchMetricsEnabled: true,
          metricName: `${envName}-waf-rate-limit`,
        },
        statement: {
          rateBasedStatement: {
            limit: rateLimitPerIp,
            aggregateKeyType: 'IP',
          },
        },
      });
    }

    // ── Web ACL ──────────────────────────────────────────────────────────────
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `${envName}-owasp-waf`,
      scope: wafScope,
      defaultAction: defaultAction === 'ALLOW' ? { allow: {} } : { block: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `${envName}-waf`,
      },
      rules,
    });

    // ── Resource Association ─────────────────────────────────────────────────
    if (props.associatedResourceArn) {
      new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
        resourceArn: props.associatedResourceArn,
        webAclArn: this.webAcl.attrArn,
      });
    }

    // ── CloudWatch Alarm: blocked requests ───────────────────────────────────
    if (blockedAlarmThreshold > 0) {
      const blockedMetric = new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          WebACL: `${envName}-owasp-waf`,
          Region: this.region,
          Rule: 'ALL',
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5),
      });

      this.blockedRequestsAlarm = new cloudwatch.Alarm(this, 'BlockedRequestsAlarm', {
        alarmName: `${envName}-waf-blocked-requests`,
        alarmDescription: `WAF blocked > ${blockedAlarmThreshold} requests in 5 minutes`,
        metric: blockedMetric,
        threshold: blockedAlarmThreshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

      this.blockedRequestsAlarm.addAlarmAction(
        new cloudwatch_actions.SnsAction(this.alertTopic),
      );
      this.blockedRequestsAlarm.addOkAction(
        new cloudwatch_actions.SnsAction(this.alertTopic),
      );
    }

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAcl.attrArn,
      description: 'WAF Web ACL ARN — use for CloudFront or ALB association',
      exportName: `${envName}-waf-web-acl-arn`,
    });

    new cdk.CfnOutput(this, 'WebAclId', {
      value: this.webAcl.attrId,
      description: 'WAF Web ACL ID',
      exportName: `${envName}-waf-web-acl-id`,
    });

    new cdk.CfnOutput(this, 'WafAlertTopicArn', {
      value: this.alertTopic.topicArn,
      description: 'SNS topic ARN for WAF blocked-request alerts',
      exportName: `${envName}-waf-alert-topic-arn`,
    });
  }

  private managedRuleGroup(
    logicalId: string,
    managedRuleName: string,
    priority: number,
    overrides: WafRuleOverride[],
  ): wafv2.CfnWebACL.RuleProperty {
    const ruleActionOverrides: wafv2.CfnWebACL.RuleActionOverrideProperty[] = overrides.map(
      (o) => ({
        name: o.ruleName,
        actionToUse: o.action === 'COUNT' ? { count: {} } : { block: {} },
      }),
    );

    return {
      name: logicalId,
      priority,
      overrideAction: { none: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `waf-${logicalId.toLowerCase()}`,
      },
      statement: {
        managedRuleGroupStatement: {
          vendorName: 'AWS',
          name: managedRuleName,
          ...(ruleActionOverrides.length > 0 ? { ruleActionOverrides } : {}),
        },
      },
    };
  }
}
