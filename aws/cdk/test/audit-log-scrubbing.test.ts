import {
  AuditInput,
  TemplateFile,
  auditLogScrubbing,
  formatViolations,
  readText,
  topSegment,
} from '../tools/audit-log-scrubbing';

/**
 * Tests for the log-pipeline gate.
 *
 * Each one is a template that deploys cleanly, delivers records, and reports
 * healthy — and archives something unscrubbed. Two of them are the shapes a
 * gate fails at rather than a pipeline: a value built from a CDK token, which
 * synthesises as `Fn::Join` and which the first draft of this tool skipped, and
 * a destination whose processor is present but disabled.
 */

type Json = Record<string, any>;

const DELIVERY_PREFIX = 'scrubbed/dt=!{timestamp:yyyy-MM-dd}/';
const ERROR_PREFIX = 'quarantine/!{firehose:error-output-type}/';

const processor = (parameters: Json = {}): Json => ({
  Type: 'Lambda',
  Parameters: [
    { ParameterName: 'LambdaArn', ParameterValue: { 'Fn::GetAtt': ['Scrubber', 'Arn'] } },
    { ParameterName: 'BufferSizeInMBs', ParameterValue: '0.2' },
    { ParameterName: 'NumberOfRetries', ParameterValue: '3' },
    ...Object.entries(parameters).map(([ParameterName, ParameterValue]) => ({
      ParameterName,
      ParameterValue,
    })),
  ].filter((entry) => entry.ParameterValue !== null),
});

const template = (resources: Json, path = 'Test.template.json'): TemplateFile => ({
  path,
  document: { Resources: resources },
});

/** A pipeline with nothing wrong with it. Every case below is a mutation of it. */
const healthy = (overrides: { stream?: Json; bucket?: Json; extra?: Json } = {}): TemplateFile =>
  template({
    Stream: {
      Type: 'AWS::KinesisFirehose::DeliveryStream',
      Properties: {
        DeliveryStreamEncryptionConfigurationInput: { KeyType: 'CUSTOMER_MANAGED_CMK' },
        ExtendedS3DestinationConfiguration: {
          BucketARN: { 'Fn::GetAtt': ['Archive', 'Arn'] },
          Prefix: DELIVERY_PREFIX,
          ErrorOutputPrefix: ERROR_PREFIX,
          EncryptionConfiguration: { KMSEncryptionConfig: { AWSKMSKeyARN: 'key' } },
          ProcessingConfiguration: { Enabled: true, Processors: [processor()] },
          ...(overrides.stream ?? {}),
        },
      },
    },
    Archive: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        LifecycleConfiguration: {
          Rules: [
            { Id: 'expire-quarantine', Status: 'Enabled', Prefix: 'quarantine/', ExpirationInDays: 7 },
          ],
        },
        ...(overrides.bucket ?? {}),
      },
    },
    Scrubber: {
      Type: 'AWS::Lambda::Function',
      Properties: { FunctionName: 'staging-log-scrubber' },
    },
    ScrubberLogGroup: {
      Type: 'AWS::Logs::LogGroup',
      Properties: { LogGroupName: '/aws/lambda/staging-log-scrubber', RetentionInDays: 30 },
    },
    Subscription: {
      Type: 'AWS::Logs::SubscriptionFilter',
      Properties: { LogGroupName: '/ecs/staging/api', DestinationArn: { 'Fn::GetAtt': ['Stream', 'Arn'] } },
    },
    ...(overrides.extra ?? {}),
  });

const audit = (...templates: TemplateFile[]): AuditInput => ({ templates });
const rules = (input: AuditInput): string[] =>
  auditLogScrubbing(input).violations.map((violation) => violation.rule);

describe('a pipeline that is wired correctly', () => {
  it('reports nothing', () => {
    expect(auditLogScrubbing(audit(healthy())).violations).toEqual([]);
  });

  it('counts what it read, so a gate that read nothing is distinguishable', () => {
    const result = auditLogScrubbing(audit(healthy()));
    expect(result.streamsRead).toBe(1);
    expect(result.subscriptionsRead).toBe(1);
  });

  it('reports nothing for a template with no pipeline in it at all', () => {
    expect(auditLogScrubbing(audit(template({ Bucket: { Type: 'AWS::S3::Bucket' } }))).violations).toEqual([]);
  });
});

describe('delivery without a transform', () => {
  it('is reported when there is no processing configuration', () => {
    const broken = healthy();
    delete (broken.document as Json).Resources.Stream.Properties
      .ExtendedS3DestinationConfiguration.ProcessingConfiguration;
    expect(rules(audit(broken))).toContain('delivery-without-transform');
  });

  it('is reported when the processor is present but switched off', () => {
    expect(
      rules(audit(healthy({ stream: { ProcessingConfiguration: { Enabled: false, Processors: [processor()] } } }))),
    ).toContain('delivery-without-transform');
  });

  it('is reported for a plain S3DestinationConfiguration, which cannot transform at all', () => {
    const broken = template({
      Stream: {
        Type: 'AWS::KinesisFirehose::DeliveryStream',
        Properties: {
          DeliveryStreamEncryptionConfigurationInput: { KeyType: 'CUSTOMER_MANAGED_CMK' },
          S3DestinationConfiguration: {
            BucketARN: { 'Fn::GetAtt': ['Archive', 'Arn'] },
            Prefix: DELIVERY_PREFIX,
            ErrorOutputPrefix: ERROR_PREFIX,
          },
        },
      },
    });
    expect(rules(audit(broken))).toContain('delivery-without-transform');
  });

  it('is reported when the only processor is a decompressor', () => {
    const decompressOnly = {
      ProcessingConfiguration: { Enabled: true, Processors: [{ Type: 'Decompression', Parameters: [] }] },
    };
    expect(rules(audit(healthy({ stream: decompressOnly })))).toContain('delivery-without-transform');
  });
});

describe('the settings that quietly deliver raw records', () => {
  it('reports source record backup, which archives the untransformed copy', () => {
    expect(rules(audit(healthy({ stream: { S3BackupMode: 'Enabled' } })))).toContain(
      'source-record-backup-enabled',
    );
  });

  it('reports a backup configuration even without the enum', () => {
    expect(
      rules(audit(healthy({ stream: { S3BackupConfiguration: { BucketARN: 'other' } } }))),
    ).toContain('source-record-backup-enabled');
  });

  it('reports a processor with no buffer size, which takes the 1 MB default', () => {
    const noBuffer = {
      ProcessingConfiguration: {
        Enabled: true,
        Processors: [
          {
            Type: 'Lambda',
            Parameters: [{ ParameterName: 'LambdaArn', ParameterValue: { 'Fn::GetAtt': ['Scrubber', 'Arn'] } }],
          },
        ],
      },
    };
    expect(rules(audit(healthy({ stream: noBuffer })))).toContain('processor-buffer-unset');
  });

  it('reports zero retries', () => {
    const zeroRetries = {
      ProcessingConfiguration: { Enabled: true, Processors: [processor({ NumberOfRetries: '0' })] },
    };
    expect(rules(audit(healthy({ stream: zeroRetries })))).toContain('processor-retries-zero');
  });

  it('reports an unencrypted delivery stream', () => {
    const broken = healthy();
    delete (broken.document as Json).Resources.Stream.Properties
      .DeliveryStreamEncryptionConfigurationInput;
    expect(rules(audit(broken))).toContain('stream-not-encrypted');
  });
});

describe('the quarantine prefix', () => {
  it('is reported when it is missing entirely', () => {
    const broken = healthy();
    delete (broken.document as Json).Resources.Stream.Properties
      .ExtendedS3DestinationConfiguration.ErrorOutputPrefix;
    expect(rules(audit(broken))).toContain('quarantine-under-archive');
  });

  it('is reported when it shares a top level with the archive prefix', () => {
    expect(
      rules(audit(healthy({ stream: { ErrorOutputPrefix: 'scrubbed/errors/' } }))),
    ).toContain('quarantine-under-archive');
  });

  it('is reported when nothing expires it', () => {
    expect(rules(audit(healthy({ bucket: { LifecycleConfiguration: { Rules: [] } } })))).toContain(
      'quarantine-never-expires',
    );
  });

  it('is reported when the lifecycle rule exists but is disabled', () => {
    const disabled = {
      LifecycleConfiguration: {
        Rules: [{ Status: 'Disabled', Prefix: 'quarantine/', ExpirationInDays: 7 }],
      },
    };
    expect(rules(audit(healthy({ bucket: disabled })))).toContain('quarantine-never-expires');
  });

  it('is reported when the rule expires versions but never the objects', () => {
    const versionsOnly = {
      LifecycleConfiguration: {
        Rules: [{ Status: 'Enabled', Prefix: 'quarantine/', NoncurrentVersionExpirationInDays: 1 }],
      },
    };
    expect(rules(audit(healthy({ bucket: versionsOnly })))).toContain('quarantine-never-expires');
  });

  it('is accepted when the rule covers the prefix and expires objects', () => {
    expect(rules(audit(healthy()))).not.toContain('quarantine-never-expires');
  });
});

describe('logs leaving by another path', () => {
  it('reports a subscription to something this template cannot show scrubs', () => {
    const vendor = healthy();
    (vendor.document as Json).Resources.Subscription.Properties.DestinationArn = {
      'Fn::GetAtt': ['VendorFunction', 'Arn'],
    };
    expect(rules(audit(vendor))).toContain('subscription-off-pipeline');
  });

  it('reports a cross-stack import, because nothing here can resolve it', () => {
    const imported = healthy();
    (imported.document as Json).Resources.Subscription.Properties.DestinationArn = {
      'Fn::ImportValue': 'other-stack-stream',
    };
    expect(rules(audit(imported))).toContain('subscription-off-pipeline');
  });

  it('accepts a subscription to a delivery stream declared beside it', () => {
    expect(rules(audit(healthy()))).not.toContain('subscription-off-pipeline');
  });
});

describe("the transform's own log group", () => {
  it('is reported when nothing declares it', () => {
    const broken = healthy();
    delete (broken.document as Json).Resources.ScrubberLogGroup;
    expect(rules(audit(broken))).toContain('transform-log-group-unmanaged');
  });

  it('is reported when the declared group is for a different function', () => {
    const broken = healthy();
    (broken.document as Json).Resources.ScrubberLogGroup.Properties.LogGroupName =
      '/aws/lambda/some-other-function';
    expect(rules(audit(broken))).toContain('transform-log-group-unmanaged');
  });
});

describe('the account data protection policy', () => {
  const policy = (document: Json, selectionCriteria?: string): Json => ({
    DataProtection: {
      Type: 'AWS::Logs::AccountPolicy',
      Properties: {
        PolicyType: 'DATA_PROTECTION_POLICY',
        PolicyName: 'staging-log-data-protection',
        PolicyDocument: JSON.stringify(document),
        ...(selectionCriteria === undefined ? {} : { SelectionCriteria: selectionCriteria }),
      },
    },
  });

  const auditStatement = (group: string): Json => ({
    Sid: 'audit-findings',
    Operation: { Audit: { FindingsDestination: { CloudWatchLogs: { LogGroup: group } } } },
  });
  const maskStatement: Json = { Sid: 'mask', Operation: { Deidentify: { MaskConfig: {} } } };

  it('accepts one that audits, masks, and excludes its own destination', () => {
    const extra = policy(
      { Statement: [auditStatement('/aws/logs/audit'), maskStatement] },
      'LogGroupNamePrefix NOT IN ["/aws/logs/audit"]',
    );
    expect(rules(audit(healthy({ extra })))).toEqual([]);
  });

  it('reports one that audits without masking', () => {
    const extra = policy(
      { Statement: [auditStatement('/aws/logs/audit')] },
      'LogGroupNamePrefix NOT IN ["/aws/logs/audit"]',
    );
    expect(rules(audit(healthy({ extra })))).toContain('data-protection-audit-only');
  });

  it('reports findings written into a group the policy itself scans', () => {
    const extra = policy({ Statement: [auditStatement('/aws/logs/audit'), maskStatement] });
    expect(rules(audit(healthy({ extra })))).toContain('data-protection-audit-recursion');
  });

  it('reports two account-scoped policies, which both apply', () => {
    const first = healthy({
      extra: policy(
        { Statement: [auditStatement('/aws/logs/audit'), maskStatement] },
        'LogGroupNamePrefix NOT IN ["/aws/logs/audit"]',
      ),
    });
    const second = template(
      policy(
        { Statement: [auditStatement('/aws/logs/audit-2'), maskStatement] },
        'LogGroupNamePrefix NOT IN ["/aws/logs/audit-2"]',
      ),
      'Second.template.json',
    );
    expect(rules(audit(first, second))).toContain('data-protection-policy-conflict');
  });

  it('reads a document built from a CDK token, which synthesises as Fn::Join', () => {
    // The shape that made the first draft of this gate skip its own policy and
    // report success.
    const joined: Json = {
      DataProtection: {
        Type: 'AWS::Logs::AccountPolicy',
        Properties: {
          PolicyType: 'DATA_PROTECTION_POLICY',
          PolicyDocument: {
            'Fn::Join': [
              '',
              [
                '{"Statement":[{"Sid":"audit","Operation":{"Audit":{"FindingsDestination":{"CloudWatchLogs":{"LogGroup":"/aws/logs/audit"}}}},"DataIdentifier":["arn:',
                { Ref: 'AWS::Partition' },
                ':dataprotection::aws:data-identifier/EmailAddress"]}]}',
              ],
            ],
          },
        },
      },
    };
    expect(rules(audit(healthy({ extra: joined })))).toContain('data-protection-audit-only');
  });

  it('ignores account policies of other types', () => {
    const subscriptionPolicy: Json = {
      OtherPolicy: {
        Type: 'AWS::Logs::AccountPolicy',
        Properties: { PolicyType: 'SUBSCRIPTION_FILTER_POLICY', PolicyDocument: '{}' },
      },
    };
    expect(rules(audit(healthy({ extra: subscriptionPolicy })))).toEqual([]);
  });
});

describe('helpers', () => {
  it('flattens a join and marks the parts it cannot resolve', () => {
    expect(readText({ 'Fn::Join': ['-', ['a', { Ref: 'AWS::Partition' }, 'b']] })).toBe(
      'a-<intrinsic>-b',
    );
  });

  it('returns undefined for a bare reference', () => {
    expect(readText({ Ref: 'Bucket' })).toBeUndefined();
  });

  it('takes the first path segment of a prefix', () => {
    expect(topSegment('quarantine/!{firehose:error-output-type}/')).toBe('quarantine');
  });

  it('formats a violation with its rule, location and reason', () => {
    const broken = healthy({ stream: { S3BackupMode: 'Enabled' } });
    const text = formatViolations(auditLogScrubbing(audit(broken)).violations);
    expect(text).toContain('[source-record-backup-enabled]');
    expect(text).toContain('Test.template.json');
  });
});
