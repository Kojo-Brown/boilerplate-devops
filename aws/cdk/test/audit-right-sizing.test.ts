import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template } from 'aws-cdk-lib/assertions';
import {
  BREACHING,
  CI_WORKFLOW_PATH,
  COVERAGE_GAP_METRIC,
  CPU_TARGET_METRIC,
  ENROLLED_METRIC,
  GOVERNED_SERVICES,
  MEMORY_TARGET_METRIC,
  RIGHT_SIZING_DOC_PATH,
  RIGHT_SIZING_METRIC_NAMESPACE as AUDIT_NAMESPACE,
  STEP_SCALING_POLICY_TYPE,
  SWEEP_SUCCESS_METRIC,
  type TemplateFile,
  auditRightSizing,
  formatViolations,
  isExcludedFromRecommendations,
  isGovernedWrite,
  referencedLogicalIds,
  rightSizingAlarmsIn,
  scalingFactsByService,
  servicesIn,
  sweepersIn,
} from '../tools/audit-right-sizing';
import {
  COVERAGE_GAP_METRIC as LIB_COVERAGE_GAP_METRIC,
  ENROLLED_METRIC as LIB_ENROLLED_METRIC,
  RIGHT_SIZING_METRIC_NAMESPACE,
  RIGHT_SIZING_WORKLOADS,
  SWEEP_SUCCESS_METRIC as LIB_SWEEP_SUCCESS_METRIC,
  type RightSizingWorkload,
  renderRightSizingTable,
} from '../lib/right-sizing';
import { RightSizingStack } from '../lib/right-sizing-stack';

/**
 * Tests for the right-sizing gate.
 *
 * Each rule is exercised against a **real synthesised template** with one
 * property changed, rather than against a hand-written fixture, because every
 * failure here is one property away from a template that deploys cleanly: a
 * memory scaling policy added to the blue/green service, one `ecs:UpdateService`
 * on the sweeper's role, the staleness alarm's `treatMissingData` moved off
 * `breaching`. A fixture would prove the rule reads a shape; this proves it
 * reads the shape CDK actually writes.
 */

const ENV = { account: '123456789012', region: 'us-east-1' };

/* ── Real synthesised inputs ──────────────────────────────────────────────── */

const sweeperTemplate = (): TemplateFile => {
  const app = new cdk.App();
  const topicStack = new cdk.Stack(app, 'Topics', { env: ENV });
  const stack = new RightSizingStack(app, 'RightSizingStack', {
    alarmTopic: new sns.Topic(topicStack, 'AlarmTopic', {
      topicName: 'production-cloudwatch-alarms',
    }),
    workloads: RIGHT_SIZING_WORKLOADS,
    env: ENV,
  });
  return {
    path: 'RightSizingStack.template.json',
    document: Template.fromStack(stack).toJSON(),
  };
};

/**
 * A service template in the shape `EcsStack` writes: a service, its task
 * definition, a scalable target, and target tracking on both CPU and memory.
 *
 * Built by hand rather than synthesised from `EcsStack` because that stack needs
 * a VPC, a certificate and an image, and what is under test here is the two-hop
 * resolution from a scaling policy through a scalable target to a service — not
 * the stack that happens to create them.
 */
const serviceTemplate = (options: {
  readonly stackName: string;
  readonly constructId?: string;
  readonly serviceName: string;
  readonly cpu?: number;
  readonly memory?: number;
  readonly targetMetrics?: readonly string[];
  readonly stepScaling?: boolean;
}): TemplateFile => {
  const constructId = options.constructId ?? 'Service';
  const resources: Record<string, unknown> = {
    TaskDef: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Cpu: String(options.cpu ?? 1024),
        Memory: String(options.memory ?? 2048),
      },
      Metadata: { 'aws:cdk:path': `${options.stackName}/TaskDefinition/Resource` },
    },
    Service: {
      Type: 'AWS::ECS::Service',
      Properties: {
        ServiceName: options.serviceName,
        TaskDefinition: { Ref: 'TaskDef' },
      },
      Metadata: { 'aws:cdk:path': `${options.stackName}/${constructId}/Service` },
    },
  };

  const metrics = options.targetMetrics ?? [];
  if (metrics.length > 0 || options.stepScaling) {
    resources.ScalableTarget = {
      Type: 'AWS::ApplicationAutoScaling::ScalableTarget',
      Properties: {
        // The shape CDK writes: a join whose GetAtt names the service.
        ResourceId: {
          'Fn::Join': ['', ['service/cluster/', { 'Fn::GetAtt': ['Service', 'Name'] }]],
        },
        ScalableDimension: 'ecs:service:DesiredCount',
        ServiceNamespace: 'ecs',
      },
    };
  }
  metrics.forEach((metric, index) => {
    resources[`Policy${index}`] = {
      Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
      Properties: {
        PolicyType: 'TargetTrackingScaling',
        ScalingTargetId: { Ref: 'ScalableTarget' },
        TargetTrackingScalingPolicyConfiguration: {
          PredefinedMetricSpecification: { PredefinedMetricType: metric },
        },
      },
    };
  });
  if (options.stepScaling) {
    resources.StepPolicy = {
      Type: 'AWS::ApplicationAutoScaling::ScalingPolicy',
      Properties: {
        PolicyType: STEP_SCALING_POLICY_TYPE,
        ScalingTargetId: { Ref: 'ScalableTarget' },
        StepScalingPolicyConfiguration: { AdjustmentType: 'ChangeInCapacity' },
      },
    };
  }

  return { path: `${options.stackName}.template.json`, document: { Resources: resources } };
};

/** The whole fleet, in the shape the shipped catalogue expects. */
const fleet = (): TemplateFile[] => [
  serviceTemplate({
    stackName: 'EcsStack-Staging',
    serviceName: 'staging-service',
    cpu: 512,
    memory: 1024,
    targetMetrics: [CPU_TARGET_METRIC, MEMORY_TARGET_METRIC],
  }),
  serviceTemplate({
    stackName: 'EcsStack-Production',
    serviceName: 'production-service',
    targetMetrics: [CPU_TARGET_METRIC, MEMORY_TARGET_METRIC],
  }),
  serviceTemplate({
    stackName: 'PreviewPrStack-1',
    serviceName: 'preview-pr-1',
    cpu: 256,
    memory: 512,
  }),
  serviceTemplate({
    stackName: 'BlueGreenDeployStack-Staging',
    serviceName: 'staging-bg-service',
    cpu: 512,
    memory: 1024,
  }),
  serviceTemplate({
    stackName: 'BlueGreenDeployStack-Production',
    serviceName: 'production-bg-service',
  }),
  serviceTemplate({
    stackName: 'CanaryDeployStack-Staging',
    constructId: 'StableService',
    serviceName: 'staging-stable-service',
  }),
  serviceTemplate({
    stackName: 'CanaryDeployStack-Production',
    constructId: 'StableService',
    serviceName: 'production-stable-service',
  }),
  serviceTemplate({
    stackName: 'CanaryDeployStack-Staging',
    constructId: 'CanaryService',
    serviceName: 'staging-canary-service',
  }),
  serviceTemplate({
    stackName: 'CanaryDeployStack-Production',
    constructId: 'CanaryService',
    serviceName: 'production-canary-service',
  }),
  serviceTemplate({
    stackName: 'OtelCollectorStack-Staging',
    serviceName: 'staging-otel-sampler',
  }),
  serviceTemplate({
    stackName: 'OtelCollectorStack-Production',
    serviceName: 'production-otel-sampler',
  }),
  sweeperTemplate(),
];

const DOC = `# right-sizing\n\n${renderRightSizingTable()}\n`;
const CI = 'steps:\n  - run: npm run audit:right-sizing\n';

const audit = (templates: readonly TemplateFile[], extra: Record<string, unknown> = {}) =>
  auditRightSizing({ templates, doc: DOC, ciWorkflow: CI, ...extra });

const rulesFrom = (templates: readonly TemplateFile[], extra: Record<string, unknown> = {}) =>
  audit(templates, extra).violations.map((violation) => violation.rule);

/** Deep-clone a template so a test can remove one property from it. */
const clone = (template: TemplateFile): TemplateFile => ({
  path: template.path,
  document: JSON.parse(JSON.stringify(template.document)),
});

const resourcesOf = (template: TemplateFile): Record<string, any> =>
  (template.document as { Resources: Record<string, any> }).Resources;

const findResource = (template: TemplateFile, type: string): Record<string, any> => {
  const found = Object.values(resourcesOf(template)).find((resource) => resource.Type === type);
  if (!found) throw new Error(`no ${type} in ${template.path}`);
  return found;
};

/* ── The constants the gate restates ─────────────────────────────────────── */

describe('the restated constants', () => {
  /**
   * The gate restates these so a rename in the library is one failing assertion
   * rather than a silently weakened rule. These assertions are the other half of
   * that bargain.
   */
  it('match the library', () => {
    expect(AUDIT_NAMESPACE).toBe(RIGHT_SIZING_METRIC_NAMESPACE);
    expect(SWEEP_SUCCESS_METRIC).toBe(LIB_SWEEP_SUCCESS_METRIC);
    expect(ENROLLED_METRIC).toBe(LIB_ENROLLED_METRIC);
    expect(COVERAGE_GAP_METRIC).toBe(LIB_COVERAGE_GAP_METRIC);
    expect(BREACHING).toBe('breaching');
  });

  it('name the paths the CLI reads', () => {
    expect(RIGHT_SIZING_DOC_PATH).toContain('right-sizing.md');
    expect(CI_WORKFLOW_PATH).toContain('ci.yml');
  });
});

/* ── Template reading ─────────────────────────────────────────────────────── */

describe('reading the templates', () => {
  it('finds a logical id inside a nested join', () => {
    expect(
      referencedLogicalIds({
        'Fn::Join': ['', ['service/', { Ref: 'Cluster' }, '/', { 'Fn::GetAtt': ['Svc', 'Name'] }]],
      }),
    ).toEqual(expect.arrayContaining(['Cluster', 'Svc']));
  });

  it('resolves a scaling policy to the service two hops away', () => {
    const template = serviceTemplate({
      stackName: 'EcsStack-Staging',
      serviceName: 'staging-service',
      targetMetrics: [CPU_TARGET_METRIC, MEMORY_TARGET_METRIC],
    });
    const facts = scalingFactsByService(template);
    expect([...(facts.get('Service')?.targetTracked ?? [])].sort()).toEqual(
      [CPU_TARGET_METRIC, MEMORY_TARGET_METRIC].sort(),
    );
    expect(facts.get('Service')?.step).toBe(false);
  });

  it('reads the task size off the referenced task definition', () => {
    const [service] = servicesIn(
      serviceTemplate({
        stackName: 'EcsStack-Staging',
        serviceName: 'staging-service',
        cpu: 512,
        memory: 1024,
      }),
    );
    expect(service.taskCpu).toBe(512);
    expect(service.taskMemoryMiB).toBe(1024);
  });

  it('treats either documented exclusion as an exclusion, and one metric as not', () => {
    const excludedBoth = servicesIn(
      serviceTemplate({
        stackName: 'EcsStack-Staging',
        serviceName: 'staging-service',
        targetMetrics: [CPU_TARGET_METRIC, MEMORY_TARGET_METRIC],
      }),
    )[0];
    const excludedStep = servicesIn(
      serviceTemplate({
        stackName: 'EcsStack-Staging',
        serviceName: 'staging-service',
        stepScaling: true,
      }),
    )[0];
    const cpuOnly = servicesIn(
      serviceTemplate({
        stackName: 'EcsStack-Staging',
        serviceName: 'staging-service',
        targetMetrics: [CPU_TARGET_METRIC],
      }),
    )[0];

    expect(isExcludedFromRecommendations(excludedBoth)).toBe(true);
    expect(isExcludedFromRecommendations(excludedStep)).toBe(true);
    // AWS disqualifies on CPU *and* memory. Target tracking on CPU alone is
    // handled differently and does not exclude.
    expect(isExcludedFromRecommendations(cpuOnly)).toBe(false);
  });

  it('finds the sweeper by the namespace it publishes to', () => {
    const [sweeper] = sweepersIn(sweeperTemplate());
    expect(sweeper.constructPath).toContain('RightSizingSweeper');
    expect(sweeper.writeActions).toEqual([]);
    expect(sweeper.scheduled).toBe(true);
    expect(sweeper.scheduleDeadLettered).toBe(true);
  });

  it('reads only the alarms over this namespace', () => {
    expect(rightSizingAlarmsIn(sweeperTemplate())).toHaveLength(3);
  });
});

describe('classifying an action as a write', () => {
  it.each(GOVERNED_SERVICES)('treats a non-read verb on %s as a write', (service) => {
    expect(isGovernedWrite(`${service}:Update`)).toBe(true);
    expect(isGovernedWrite(`${service}:*`)).toBe(true);
  });

  it.each([
    'compute-optimizer:GetEnrollmentStatus',
    'compute-optimizer:GetECSServiceRecommendations',
    'ecs:DescribeServices',
    'lambda:ListFunctions',
    'cloudwatch:PutMetricData',
    'logs:PutLogEvents',
  ])('allows %s', (action) => {
    expect(isGovernedWrite(action)).toBe(false);
  });

  it('treats a bare wildcard as a write', () => {
    expect(isGovernedWrite('*')).toBe(true);
  });

  /**
   * The two that do not look like writes: the first creates a service-linked
   * role, the second writes objects into an S3 bucket.
   */
  it.each([
    'compute-optimizer:UpdateEnrollmentStatus',
    'compute-optimizer:ExportECSServiceRecommendations',
    'compute-optimizer:PutRecommendationPreferences',
  ])('treats %s as a write', (action) => {
    expect(isGovernedWrite(action)).toBe(true);
  });
});

/* ── The rules ───────────────────────────────────────────────────────────── */

describe('the shipped fleet', () => {
  it('passes', () => {
    const result = audit(fleet());
    expect(result.violations).toEqual([]);
    expect(result.servicesRead).toBe(11);
    expect(result.sweepersRead).toBe(1);
    expect(result.alarmsRead).toBe(3);
  });
});

describe('the inventory rules', () => {
  it('fails an ECS service no entry claims', () => {
    const templates = [
      ...fleet(),
      serviceTemplate({ stackName: 'NewStack-Staging', serviceName: 'staging-new-service' }),
    ];
    expect(rulesFrom(templates)).toContain('service-unclassified');
  });

  it('fails when two entries claim one service', () => {
    const duplicated: RightSizingWorkload[] = [
      ...RIGHT_SIZING_WORKLOADS,
      { ...RIGHT_SIZING_WORKLOADS[0], id: 'staging-application-copy' },
    ];
    expect(rulesFrom(fleet(), { workloads: duplicated })).toContain('service-ambiguous');
  });

  it('fails a matched count that is not what the entry declares', () => {
    const withoutProduction = fleet().filter(
      (template) => template.path !== 'EcsStack-Production.template.json',
    );
    expect(rulesFrom(withoutProduction)).toContain('service-count-drift');
  });

  /**
   * The rule that caught a real bug while this was being written: the catalogue
   * said `blue-green` and the deployed name is `staging-bg-service`, so the
   * sweeper would never have seen either copy — and would have reported no
   * coverage gap for them either, because a gap is measured against entries the
   * sweeper can match.
   */
  it('fails a serviceNamePattern that does not match the deployed name', () => {
    const wrongPattern = RIGHT_SIZING_WORKLOADS.map((workload) =>
      workload.id === 'blue-green-service'
        ? { ...workload, serviceNamePattern: 'blue-green' }
        : workload,
    );
    const rules = rulesFrom(fleet(), { workloads: wrongPattern });
    expect(rules).toContain('service-name-pattern-mismatch');
  });

  it('fails two patterns claiming one deployed name', () => {
    const overlapping = RIGHT_SIZING_WORKLOADS.map((workload) =>
      workload.id === 'otel-sampler-service'
        ? { ...workload, serviceNamePattern: '*' }
        : workload,
    );
    expect(rulesFrom(fleet(), { workloads: overlapping })).toContain(
      'service-name-pattern-ambiguous',
    );
  });

  it('reports any offline catalogue finding through the gate too', () => {
    const broken = RIGHT_SIZING_WORKLOADS.map((workload) =>
      workload.id === 'blue-green-service' ? { ...workload, floor: undefined } : workload,
    );
    expect(rulesFrom(fleet(), { workloads: broken })).toContain('catalogue');
  });
});

describe('the eligibility rules', () => {
  /**
   * Remove one of `EcsStack`'s two scaling policies and the service becomes
   * eligible, which makes the catalogue's reason an excuse. The first symptom
   * otherwise is a real finding arriving marked `posture-uncovered`.
   */
  it('fails an uncovered entry whose template no longer carries the exclusion', () => {
    const templates = fleet().map((template) => {
      if (template.path !== 'EcsStack-Production.template.json') return template;
      const copy = clone(template);
      delete resourcesOf(copy).Policy1;
      return copy;
    });
    const rules = rulesFrom(templates);
    expect(rules).toContain('uncovered-claim-unsupported');
  });

  it('fails an uncovered entry citing step scaling with no step scaling policy', () => {
    const claimingStep = RIGHT_SIZING_WORKLOADS.map((workload) =>
      workload.id === 'preview-pr-service'
        ? { ...workload, uncoveredReason: 'step-scaling' as const }
        : workload,
    );
    expect(rulesFrom(fleet(), { workloads: claimingStep })).toContain(
      'uncovered-claim-unsupported',
    );
  });

  /**
   * The expensive direction. A memory scaling policy added to the blue/green
   * service silently ends every recommendation for it: AWS returns nothing and
   * says nothing, every proposal becomes impossible, and the coverage alarm is
   * red by construction.
   */
  it('fails a proposable entry whose service has become excluded', () => {
    const templates = fleet().map((template) =>
      template.path === 'BlueGreenDeployStack-Production.template.json'
        ? serviceTemplate({
            stackName: 'BlueGreenDeployStack-Production',
            serviceName: 'production-bg-service',
            targetMetrics: [CPU_TARGET_METRIC, MEMORY_TARGET_METRIC],
          })
        : template,
    );
    expect(rulesFrom(templates)).toContain('covered-service-excluded');
  });

  it('fails a held entry whose service has become excluded, by a step policy', () => {
    const templates = fleet().map((template) =>
      template.path === 'OtelCollectorStack-Production.template.json'
        ? serviceTemplate({
            stackName: 'OtelCollectorStack-Production',
            serviceName: 'production-otel-sampler',
            stepScaling: true,
          })
        : template,
    );
    expect(rulesFrom(templates)).toContain('covered-service-excluded');
  });
});

describe('the size rules', () => {
  /** Synthesises, passes Checkov, and is rejected at RegisterTaskDefinition. */
  it('fails a task CPU/memory pair Fargate would not register', () => {
    const templates = fleet().map((template) =>
      template.path === 'OtelCollectorStack-Staging.template.json'
        ? serviceTemplate({
            stackName: 'OtelCollectorStack-Staging',
            serviceName: 'staging-otel-sampler',
            cpu: 512,
            memory: 512,
          })
        : template,
    );
    expect(rulesFrom(templates)).toContain('task-size-invalid');
  });

  it('fails a proposable service already smaller than its own floor', () => {
    const templates = fleet().map((template) =>
      template.path === 'BlueGreenDeployStack-Staging.template.json'
        ? serviceTemplate({
            stackName: 'BlueGreenDeployStack-Staging',
            serviceName: 'staging-bg-service',
            cpu: 256,
            memory: 512,
          })
        : template,
    );
    expect(rulesFrom(templates)).toContain('task-size-below-floor');
  });
});

describe('the sweeper rules', () => {
  it('fails when nothing publishes to the namespace', () => {
    const withoutSweeper = fleet().filter(
      (template) => template.path !== 'RightSizingStack.template.json',
    );
    expect(rulesFrom(withoutSweeper)).toContain('sweeper-missing');
  });

  /**
   * One added action turns a proposal into drift the next deploy reverts, as
   * silently as it was made — and it deploys cleanly past every other gate here.
   */
  it('fails one added write action on the sweeper role', () => {
    const templates = fleet().map((template) => {
      if (template.path !== 'RightSizingStack.template.json') return template;
      const copy = clone(template);
      const policy = findResource(copy, 'AWS::IAM::Policy');
      policy.Properties.PolicyDocument.Statement.push({
        Effect: 'Allow',
        Action: 'ecs:UpdateService',
        Resource: '*',
      });
      return copy;
    });
    const result = audit(templates);
    expect(result.violations.map((violation) => violation.rule)).toContain('sweeper-can-write');
    expect(formatViolations(result.violations)).toContain('ecs:UpdateService');
  });

  it('ignores a Deny statement, which is not a grant', () => {
    const templates = fleet().map((template) => {
      if (template.path !== 'RightSizingStack.template.json') return template;
      const copy = clone(template);
      findResource(copy, 'AWS::IAM::Policy').Properties.PolicyDocument.Statement.push({
        Effect: 'Deny',
        Action: 'ecs:UpdateService',
        Resource: '*',
      });
      return copy;
    });
    expect(rulesFrom(templates)).not.toContain('sweeper-can-write');
  });

  it('fails a sweeper nothing schedules', () => {
    const templates = fleet().map((template) => {
      if (template.path !== 'RightSizingStack.template.json') return template;
      const copy = clone(template);
      for (const [logicalId, resource] of Object.entries(resourcesOf(copy))) {
        if (resource.Type === 'AWS::Events::Rule') delete resourcesOf(copy)[logicalId];
      }
      return copy;
    });
    expect(rulesFrom(templates)).toContain('sweep-rule-missing');
  });

  it('fails a schedule whose target drops what it cannot deliver', () => {
    const templates = fleet().map((template) => {
      if (template.path !== 'RightSizingStack.template.json') return template;
      const copy = clone(template);
      const rule = findResource(copy, 'AWS::Events::Rule');
      for (const target of rule.Properties.Targets) delete target.DeadLetterConfig;
      return copy;
    });
    expect(rulesFrom(templates)).toContain('sweep-rule-no-dlq');
  });
});

describe('the alarm rules', () => {
  const withoutAlarmOn = (metricName: string): TemplateFile[] =>
    fleet().map((template) => {
      if (template.path !== 'RightSizingStack.template.json') return template;
      const copy = clone(template);
      for (const [logicalId, resource] of Object.entries(resourcesOf(copy))) {
        if (
          resource.Type === 'AWS::CloudWatch::Alarm' &&
          resource.Properties?.MetricName === metricName
        ) {
          delete resourcesOf(copy)[logicalId];
        }
      }
      return copy;
    });

  it('fails when nothing alarms on the sweep completing', () => {
    expect(rulesFrom(withoutAlarmOn(SWEEP_SUCCESS_METRIC))).toContain('stale-alarm-missing');
  });

  it('fails when nothing alarms on enrolment', () => {
    expect(rulesFrom(withoutAlarmOn(ENROLLED_METRIC))).toContain('enrolment-alarm-missing');
  });

  it('fails when nothing alarms on the coverage gap', () => {
    expect(rulesFrom(withoutAlarmOn(COVERAGE_GAP_METRIC))).toContain('coverage-alarm-missing');
  });

  /**
   * The single property that makes "the integration stopped" visible, and one
   * somebody can soften in a console while the alarm goes on existing.
   */
  it('fails the staleness alarm tolerating missing data', () => {
    const templates = fleet().map((template) => {
      if (template.path !== 'RightSizingStack.template.json') return template;
      const copy = clone(template);
      for (const resource of Object.values(resourcesOf(copy))) {
        if (
          resource.Type === 'AWS::CloudWatch::Alarm' &&
          resource.Properties?.MetricName === SWEEP_SUCCESS_METRIC
        ) {
          resource.Properties.TreatMissingData = 'notBreaching';
        }
      }
      return copy;
    });
    expect(rulesFrom(templates)).toContain('stale-alarm-not-breaching');
  });
});

describe('the document and CI rules', () => {
  it('fails a hand-edited posture table', () => {
    expect(
      auditRightSizing({
        templates: fleet(),
        doc: '# right-sizing\n\n| Workload | Services |\n| --- | --- |\n',
        ciWorkflow: CI,
      }).violations.map((violation) => violation.rule),
    ).toContain('doc-table-drift');
  });

  it('fails when no job runs the gate', () => {
    expect(
      auditRightSizing({ templates: fleet(), doc: DOC, ciWorkflow: 'steps: []' }).violations.map(
        (violation) => violation.rule,
      ),
    ).toContain('audit-not-run-in-ci');
  });

  it('skips the CI rule when no workflow is supplied', () => {
    expect(
      auditRightSizing({ templates: fleet(), doc: DOC }).violations.map(
        (violation) => violation.rule,
      ),
    ).not.toContain('audit-not-run-in-ci');
  });
});

describe('formatting', () => {
  it('names the rule, the file, the location and the reason', () => {
    const output = formatViolations([
      {
        rule: 'sweeper-can-write',
        file: 'RightSizingStack.template.json',
        location: 'RightSizingSweeper/Resource',
        message: 'because.',
      },
    ]);
    expect(output).toContain('[sweeper-can-write]');
    expect(output).toContain('RightSizingStack.template.json');
    expect(output).toContain('RightSizingSweeper/Resource');
    expect(output).toContain('because.');
  });
});
