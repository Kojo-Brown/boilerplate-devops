import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  LOG_PIPELINE_METRICS,
  LOG_PIPELINE_METRIC_NAMESPACE,
  LogPipelineStack,
  LogPipelineStackProps,
} from '../lib/log-pipeline-stack';
import {
  DEFAULT_SCRUBBING_RULESET,
  IPV4_RULE,
  RedactionRule,
  extendRuleset,
} from '../lib/log-scrubbing';
import { flattenIntrinsic, resourceProps } from './support/cfn';

const ENV = { account: '123456789012', region: 'eu-west-1' };

const makeStack = (
  overrides: Partial<LogPipelineStackProps> = {},
  id = 'TestLogPipelineStack',
): { template: Template; stack: LogPipelineStack } => {
  const app = new cdk.App();
  const stack = new LogPipelineStack(app, id, {
    envName: 'staging',
    sourceLogGroupNames: ['/ecs/staging/api'],
    env: ENV,
    ...overrides,
  });
  return { template: Template.fromStack(stack), stack };
};

/** The one Firehose destination configuration in the stack. */
const destination = (template: Template): Record<string, any> =>
  resourceProps(template, 'AWS::KinesisFirehose::DeliveryStream')[0]
    .ExtendedS3DestinationConfiguration as Record<string, any>;

const processorParameters = (template: Template): Record<string, unknown> => {
  const processors = destination(template).ProcessingConfiguration.Processors as any[];
  const lambda = processors.find((processor) => processor.Type === 'Lambda');
  return Object.fromEntries(
    (lambda.Parameters as any[]).map((parameter) => [parameter.ParameterName, parameter.ParameterValue]),
  );
};

describe('the transform is in the delivery path', () => {
  it('writes to S3 only through an enabled Lambda processor', () => {
    const { template } = makeStack();
    const config = destination(template);
    expect(config.ProcessingConfiguration.Enabled).toBe(true);
    expect(processorParameters(template).LambdaArn).toBeDefined();
  });

  it('buffers 0.2 MB of compressed input per invocation, not Firehose\'s 1 MB default', () => {
    // The transform's response limit is 6 MB of expanded output. Structured
    // logs gzip well past 6:1, so the default buffer is how a correct transform
    // starts dropping records it cannot fit.
    expect(processorParameters(makeStack().template).BufferSizeInMBs).toBe('0.2');
  });

  it('retries a failed invocation before Firehose gives up and writes raw', () => {
    expect(processorParameters(makeStack().template).NumberOfRetries).toBe('3');
  });

  it('never configures source record backup, which archives the untransformed records', () => {
    const config = destination(makeStack().template);
    expect(config.S3BackupMode).toBeUndefined();
    expect(config.S3BackupConfiguration).toBeUndefined();
  });

  it('encrypts the stream with the pipeline key — records in its buffer are unscrubbed', () => {
    const stream = resourceProps(makeStack().template, 'AWS::KinesisFirehose::DeliveryStream')[0];
    expect((stream.DeliveryStreamEncryptionConfigurationInput as any).KeyType).toBe(
      'CUSTOMER_MANAGED_CMK',
    );
  });

  it('subscribes every source log group it was given', () => {
    const { template } = makeStack({
      sourceLogGroupNames: ['/ecs/staging/api', '/ecs/staging/worker'],
    });
    template.resourceCountIs('AWS::Logs::SubscriptionFilter', 2);
    expect(
      resourceProps(template, 'AWS::Logs::SubscriptionFilter').map((props) => props.LogGroupName),
    ).toEqual(['/ecs/staging/api', '/ecs/staging/worker']);
  });

  it('forwards every event rather than filtering, so nothing is dropped undocumented', () => {
    const filters = resourceProps(makeStack().template, 'AWS::Logs::SubscriptionFilter');
    expect(filters[0].FilterPattern).toBe('');
  });
});

describe('the quarantine prefix', () => {
  it('is a separate top level from the archive, not a folder inside it', () => {
    const config = destination(makeStack().template);
    expect(String(config.Prefix)).toMatch(/^scrubbed\//);
    expect(String(config.ErrorOutputPrefix)).toMatch(/^quarantine\//);
  });

  it('partitions the archive by date so an Athena table can prune', () => {
    expect(String(destination(makeStack().template).Prefix)).toContain('!{timestamp:yyyy-MM-dd}');
  });

  it('expires in a week, because it holds records nothing scrubbed', () => {
    const bucket = resourceProps(makeStack().template, 'AWS::S3::Bucket').find(
      (props) => (props.LifecycleConfiguration as any)?.Rules?.some((rule: any) => rule.Prefix === 'quarantine/'),
    );
    const rule = (bucket?.LifecycleConfiguration as any).Rules.find(
      (entry: any) => entry.Prefix === 'quarantine/',
    );
    expect(rule.ExpirationInDays).toBe(7);
  });

  it('is unreadable by default — a Deny with nobody excepted', () => {
    const { template } = makeStack();
    const policies = resourceProps(template, 'AWS::S3::BucketPolicy');
    const statements = policies.flatMap(
      (props) => ((props.PolicyDocument as any).Statement as any[]) ?? [],
    );
    const deny = statements.find((statement) => statement.Sid === 'RestrictQuarantineReads');
    expect(deny.Effect).toBe('Deny');
    expect(deny.Action).toEqual(['s3:GetObject', 's3:GetObjectVersion']);
    expect(flattenIntrinsic(deny.Resource)).toContain('quarantine/*');
    expect(deny.Condition).toBeUndefined();
  });

  it('excepts only the incident roles it is given', () => {
    const { template } = makeStack({
      quarantineReaderRoleArns: ['arn:aws:iam::123456789012:role/incident-response'],
    });
    const statements = resourceProps(template, 'AWS::S3::BucketPolicy').flatMap(
      (props) => ((props.PolicyDocument as any).Statement as any[]) ?? [],
    );
    const deny = statements.find((statement) => statement.Sid === 'RestrictQuarantineReads');
    expect(deny.Condition.StringNotLike['aws:PrincipalArn']).toEqual([
      'arn:aws:iam::123456789012:role/incident-response',
    ]);
  });
});

describe('the archive', () => {
  it('is encrypted with the pipeline key and refuses plaintext transport', () => {
    const { template, stack } = makeStack();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
          }),
        ],
      },
    });
    expect(stack.archiveBucket.encryptionKey).toBeDefined();
  });

  it('records who reads it, into a bucket that is the end of the chain', () => {
    const { template } = makeStack();
    const buckets = resourceProps(template, 'AWS::S3::Bucket');
    const archive = buckets.find((props) => props.LoggingConfiguration !== undefined);
    expect((archive?.LoggingConfiguration as any).LogFilePrefix).toBe('archive-access/');
    template.resourceCountIs('AWS::S3::Bucket', 2);
  });

  it('tiers and then expires, rather than keeping every object at standard price forever', () => {
    const rules = (
      resourceProps(makeStack().template, 'AWS::S3::Bucket').find(
        (props) => props.LoggingConfiguration !== undefined,
      )?.LifecycleConfiguration as any
    ).Rules;
    const archiveRule = rules.find((rule: any) => rule.Prefix === 'scrubbed/');
    expect(archiveRule.ExpirationInDays).toBe(400);
    expect(archiveRule.Transitions.map((transition: any) => transition.StorageClass)).toEqual([
      'STANDARD_IA',
      'GLACIER_IR',
    ]);
  });

  it('is retained in production and disposable everywhere else', () => {
    const production = makeStack({ envName: 'production' }).template;
    const staging = makeStack().template;
    expect(
      Object.values(production.findResources('AWS::S3::Bucket')).map((r: any) => r.DeletionPolicy),
    ).toEqual(['Retain', 'Retain']);
    expect(
      Object.values(staging.findResources('AWS::S3::Bucket')).map((r: any) => r.DeletionPolicy),
    ).toEqual(['Delete', 'Delete']);
  });
});

describe('the transform function', () => {
  it('carries the serialised ruleset, not a copy of the engine', () => {
    const { template } = makeStack();
    const fn = resourceProps(template, 'AWS::Lambda::Function')
      .find((props) => props.FunctionName === 'staging-log-scrubber');
    const ruleset = JSON.parse((fn?.Environment as any).Variables.SCRUBBING_RULESET);
    expect(ruleset.rules.map((rule: any) => rule.id)).toEqual(
      DEFAULT_SCRUBBING_RULESET.rules.map((rule) => rule.id),
    );
    expect(ruleset.rules[0].why).toBeUndefined();
  });

  it('declares its own log group, with retention and the pipeline key', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/lambda/staging-log-scrubber',
      RetentionInDays: 30,
      KmsKeyId: Match.anyValue(),
    });
  });

  it('bounds its concurrency and encrypts its environment', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'staging-log-scrubber',
      ReservedConcurrentExecutions: 20,
      KmsKeyArn: Match.anyValue(),
      Runtime: 'nodejs22.x',
      Timeout: 60,
    });
  });

  it('reads one secret and decrypts with one key', () => {
    const { template } = makeStack();
    const policies = resourceProps(template, 'AWS::IAM::Policy');
    const statements = policies.flatMap(
      (props) => ((props.PolicyDocument as any).Statement as any[]) ?? [],
    );
    const read = statements.find((statement) => statement.Sid === 'ReadTokenizationKey');
    expect(read.Action).toBe('secretsmanager:GetSecretValue');
    expect(flattenIntrinsic(read.Resource)).not.toBe('*');
    const decrypt = statements.filter((statement) =>
      JSON.stringify(statement.Action).includes('kms:Decrypt'),
    );
    for (const statement of decrypt) expect(flattenIntrinsic(statement.Resource)).not.toBe('*');
  });

  it('generates the tokenisation key rather than taking one from anywhere', () => {
    const { template } = makeStack();
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'staging/log-pipeline/tokenization-key',
      GenerateSecretString: Match.objectLike({ GenerateStringKey: 'key', PasswordLength: 64 }),
    });
  });
});

describe('the encryption key', () => {
  it('lets CloudWatch Logs use it, scoped to this account\'s log groups', () => {
    const { template } = makeStack();
    const key = resourceProps(template, 'AWS::KMS::Key')[0];
    const statement = ((key.KeyPolicy as any).Statement as any[]).find(
      (entry) => entry.Sid === 'AllowCloudWatchLogs',
    );
    expect(flattenIntrinsic(statement.Principal.Service)).toContain('logs.');
    // Without this the log group fails to create at deploy time; without the
    // condition the grant is the service, account-wide.
    expect(statement.Condition.ArnLike['kms:EncryptionContext:aws:logs:arn']).toBeDefined();
  });

  it('rotates', () => {
    makeStack().template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });
});

describe('masking at ingest', () => {
  it('is off unless a stack is told to own it', () => {
    makeStack().template.resourceCountIs('AWS::Logs::AccountPolicy', 0);
  });

  it('audits and deidentifies, because audit alone masks nothing', () => {
    const { template } = makeStack({ manageAccountDataProtectionPolicy: true });
    const policy = resourceProps(template, 'AWS::Logs::AccountPolicy')[0];
    // The document is built from `stack.partition`, so it synthesises as an
    // Fn::Join rather than a string — which is also why `audit:logs` flattens
    // before it parses.
    const document = JSON.parse(flattenIntrinsic(policy.PolicyDocument));
    const operations = document.Statement.map((statement: any) => Object.keys(statement.Operation)[0]);
    expect(operations).toEqual(['Audit', 'Deidentify']);
  });

  it('excludes its own findings destination, or every finding produces a finding', () => {
    const { template } = makeStack({ manageAccountDataProtectionPolicy: true });
    const policy = resourceProps(template, 'AWS::Logs::AccountPolicy')[0];
    const document = JSON.parse(flattenIntrinsic(policy.PolicyDocument));
    const destinationGroup =
      document.Statement[0].Operation.Audit.FindingsDestination.CloudWatchLogs.LogGroup;
    expect(policy.SelectionCriteria).toContain(destinationGroup);
    expect(policy.SelectionCriteria).toContain('/aws/lambda/staging-log-scrubber');
  });

  it('creates the findings destination it names', () => {
    const { template } = makeStack({ manageAccountDataProtectionPolicy: true });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/logs/staging-data-protection-audit',
    });
  });
});

describe('alarms', () => {
  it('treats silence as the failure it is', () => {
    const { template } = makeStack();
    const alarms = resourceProps(template, 'AWS::CloudWatch::Alarm');
    const silent = alarms.find((props) => String(props.AlarmName).endsWith('-silent'));
    expect(silent?.TreatMissingData).toBe('breaching');
    expect(silent?.MetricName).toBe(LOG_PIPELINE_METRICS.recordsProcessed);
    expect(silent?.Namespace).toBe(LOG_PIPELINE_METRIC_NAMESPACE);
    expect(silent?.ComparisonOperator).toBe('LessThanThreshold');
  });

  it('alarms on the paths that put unscrubbed records in S3', () => {
    const names = resourceProps(makeStack().template, 'AWS::CloudWatch::Alarm').map(
      (props) => props.AlarmName,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'staging-log-scrubber-failing',
        'staging-log-pipeline-processing-failures',
      ]),
    );
  });

  it('alarms on tokenisation degrading to masking, which nothing else reports', () => {
    const alarms = resourceProps(makeStack().template, 'AWS::CloudWatch::Alarm');
    const alarm = alarms.find((props) => String(props.AlarmName).endsWith('-tokenization-unavailable'));
    expect(alarm?.MetricName).toBe(LOG_PIPELINE_METRICS.tokenizationUnavailable);
  });

  it('routes every alarm to the topic, in both directions', () => {
    const { template, stack } = makeStack({ alarmEmails: ['sre@example.com'] });
    for (const props of resourceProps(template, 'AWS::CloudWatch::Alarm')) {
      expect(props.AlarmActions).toBeDefined();
      expect(props.OKActions).toBeDefined();
    }
    expect(stack.alarms.length).toBeGreaterThanOrEqual(7);
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'sre@example.com',
    });
  });
});

describe('what synth refuses', () => {
  it('a pipeline with nothing subscribed to it', () => {
    expect(() => makeStack({ sourceLogGroupNames: [] })).toThrow(/nothing subscribed/);
  });

  it.each([[10], [600]])('a transform timeout of %p seconds', (transformTimeoutSeconds) => {
    expect(() => makeStack({ transformTimeoutSeconds })).toThrow(/300 seconds|still had work/);
  });

  it('a processor buffer Firehose would reject', () => {
    expect(() => makeStack({ processorBufferSizeMb: 8 })).toThrow(/0.2 to 3/);
  });

  it('a ruleset whose pattern would throw at cold start', () => {
    const broken: RedactionRule = {
      id: 'broken',
      pattern: '([a-z',
      replacement: '[REDACTED:BROKEN]',
      why: 'fixture',
    };
    expect(() =>
      makeStack({ ruleset: extendRuleset(DEFAULT_SCRUBBING_RULESET, { rules: [broken] }) }),
    ).toThrow(/Invalid log-scrubbing ruleset/);
  });

  it('a ruleset that no longer fits the function environment', () => {
    const bulky = Array.from({ length: 40 }, (_unused, index) => ({
      id: `bulk-${index}`,
      pattern: `bulk-value-${'x'.repeat(100)}-${index}`,
      replacement: '[REDACTED:BULK]',
      why: 'fixture',
    }));
    expect(() =>
      makeStack({ ruleset: extendRuleset(DEFAULT_SCRUBBING_RULESET, { rules: bulky }) }),
    ).toThrow(/Lambda environment/);
  });

  it('but accepts the documented opt-in rule', () => {
    expect(() =>
      makeStack({ ruleset: extendRuleset(DEFAULT_SCRUBBING_RULESET, { rules: [IPV4_RULE] }) }),
    ).not.toThrow();
  });
});

describe('tags and outputs', () => {
  it('tags everything the policy pack governs', () => {
    const { template } = makeStack();
    for (const props of resourceProps(template, 'AWS::S3::Bucket')) {
      const tags = ((props.Tags as any[]) ?? []).map((tag) => tag.Key);
      expect(tags).toEqual(expect.arrayContaining(['ManagedBy', 'Stack', 'Environment']));
    }
  });

  it('exports the prefixes, including the one nobody should read', () => {
    const exports = Object.values(makeStack().template.findOutputs('*')).map((output: any) =>
      output.Export?.Name,
    );
    expect(exports).toEqual(
      expect.arrayContaining([
        'staging-log-archive-bucket',
        'staging-log-archive-prefix',
        'staging-log-quarantine-prefix',
        'staging-log-pipeline-stream',
      ]),
    );
  });
});
