import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CANARY_FLEET_TAG,
  CANARY_METRIC_NAMESPACE,
  CANARY_QUORUM_TAG,
  PROBE_FAILURE_METRIC,
  REQUIRED_PROBE_ENV_VARS,
  SyntheticCanaryFleet,
} from '../lib/synthetic-canary-probes';
import {
  CANARY_RUNTIME,
  SyntheticCanaryQuorumStack,
  SyntheticCanaryStack,
} from '../lib/synthetic-canary-stack';
import { TOKEN, flattenIntrinsic, resourceProps } from './support/cfn';

/**
 * Tests for the two halves of the fleet.
 *
 * The load-bearing ones are about absence rather than presence: the canary that
 * is not in a VPC, the alarm that treats no data as a breach, the `FILL()` that
 * stops one silent region blinding the quorum. Each of those is a template that
 * deploys either way, and the wrong one is a fleet that reports health it did
 * not observe.
 */

const REGIONS = ['us-east-1', 'eu-west-1', 'ap-southeast-1'];

const fleet: SyntheticCanaryFleet = {
  envName: 'production',
  regions: REGIONS,
  aggregationRegion: 'eu-west-1',
  quorum: 2,
  probes: [
    {
      name: 'health',
      url: 'https://www.example.com/healthz',
      bodyMarker: '"status":"ok"',
      latencyBudgetMs: 2_000,
    },
  ],
};

const probeStack = (region = 'us-east-1', spec: SyntheticCanaryFleet = fleet): Template =>
  Template.fromStack(
    new SyntheticCanaryStack(new cdk.App(), `Probe-${region}`, {
      fleet: spec,
      env: { account: '123456789012', region },
    }),
  );

const quorumStack = (spec: SyntheticCanaryFleet = fleet): Template =>
  Template.fromStack(
    new SyntheticCanaryQuorumStack(new cdk.App(), 'Quorum', {
      fleet: spec,
      env: { account: '123456789012', region: spec.aggregationRegion },
    }),
  );

describe('the canaries', () => {
  const template = probeStack();

  it('creates one canary per probe, on the pinned runtime', () => {
    template.resourceCountIs('AWS::Synthetics::Canary', 1);
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      Name: 'production-health',
      RuntimeVersion: CANARY_RUNTIME.name,
      Schedule: { Expression: 'rate(5 minutes)' },
    });
  });

  // The whole point of a synthetic probe is the vantage point. Inside the VPC
  // it reaches the load balancer over the network the application already
  // trusts, and stops being able to see the DNS record, the certificate or the
  // WAF — which is most of what it is for.
  it('probes from outside any VPC', () => {
    const canaries = resourceProps(template, 'AWS::Synthetics::Canary');
    expect(canaries).toHaveLength(1);
    expect(canaries[0].VPCConfig).toBeUndefined();
  });

  it('carries every assertion as a deployed value rather than a default', () => {
    const [canary] = resourceProps(template, 'AWS::Synthetics::Canary');
    const environment = (canary.RunConfig as { EnvironmentVariables: Record<string, string> })
      .EnvironmentVariables;
    for (const name of REQUIRED_PROBE_ENV_VARS) {
      expect(environment[name]).toBeTruthy();
    }
    expect(environment.PROBE_BODY_MARKER).toBe('"status":"ok"');
    expect(environment.PROBE_REGION).toBe('us-east-1');
    expect(environment.PROBE_AGGREGATION_REGION).toBe('eu-west-1');
  });

  // CDK's generated role conditions PutMetricData on the CloudWatchSynthetics
  // namespace, which is exactly the call the handler makes into ours. Without
  // this statement every run is denied at the republish.
  it('grants the canary role PutMetricData in the fleet namespace', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Condition: { StringEquals: { 'cloudwatch:namespace': CANARY_METRIC_NAMESPACE } },
          }),
        ]),
      },
    });
  });

  // CDK's generated role scopes s3:PutObject to `<prefix>/*` by appending, so a
  // prefix with a trailing slash grants `health//*` while the artifacts land
  // under `health/`. The canary deploys, runs, and is denied on every artifact.
  it('grants the artifact prefix the canary actually writes to', () => {
    const [canary] = resourceProps(template, 'AWS::Synthetics::Canary');
    expect(flattenIntrinsic(canary.ArtifactS3Location)).toBe(`s3://${TOKEN}/health`);
    template.hasResourceProperties('AWS::IAM::Role', {
      Policies: Match.arrayWith([
        Match.objectLike({
          PolicyDocument: Match.objectLike({
            Statement: Match.arrayWith([
              Match.objectLike({
                Action: 's3:PutObject',
                Resource: { 'Fn::Join': ['', [Match.anyValue(), '/health/*']] },
              }),
            ]),
          }),
        }),
      ]),
    });
  });

  // activeTracing is a property on the canary and a permission on its role,
  // and CDK sets only the first. Without the grant the segments are dropped
  // silently: the canary still runs, still reports, and the trace that would
  // attribute a slow run is never there.
  it('grants the X-Ray writes active tracing needs', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      RunConfig: Match.objectLike({ ActiveTracing: true }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
            Resource: '*',
          }),
        ]),
      },
    });
  });

  it('encrypts the artifacts with a rotating key it owns', () => {
    template.hasResourceProperties('AWS::Synthetics::Canary', {
      ArtifactConfig: { S3Encryption: { EncryptionMode: 'SSE_KMS' } },
    });
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('tags the canary so the audit gate can find it', () => {
    const [canary] = resourceProps(template, 'AWS::Synthetics::Canary');
    const tags = canary.Tags as { Key: string; Value: string }[];
    expect(tags).toEqual(
      expect.arrayContaining([
        { Key: CANARY_FLEET_TAG, Value: 'production' },
        { Key: CANARY_QUORUM_TAG, Value: '2' },
      ]),
    );
  });

  // The one signal that survives the republish path, the aggregation region and
  // the metric math all being broken at once.
  it('keeps a local alarm on this region\'s own Synthetics metrics', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'production-health-us-east-1-failed',
      Namespace: 'CloudWatchSynthetics',
      MetricName: 'SuccessPercent',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 100,
      TreatMissingData: 'breaching',
    });
  });
});

describe('a probe stack that would publish into nothing', () => {
  it('refuses a region the fleet does not list', () => {
    expect(() => probeStack('sa-east-1')).toThrow(/not one of the fleet's probe regions/);
  });

  // An environment-agnostic stack resolves the region to a Ref, so the Region
  // dimension is unknown at synth time and the quorum alarm cannot name the
  // series it has to add up.
  it('refuses to synthesise without a concrete region', () => {
    expect(() =>
      Template.fromStack(
        new SyntheticCanaryStack(new cdk.App(), 'Agnostic', { fleet }),
      ),
    ).toThrow(/concrete env.region/);
  });
});

describe('the quorum', () => {
  const template = quorumStack();

  it('creates no canaries — it only compares them', () => {
    template.resourceCountIs('AWS::Synthetics::Canary', 0);
  });

  it('sums one FILL()ed term per probe region against the quorum', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'production-canary-health-quorum',
      Threshold: 2,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'breaching',
      Metrics: Match.arrayWith([
        Match.objectLike({ Expression: 'FILL(m0, 0) + FILL(m1, 0) + FILL(m2, 0)' }),
      ]),
    });
  });

  // Without FILL, metric math produces no data point wherever any input is
  // missing, so one region whose canary has stopped reporting takes the quorum
  // alarm out for every other region at the same time.
  it('names every probe region in the expression', () => {
    const [alarm] = resourceProps(template, 'AWS::CloudWatch::Alarm').filter(
      (props) => props.AlarmName === 'production-canary-health-quorum',
    );
    const members = alarm.Metrics as Record<string, unknown>[];
    const regions = members
      .filter((member) => member.MetricStat !== undefined)
      .map((member) => member.Label);
    expect(regions).toEqual(REGIONS);
  });

  it('tickets a single failing region rather than paging on it', () => {
    for (const region of REGIONS) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `production-canary-health-${region}`,
        TreatMissingData: 'notBreaching',
        AlarmActions: [{ Ref: Match.stringLikeRegexp('CanaryTicketTopic') }],
      });
    }
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'production-canary-health-quorum',
      AlarmActions: [{ Ref: Match.stringLikeRegexp('CanaryPageTopic') }],
    });
  });

  // A canary that stopped running publishes nothing at all, and nothing is what
  // a canary that is passing publishes to every threshold above.
  it('alarms on the absence of a verdict, per region', () => {
    for (const region of REGIONS) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `production-canary-health-${region}-silent`,
        ComparisonOperator: 'LessThanThreshold',
        Threshold: 1,
        TreatMissingData: 'breaching',
        Metrics: Match.arrayWith([
          Match.objectLike({
            MetricStat: Match.objectLike({
              Stat: 'SampleCount',
              Metric: Match.objectLike({
                Namespace: CANARY_METRIC_NAMESPACE,
                MetricName: PROBE_FAILURE_METRIC,
              }),
            }),
          }),
        ]),
      });
    }
  });

  it('publishes a dashboard with the quorum drawn on it', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    const [dashboard] = resourceProps(template, 'AWS::CloudWatch::Dashboard');
    expect(dashboard.DashboardName).toBe('production-synthetic-canaries');
  });
});

describe('a quorum stack in the wrong place', () => {
  // CloudWatch alarms are regional. In any other region every alarm here
  // evaluates a series that is never written, and a threshold on failures over
  // an empty series reads as healthy for ever.
  it('refuses to deploy outside the aggregation region', () => {
    expect(() =>
      Template.fromStack(
        new SyntheticCanaryQuorumStack(new cdk.App(), 'Elsewhere', {
          fleet,
          env: { account: '123456789012', region: 'us-east-1' },
        }),
      ),
    ).toThrow(/cannot read a metric from another region/);
  });
});
