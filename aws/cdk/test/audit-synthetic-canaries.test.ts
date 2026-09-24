import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  CANARY_FLEET_TAG as LIBRARY_FLEET_TAG,
  CANARY_METRIC_NAMESPACE as LIBRARY_NAMESPACE,
  ENVIRONMENT_DIMENSION as LIBRARY_ENVIRONMENT_DIMENSION,
  MAX_SCHEDULE_MINUTES as LIBRARY_MAX_SCHEDULE,
  MIN_SCHEDULE_MINUTES as LIBRARY_MIN_SCHEDULE,
  PROBE_DIMENSION as LIBRARY_PROBE_DIMENSION,
  PROBE_FAILURE_METRIC as LIBRARY_FAILURE_METRIC,
  REGION_DIMENSION as LIBRARY_REGION_DIMENSION,
  REQUIRED_PROBE_ENV_VARS as LIBRARY_REQUIRED_ENV_VARS,
  SyntheticCanaryFleet,
} from '../lib/synthetic-canary-probes';
import {
  SyntheticCanaryQuorumStack,
  SyntheticCanaryStack,
} from '../lib/synthetic-canary-stack';
import {
  CANARY_FLEET_TAG,
  CANARY_METRIC_NAMESPACE,
  ENVIRONMENT_DIMENSION,
  MAX_SCHEDULE_MINUTES,
  MIN_SCHEDULE_MINUTES,
  PROBE_DIMENSION,
  PROBE_FAILURE_METRIC,
  REGION_DIMENSION,
  REQUIRED_PROBE_ENV_VARS,
  TemplateFile,
  auditSyntheticCanaries,
  formatViolations,
  scheduleMinutesOf,
} from '../tools/audit-synthetic-canaries';

/**
 * Tests for the synthetic-canary gate.
 *
 * Two halves. The first synthesises the real stacks and hands the gate what
 * `cdk synth` wrote, so the fleet this repository ships is checked against the
 * rules rather than only a fixture being checked. The second mutates that
 * output one property at a time: every mutation is a template CloudFormation
 * accepts and deploys, and every one produces a fleet that reports health it
 * did not observe.
 */

type Json = Record<string, any>;

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

/** The fleet as synth writes it: one template per probe region, plus quorum. */
const synthesiseFleet = (): TemplateFile[] => {
  // An App per stack. `Template.fromStack` synthesises the whole app, and CDK
  // refuses a second synthesis of a tree that grew in between — which is what
  // adding the next region to a shared app would be.
  const templates = REGIONS.map((region) => ({
    path: `SyntheticCanaryStack-${region}.template.json`,
    document: Template.fromStack(
      new SyntheticCanaryStack(new cdk.App(), `Probe-${region}`, {
        fleet,
        env: { account: '123456789012', region },
      }),
    ).toJSON() as unknown,
  }));
  templates.push({
    path: 'SyntheticCanaryQuorumStack.template.json',
    document: Template.fromStack(
      new SyntheticCanaryQuorumStack(new cdk.App(), 'Quorum', {
        fleet,
        env: { account: '123456789012', region: fleet.aggregationRegion },
      }),
    ).toJSON() as unknown,
  });
  return templates;
};

const rulesFor = (templates: readonly TemplateFile[]): string[] =>
  auditSyntheticCanaries({ templates }).violations.map((violation) => violation.rule);

/** Deep clone, so each case mutates its own copy of the synthesised fleet. */
const clone = (templates: readonly TemplateFile[]): TemplateFile[] =>
  templates.map((template) => ({
    path: template.path,
    document: JSON.parse(JSON.stringify(template.document)) as unknown,
  }));

const resourcesOfDocument = (template: TemplateFile): Json =>
  (template.document as Json).Resources as Json;

/** Mutate every resource of a type, across every template. */
const eachResource = (
  templates: readonly TemplateFile[],
  type: string,
  mutate: (properties: Json, id: string, template: TemplateFile) => void,
): void => {
  for (const template of templates) {
    for (const [id, resource] of Object.entries(resourcesOfDocument(template))) {
      if ((resource as Json).Type === type) {
        mutate(((resource as Json).Properties ?? {}) as Json, id, template);
      }
    }
  }
};

describe('the fleet this repository ships', () => {
  const templates = synthesiseFleet();

  it('passes every rule', () => {
    const result = auditSyntheticCanaries({ templates });
    expect(formatViolations(result.violations)).toBe('');
    expect(result.violations).toEqual([]);
  });

  it('reads the canaries, probes and quorum alarms it claims to', () => {
    const result = auditSyntheticCanaries({ templates });
    expect(result.canariesRead).toBe(REGIONS.length);
    expect(result.probesRead).toBe(1);
    expect(result.quorumAlarmsRead).toBe(1);
  });

  // The gate is tag-scoped, and a gate whose scope has gone empty passes
  // exactly like one that checked everything.
  it('reads nothing once the fleet tag is gone', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::Synthetics::Canary', (properties) => {
      properties.Tags = (properties.Tags as Json[]).filter(
        (tag) => tag.Key !== CANARY_FLEET_TAG,
      );
    });
    expect(auditSyntheticCanaries({ templates }).canariesRead).toBe(0);
  });
});

describe('a canary that deploys and observes less than it claims', () => {
  it('reports one attached to a VPC', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::Synthetics::Canary', (properties) => {
      properties.VPCConfig = { VpcId: 'vpc-0123456789abcdef0', SubnetIds: ['subnet-abc'] };
    });
    expect(rulesFor(templates)).toContain('canary-in-vpc');
  });

  it('reports a probe with no body marker', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::Synthetics::Canary', (properties) => {
      delete properties.RunConfig.EnvironmentVariables.PROBE_BODY_MARKER;
    });
    expect(rulesFor(templates)).toContain('canary-missing-probe-config');
  });

  // The statement the generated role does not carry. Without it the republish
  // is denied on every run and the quorum alarm reads a series nothing writes.
  it('reports a role that may not publish into the fleet namespace', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::IAM::Policy', (properties) => {
      const document = properties.PolicyDocument as Json;
      document.Statement = (document.Statement as Json[]).filter(
        (statement) => statement.Action !== 'cloudwatch:PutMetricData',
      );
    });
    expect(rulesFor(templates)).toContain('canary-without-metric-grant');
  });

  it('reports unencrypted run artifacts', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::Synthetics::Canary', (properties) => {
      delete properties.ArtifactConfig;
    });
    expect(rulesFor(templates)).toContain('canary-artifacts-unencrypted');
  });

  it('reports a schedule Synthetics will not accept', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::Synthetics::Canary', (properties) => {
      properties.Schedule.Expression = 'rate(90 minutes)';
    });
    expect(rulesFor(templates)).toContain('canary-schedule-outside-range');
  });

  it('reports a timeout that would overlap runs', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::Synthetics::Canary', (properties) => {
      properties.Schedule.Expression = 'rate(1 minute)';
      properties.RunConfig.TimeoutInSeconds = 120;
    });
    expect(rulesFor(templates)).toContain('canary-timeout-exceeds-schedule');
  });
});

describe('an alarm that reads silence as health', () => {
  it('reports a local alarm that ignores missing data', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      if (properties.Namespace === 'CloudWatchSynthetics') {
        properties.TreatMissingData = 'notBreaching';
      }
    });
    expect(rulesFor(templates)).toContain('local-alarm-ignores-missing-data');
  });

  it('reports a region with no local alarm at all', () => {
    const templates = clone(synthesiseFleet());
    for (const template of templates) {
      const resources = resourcesOfDocument(template);
      for (const [id, resource] of Object.entries(resources)) {
        if (
          (resource as Json).Type === 'AWS::CloudWatch::Alarm' &&
          ((resource as Json).Properties as Json)?.Namespace === 'CloudWatchSynthetics'
        ) {
          delete resources[id];
        }
      }
    }
    expect(rulesFor(templates)).toContain('local-alarm-missing');
  });

  it('reports a quorum alarm that ignores missing data', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      if (String(properties.AlarmName ?? '').endsWith('-quorum')) {
        properties.TreatMissingData = 'missing';
      }
    });
    expect(rulesFor(templates)).toContain('quorum-alarm-ignores-missing-data');
  });

  it('reports a heartbeat alarm that no longer treats no-data as a breach', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      if (String(properties.AlarmName ?? '').endsWith('-silent')) {
        properties.TreatMissingData = 'notBreaching';
      }
    });
    expect(rulesFor(templates)).toContain('heartbeat-alarm-missing');
  });

  it('reports a region with no heartbeat alarm', () => {
    const templates = clone(synthesiseFleet());
    for (const template of templates) {
      const resources = resourcesOfDocument(template);
      for (const [id, resource] of Object.entries(resources)) {
        const name = String(((resource as Json).Properties as Json)?.AlarmName ?? '');
        if (name.endsWith('-silent')) delete resources[id];
      }
    }
    expect(rulesFor(templates)).toContain('heartbeat-alarm-missing');
  });

  it('reports an alarm that is evaluated and tells nobody', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      delete properties.AlarmActions;
    });
    expect(rulesFor(templates)).toContain('alarm-without-action');
  });
});

describe('a quorum that is not a comparison', () => {
  // One silent region would otherwise remove the data point for every region.
  it('reports terms summed without FILL()', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      for (const member of (properties.Metrics ?? []) as Json[]) {
        if (typeof member.Expression === 'string' && member.Expression.includes('FILL')) {
          member.Expression = 'm0 + m1 + m2';
        }
      }
    });
    expect(rulesFor(templates)).toContain('quorum-expression-without-fill');
  });

  it('reports a quorum of one', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      if (String(properties.AlarmName ?? '').endsWith('-quorum')) properties.Threshold = 1;
    });
    expect(rulesFor(templates)).toContain('quorum-threshold-below-two');
  });

  // The alarm deploys, evaluates for ever, and stays green through a total
  // outage because its sum cannot reach the threshold.
  it('reports a threshold above the number of terms', () => {
    const templates = clone(synthesiseFleet());
    eachResource(templates, 'AWS::CloudWatch::Alarm', (properties) => {
      if (String(properties.AlarmName ?? '').endsWith('-quorum')) properties.Threshold = 9;
    });
    expect(rulesFor(templates)).toContain('quorum-terms-below-threshold');
  });

  it('reports per-region alarms with nothing comparing them', () => {
    const templates = clone(synthesiseFleet());
    for (const template of templates) {
      const resources = resourcesOfDocument(template);
      for (const [id, resource] of Object.entries(resources)) {
        const name = String(((resource as Json).Properties as Json)?.AlarmName ?? '');
        if (name.endsWith('-quorum')) delete resources[id];
      }
    }
    expect(rulesFor(templates)).toContain('quorum-alarm-missing');
  });
});

describe('reading the two template shapes CDK emits', () => {
  // CDK renders the flat Namespace/MetricName/Dimensions properties normally,
  // and the Metrics array as soon as the metric carries a label. A gate that
  // understood only one of them would go quiet the day somebody added a legend
  // label — quiet in the direction of finding nothing.
  it('finds the same alarm in either shape', () => {
    const flat: TemplateFile = {
      path: 'Flat.template.json',
      document: {
        Resources: {
          Regional: {
            Type: 'AWS::CloudWatch::Alarm',
            Properties: {
              AlarmName: 'production-canary-health-us-east-1',
              Namespace: CANARY_METRIC_NAMESPACE,
              MetricName: PROBE_FAILURE_METRIC,
              Statistic: 'Maximum',
              Dimensions: [
                { Name: ENVIRONMENT_DIMENSION, Value: 'production' },
                { Name: PROBE_DIMENSION, Value: 'health' },
                { Name: REGION_DIMENSION, Value: 'us-east-1' },
              ],
              Threshold: 1,
              AlarmActions: [{ Ref: 'Topic' }],
            },
          },
        },
      },
    };
    // No quorum alarm and no heartbeat alarm beside it, so both absences are
    // reported — which is how we know the regional alarm was recognised at all.
    expect(rulesFor([flat])).toEqual(
      expect.arrayContaining(['quorum-alarm-missing', 'heartbeat-alarm-missing']),
    );
  });

  it('parses the rate() expressions Synthetics accepts', () => {
    expect(scheduleMinutesOf('rate(5 minutes)')).toBe(5);
    expect(scheduleMinutesOf('rate(1 minute)')).toBe(1);
    expect(scheduleMinutesOf('rate(1 hour)')).toBe(60);
    expect(scheduleMinutesOf('cron(0 * * * ? *)')).toBeUndefined();
  });
});

/**
 * The gate restates the contract rather than importing it, so that a rename in
 * `lib/` cannot quietly move the rules with it. These are what make the
 * restatement deliberate: a change to either side is one failing assertion
 * here, instead of a gate that keeps passing over something it no longer
 * checks.
 */
describe('the restated constants', () => {
  it('matches the library', () => {
    expect(CANARY_FLEET_TAG).toBe(LIBRARY_FLEET_TAG);
    expect(CANARY_METRIC_NAMESPACE).toBe(LIBRARY_NAMESPACE);
    expect(PROBE_FAILURE_METRIC).toBe(LIBRARY_FAILURE_METRIC);
    expect(ENVIRONMENT_DIMENSION).toBe(LIBRARY_ENVIRONMENT_DIMENSION);
    expect(PROBE_DIMENSION).toBe(LIBRARY_PROBE_DIMENSION);
    expect(REGION_DIMENSION).toBe(LIBRARY_REGION_DIMENSION);
    expect(REQUIRED_PROBE_ENV_VARS).toEqual(LIBRARY_REQUIRED_ENV_VARS);
    expect(MIN_SCHEDULE_MINUTES).toBe(LIBRARY_MIN_SCHEDULE);
    expect(MAX_SCHEDULE_MINUTES).toBe(LIBRARY_MAX_SCHEDULE);
  });
});
