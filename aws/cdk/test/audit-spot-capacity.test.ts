import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as fs from 'fs';
import * as path from 'path';
import * as sns from 'aws-cdk-lib/aws-sns';
import { EcsStack } from '../lib/ecs-stack';
import { PreviewEnvironmentStack } from '../lib/preview-environment-stack';
import { PreviewPrStack } from '../lib/preview-pr-stack';
import { SpotInterruptionStack } from '../lib/spot-interruption-stack';
import {
  FARGATE_SPOT_WARNING_SECONDS,
  SPOT_CAPACITY_PROVIDER,
  SPOT_INTERRUPTION_STOP_CODE,
  SPOT_WORKLOADS,
  type SpotWorkload,
  spotWorkloadById,
} from '../lib/spot-capacity';
import {
  AUDIT_SCRIPT,
  BREACHING,
  CONTAINER_INSIGHTS_NAMESPACE,
  DEREGISTRATION_DELAY_ATTRIBUTE,
  DESIRED_TASK_COUNT_METRIC,
  ELB_DEFAULT_DEREGISTRATION_DELAY,
  RUNNING_TASK_COUNT_METRIC,
  type TemplateFile,
  auditSpotCapacity,
  buildExportIndex,
  deregistrationDelay,
  readInterruptionRules,
  readServices,
  readStarvationAlarms,
  resolveReference,
  stopTimeouts,
} from '../tools/audit-spot-capacity';

/**
 * Tests for the Spot capacity gate.
 *
 * The load-bearing ones are the two that use real inputs: the stacks this
 * repository ships go through the audit against the real catalogue entries for
 * them, and the shipped `docs/spot.md` is held to the table the catalogue
 * renders. Those are what fail when the gate stops matching what the repository
 * produces, rather than passing everything in CI.
 *
 * The rest are the near misses, each one property removed from an otherwise
 * correct template. Every one of them deploys — or, in the case of
 * `capacity-provider-unassociated`, passes every other gate here and is
 * rejected at `CreateService` — and none of them fails a synth, a health check
 * or a unit test anywhere else.
 */

const ENV = { account: '123456789012', region: 'us-east-1' };
const REPO_ROOT = path.join(__dirname, '..', '..', '..');

const SHIPPED_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'spot.md'), 'utf8');
const CI = `      - name: Audit the Fargate Spot posture\n        run: npm run ${AUDIT_SCRIPT}\n`;

const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555';

const only = (ids: readonly string[]): readonly SpotWorkload[] =>
  SPOT_WORKLOADS.filter((workload) => ids.includes(workload.id));

const SHIPPED_IDS = ['staging-application', 'preview-pr-service'];

interface ShippedOptions {
  /** Passed through to `EcsStack`, so a test can take the posture away. */
  readonly ecsCapacity?: SpotWorkload;
  /** Passed through to `PreviewPrStack`. */
  readonly previewCapacity?: SpotWorkload;
  /** False leaves the preview cluster without the association. */
  readonly previewSpotProvider?: boolean;
  /** False leaves the reclaims unwatched. */
  readonly withInterruptionStack?: boolean;
}

/**
 * The two Spot-bearing services as the repository actually ships them, plus the
 * stack that watches them.
 *
 * `enable-path-metadata` because `cdk synth` records the construct path of
 * every resource and `Template.fromStack` does not — and the catalogue matches
 * on a suffix of that path, so without it there would be nothing to match.
 */
const shippedTemplates = (options: ShippedOptions = {}): TemplateFile[] => {
  const app = new cdk.App({ context: { 'aws:cdk:enable-path-metadata': true } });
  const networkStack = new cdk.Stack(app, 'NetworkStack', { env: ENV });
  const vpc = new ec2.Vpc(networkStack, 'Vpc', { maxAzs: 2 });

  const topicStack = new cdk.Stack(app, 'Topics', { env: ENV });
  const alarmTopic = new sns.Topic(topicStack, 'AlarmTopic', {
    topicName: 'staging-cloudwatch-alarms',
  });

  const ecs = new EcsStack(app, 'EcsStack-Staging', {
    vpc,
    envName: 'staging',
    certificateArn: CERTIFICATE_ARN,
    desiredCount: 1,
    capacity: 'ecsCapacity' in options ? options.ecsCapacity : spotWorkloadById('staging-application'),
    env: ENV,
  });

  const shared = new PreviewEnvironmentStack(app, 'PreviewEnvironmentStack', {
    vpc,
    certificateArn: CERTIFICATE_ARN,
    previewDomain: 'preview.example.com',
    repository: 'example-org/example-repo',
    spotCapacityProvider: options.previewSpotProvider ?? true,
    env: ENV,
  });

  const preview = new PreviewPrStack(app, 'PreviewPrStack-1', {
    prNumber: 1,
    repository: 'example-org/example-repo',
    imageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/app:sha-abc123',
    vpc,
    cluster: shared.cluster,
    httpsListener: shared.httpsListener,
    taskSecurityGroup: shared.taskSecurityGroup,
    logGroup: shared.logGroup,
    databaseHost: 'preview.example.internal',
    databasePort: '5432',
    databaseSecret: shared.databaseSecret,
    previewDomain: 'preview.example.com',
    envName: shared.envName,
    ...(options.previewCapacity ? { capacity: options.previewCapacity } : {}),
    env: ENV,
  });

  const stacks: cdk.Stack[] = [ecs, shared, preview];

  if (options.withInterruptionStack ?? true) {
    stacks.push(
      new SpotInterruptionStack(app, 'SpotInterruptionStack-Staging', {
        envName: 'staging',
        alarmTopic,
        monitoredClusterArns: [ecs.cluster.clusterArn, shared.cluster.clusterArn],
        workloads: [
          {
            serviceNamePattern: 'staging-service',
            workload: spotWorkloadById('staging-application'),
          },
          { serviceNamePattern: 'preview-pr-*', workload: spotWorkloadById('preview-pr-service') },
        ],
        starvationTarget: {
          clusterName: 'staging-cluster',
          serviceName: 'staging-service',
          onDemandBase: 1,
        },
        env: ENV,
      }),
    );
  }

  // Keyed on the construct id rather than `stackName`, because that is what
  // `cdk synth` names the artifact: `PreviewPrStack-1.template.json` holds a
  // stack whose `stackName` is `preview-pr-1`, and the catalogue's prefixes
  // match the artifact.
  return stacks.map((stack) => ({
    path: `${stack.node.id}.template.json`,
    document: Template.fromStack(stack).toJSON(),
  }));
};

const auditShipped = (
  overrides: Partial<Parameters<typeof auditSpotCapacity>[0]> = {},
  options: ShippedOptions = {},
) =>
  auditSpotCapacity({
    templates: shippedTemplates(options),
    spotDoc: SHIPPED_DOC,
    ciWorkflow: CI,
    workloads: only(SHIPPED_IDS),
    ...overrides,
  });

const rulesOf = (result: ReturnType<typeof auditSpotCapacity>): string[] =>
  result.violations.map((violation) => violation.rule);

/** Rewrite one resource's properties in a synthesised template. */
const mutate = (
  templates: TemplateFile[],
  file: string,
  type: string,
  change: (properties: Record<string, any>, logicalId: string) => void,
): TemplateFile[] =>
  templates.map((template) => {
    if (template.path !== file) return template;
    const document = JSON.parse(JSON.stringify(template.document));
    for (const [logicalId, resource] of Object.entries<any>(document.Resources)) {
      if (resource.Type === type) change(resource.Properties, logicalId);
    }
    return { ...template, document };
  });

describe('the stacks this repository actually ships', () => {
  it('passes the gate against the real catalogue entries for them', () => {
    const result = auditShipped();
    expect(result.violations).toEqual([]);
    // Staging's service, the preview service, and the two the blue/green and
    // canary stacks do not contribute here because they are not synthesised in
    // this app.
    expect(result.servicesRead).toBe(2);
    expect(result.rulesRead).toBe(1);
    expect(result.alarmsRead).toBe(1);
  });

  it('holds the shipped guide to the table the catalogue renders', () => {
    // Against the full catalogue rather than the subset: the document is a
    // statement about the whole repository.
    expect(rulesOf(auditShipped({ workloads: undefined }))).not.toContain('doc-table-drift');
  });

  it('reports the published table drifting from the data', () => {
    expect(rulesOf(auditShipped({ spotDoc: '# Spot\n\nNo table here.\n' }))).toContain(
      'doc-table-drift',
    );
  });

  it('reports itself not being wired into CI', () => {
    expect(rulesOf(auditShipped({ ciWorkflow: 'name: CI\n' }))).toContain('audit-not-run-in-ci');
    // Omitted rather than empty means "the caller is not asking", which is what
    // every other test here wants.
    expect(rulesOf(auditShipped({ ciWorkflow: undefined }))).not.toContain('audit-not-run-in-ci');
  });

  it('passes the catalogue findings through rather than deciding them twice', () => {
    const result = auditShipped({
      workloads: [{ ...spotWorkloadById('staging-application'), onDemandBase: 0 }],
    });
    expect(rulesOf(result)).toContain('catalogue');
    expect(result.violations.find((violation) => violation.rule === 'catalogue')?.location).toContain(
      'base-missing',
    );
  });
});

describe('the inventory', () => {
  it('reports a service no entry claims', () => {
    const result = auditShipped({ workloads: only(['staging-application']) });
    expect(rulesOf(result)).toContain('service-unclassified');
    expect(
      result.violations.find((violation) => violation.rule === 'service-unclassified')?.file,
    ).toBe('PreviewPrStack-1.template.json');
  });

  it('reports a service two entries both claim', () => {
    const duplicate: SpotWorkload = {
      ...spotWorkloadById('staging-application'),
      id: 'staging-application-copy',
    };
    const result = auditShipped({ workloads: [...only(SHIPPED_IDS), duplicate] });
    expect(rulesOf(result)).toContain('service-ambiguous');
  });

  it('reports a count that has drifted from what the entry declares', () => {
    const result = auditShipped({
      workloads: [
        { ...spotWorkloadById('staging-application'), expectedResources: 2 },
        spotWorkloadById('preview-pr-service'),
      ],
    });
    expect(rulesOf(result)).toContain('service-count-drift');
  });
});

describe('the posture, in both directions', () => {
  it('reports a strategy that has reverted to on-demand', () => {
    // Which is more expensive and perfectly healthy, so nothing else reports
    // it.
    const result = auditShipped({}, { ecsCapacity: undefined });
    expect(rulesOf(result)).toContain('posture-mismatch');
    expect(
      result.violations.find((violation) => violation.rule === 'posture-mismatch')?.message,
    ).toContain('LaunchType: FARGATE');
  });

  it('reports Spot capacity under a service the catalogue says must not have it', () => {
    const onDemand: SpotWorkload = {
      ...spotWorkloadById('production-application'),
      id: 'staging-application',
      stackPrefixes: ['EcsStack-Staging'],
    };
    const result = auditShipped({
      workloads: [onDemand, spotWorkloadById('preview-pr-service')],
    });
    const violation = result.violations.find((v) => v.rule === 'posture-mismatch');
    expect(violation).toBeDefined();
    // The message carries the entry's own recorded reason, because that is the
    // thing the reader needs and it is three files away.
    expect(violation?.message).toContain('error budget');
  });
});

describe('whether the strategy can deploy at all', () => {
  it('reports FARGATE_SPOT on a cluster that never associated it', () => {
    const result = auditShipped({}, { previewSpotProvider: false });
    expect(rulesOf(result)).toContain('capacity-provider-unassociated');
  });

  it('resolves the cluster across stacks, which is the only case that matters', () => {
    // The preview cluster is in PreviewEnvironmentStack and the preview service
    // in PreviewPrStack-1, joined by an Fn::ImportValue. A gate that could not
    // follow that would skip its one real subject and stay green.
    const templates = shippedTemplates();
    const exportIndex = buildExportIndex(templates);
    const services = readServices(templates, exportIndex);
    const preview = services.find((service) => service.stackName === 'PreviewPrStack-1');
    expect(preview?.capacityProviders).toEqual([SPOT_CAPACITY_PROVIDER]);
    expect(preview?.cluster?.file).toBe('PreviewEnvironmentStack.template.json');
    expect(preview?.clusterUnresolved).toBe(false);
  });

  it('reports a cluster it cannot follow rather than skipping the service', () => {
    const templates = mutate(
      shippedTemplates(),
      'PreviewPrStack-1.template.json',
      'AWS::ECS::Service',
      (properties) => {
        properties.Cluster = 'arn:aws:ecs:us-east-1:123456789012:cluster/typed-by-hand';
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({
        templates,
        spotDoc: SHIPPED_DOC,
        workloads: only(SHIPPED_IDS),
      }),
    );
    expect(rules).toContain('cluster-unresolvable');
  });
});

describe('the drain budget as deployed', () => {
  it('reports a Spot container with no StopTimeout', () => {
    const templates = mutate(
      shippedTemplates(),
      'EcsStack-Staging.template.json',
      'AWS::ECS::TaskDefinition',
      (properties) => {
        for (const container of properties.ContainerDefinitions) delete container.StopTimeout;
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    expect(rules).toContain('stop-timeout-unset');
  });

  it('reports a StopTimeout that is not the declared one', () => {
    const templates = mutate(
      shippedTemplates(),
      'EcsStack-Staging.template.json',
      'AWS::ECS::TaskDefinition',
      (properties) => {
        for (const container of properties.ContainerDefinitions) container.StopTimeout = 45;
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    expect(rules).toContain('stop-timeout-mismatch');
  });

  it('reports a target group with no deregistration delay, and says what ELB uses', () => {
    const templates = mutate(
      shippedTemplates(),
      'EcsStack-Staging.template.json',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      (properties) => {
        properties.TargetGroupAttributes = (properties.TargetGroupAttributes ?? []).filter(
          (attribute: any) => attribute.Key !== DEREGISTRATION_DELAY_ATTRIBUTE,
        );
      },
    );
    const result = auditSpotCapacity({
      templates,
      spotDoc: SHIPPED_DOC,
      workloads: only(SHIPPED_IDS),
    });
    expect(rulesOf(result)).toContain('deregistration-delay-unset');
    // And the consequence, since 300 against 120 is the whole point.
    expect(rulesOf(result)).toContain('drain-budget-exceeds-warning');
    expect(
      result.violations.find((violation) => violation.rule === 'deregistration-delay-unset')
        ?.message,
    ).toContain(String(ELB_DEFAULT_DEREGISTRATION_DELAY));
  });

  it('reports a delay that is not the declared one', () => {
    const templates = mutate(
      shippedTemplates(),
      'EcsStack-Staging.template.json',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      (properties) => {
        properties.TargetGroupAttributes = [
          { Key: DEREGISTRATION_DELAY_ATTRIBUTE, Value: '45' },
        ];
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    expect(rules).toContain('deregistration-delay-mismatch');
  });

  it('adds the two deployed intervals rather than taking the larger', () => {
    // 90 + 60 is over; 60 alone would not be. Taking the maximum would pass a
    // budget that ends in SIGKILL.
    const templates = mutate(
      mutate(
        shippedTemplates(),
        'EcsStack-Staging.template.json',
        'AWS::ElasticLoadBalancingV2::TargetGroup',
        (properties) => {
          properties.TargetGroupAttributes = [
            { Key: DEREGISTRATION_DELAY_ATTRIBUTE, Value: '90' },
          ];
        },
      ),
      'EcsStack-Staging.template.json',
      'AWS::ECS::TaskDefinition',
      (properties) => {
        for (const container of properties.ContainerDefinitions) container.StopTimeout = 60;
      },
    );
    const result = auditSpotCapacity({
      templates,
      spotDoc: SHIPPED_DOC,
      workloads: only(SHIPPED_IDS),
    });
    const violation = result.violations.find(
      (candidate) => candidate.rule === 'drain-budget-exceeds-warning',
    );
    expect(violation?.message).toContain('150s');
    expect(violation?.message).toContain(`${FARGATE_SPOT_WARNING_SECONDS}s warning`);
  });
});

describe('whether anything is watching', () => {
  it('reports a Spot cluster no rule covers', () => {
    const rules = rulesOf(auditShipped({}, { withInterruptionStack: false }));
    expect(rules).toContain('interruption-rule-missing');
    // Both services, since both clusters lose their watcher.
    expect(rules.filter((rule) => rule === 'interruption-rule-missing')).toHaveLength(2);
  });

  it('reports a task-state rule with no stopCode filter as not covering anything', () => {
    // A rule without it matches a scale-in, a deployment replacing tasks and
    // every UserInitiated stop, so the interruption metric becomes a deployment
    // counter with an alarming name.
    const templates = mutate(
      shippedTemplates(),
      'SpotInterruptionStack-Staging.template.json',
      'AWS::Events::Rule',
      (properties) => {
        delete properties.EventPattern.detail.stopCode;
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    // Both: the cluster has no watcher any more, and the rule that used to be
    // one is now a rule nobody should keep.
    expect(rules).toContain('interruption-rule-stop-code');
    expect(rules).toContain('interruption-rule-missing');
  });

  it('reports a rule whose undeliverable events are dropped', () => {
    const templates = mutate(
      shippedTemplates(),
      'SpotInterruptionStack-Staging.template.json',
      'AWS::Events::Rule',
      (properties) => {
        for (const target of properties.Targets) delete target.DeadLetterConfig;
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    expect(rules).toContain('interruption-rule-no-dlq');
  });

  it('accepts a rule with no cluster filter as covering everything', () => {
    const templates = mutate(
      shippedTemplates(),
      'SpotInterruptionStack-Staging.template.json',
      'AWS::Events::Rule',
      (properties) => {
        delete properties.EventPattern.detail.clusterArn;
      },
    );
    const rules = readInterruptionRules(templates, buildExportIndex(templates));
    expect(rules[0].allClusters).toBe(true);
    expect(
      rulesOf(auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) })),
    ).not.toContain('interruption-rule-missing');
  });
});

describe('whether the quiet failure is loud', () => {
  it('reports a spot-with-base service with nothing comparing running to desired', () => {
    const templates = mutate(
      shippedTemplates(),
      'SpotInterruptionStack-Staging.template.json',
      'AWS::CloudWatch::Alarm',
      (properties) => {
        if (!properties.Metrics) return;
        for (const metric of properties.Metrics) {
          if (metric.MetricStat?.Metric?.MetricName === RUNNING_TASK_COUNT_METRIC) {
            metric.MetricStat.Metric.MetricName = 'CpuUtilized';
          }
        }
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    expect(rules).toContain('starvation-alarm-missing');
  });

  it('asks nothing of the previews, whose absence reaches somebody anyway', () => {
    // A preview that cannot be placed is visible in the pull request waiting
    // for it, so there is deliberately no starvation alarm for it — and the
    // gate must not invent a requirement the strategy does not make.
    const result = auditShipped({ workloads: only(['preview-pr-service']) });
    expect(rulesOf(result)).not.toContain('starvation-alarm-missing');
  });

  it('reports that alarm ignoring missing data', () => {
    const templates = mutate(
      shippedTemplates(),
      'SpotInterruptionStack-Staging.template.json',
      'AWS::CloudWatch::Alarm',
      (properties) => {
        if (properties.TreatMissingData === BREACHING) {
          properties.TreatMissingData = 'notBreaching';
        }
      },
    );
    const result = auditSpotCapacity({
      templates,
      spotDoc: SHIPPED_DOC,
      workloads: only(SHIPPED_IDS),
    });
    expect(rulesOf(result)).toContain('starvation-alarm-not-breaching');
    expect(
      result.violations.find((violation) => violation.rule === 'starvation-alarm-not-breaching')
        ?.message,
    ).toContain('green through the outage');
  });

  it('reports its metric math leaving a term unfilled', () => {
    const templates = mutate(
      shippedTemplates(),
      'SpotInterruptionStack-Staging.template.json',
      'AWS::CloudWatch::Alarm',
      (properties) => {
        for (const metric of properties.Metrics ?? []) {
          if (metric.Expression) metric.Expression = 'running - desired';
        }
      },
    );
    const rules = rulesOf(
      auditSpotCapacity({ templates, spotDoc: SHIPPED_DOC, workloads: only(SHIPPED_IDS) }),
    );
    expect(rules).toContain('starvation-alarm-terms-unfilled');
  });
});

describe('the template readers', () => {
  it('follows a Ref, a GetAtt export and an ImportValue, and gives up on a literal', () => {
    const templates = shippedTemplates();
    const exportIndex = buildExportIndex(templates);
    expect(resolveReference({ Ref: 'Thing' }, 'A.template.json', exportIndex)).toEqual({
      file: 'A.template.json',
      logicalId: 'Thing',
    });
    expect(resolveReference('literal', 'A.template.json', exportIndex)).toBeUndefined();
    expect(
      resolveReference({ 'Fn::ImportValue': 'nothing-exports-this' }, 'A.template.json', exportIndex),
    ).toBeUndefined();
  });

  it('reads StopTimeout per container, including its absence', () => {
    expect(
      stopTimeouts({
        Properties: {
          ContainerDefinitions: [
            { Name: 'app', StopTimeout: 60 },
            { Name: 'sidecar' },
          ],
        },
      }),
    ).toEqual(
      new Map([
        ['app', 60],
        ['sidecar', undefined],
      ]),
    );
    expect(stopTimeouts(undefined).size).toBe(0);
  });

  it('reads the deregistration delay, and distinguishes absent from unparseable', () => {
    expect(
      deregistrationDelay({
        Properties: {
          TargetGroupAttributes: [{ Key: DEREGISTRATION_DELAY_ATTRIBUTE, Value: '30' }],
        },
      }),
    ).toBe(30);
    expect(deregistrationDelay({ Properties: { TargetGroupAttributes: [] } })).toBeUndefined();
    expect(
      deregistrationDelay({
        Properties: {
          TargetGroupAttributes: [{ Key: DEREGISTRATION_DELAY_ATTRIBUTE, Value: 'soon' }],
        },
      }),
    ).toBeUndefined();
  });

  it('finds the starvation alarm by what it is made of rather than by its name', () => {
    // An alarm renamed is still the alarm, and a gate keyed to the name would
    // be satisfied by an empty alarm that happened to be called the right
    // thing.
    const alarms = readStarvationAlarms(shippedTemplates());
    expect(alarms).toHaveLength(1);
    expect([...alarms[0].metricNames].sort()).toEqual([
      DESIRED_TASK_COUNT_METRIC,
      RUNNING_TASK_COUNT_METRIC,
    ]);
    expect(alarms[0].serviceNames).toContain('staging-service');
    expect(alarms[0].treatMissingData).toBe(BREACHING);
  });

  it('reads the rule that matches a reclaim', () => {
    const templates = shippedTemplates();
    const rules = readInterruptionRules(templates, buildExportIndex(templates));
    expect(rules).toHaveLength(1);
    expect(rules[0].stopCodes).toEqual([SPOT_INTERRUPTION_STOP_CODE]);
    expect(rules[0].clusters.filter(Boolean)).toHaveLength(2);
    expect(rules[0].targetsWithoutDlq).toBe(0);
  });

  it('restates the constants it checks, so a rename in lib/ is a failing test', () => {
    expect(CONTAINER_INSIGHTS_NAMESPACE).toBe('ECS/ContainerInsights');
    expect(RUNNING_TASK_COUNT_METRIC).toBe('RunningTaskCount');
    expect(DESIRED_TASK_COUNT_METRIC).toBe('DesiredTaskCount');
    expect(ELB_DEFAULT_DEREGISTRATION_DELAY).toBe(300);
    expect(DEREGISTRATION_DELAY_ATTRIBUTE).toBe('deregistration_delay.timeout_seconds');
    expect(BREACHING).toBe('breaching');
    expect(AUDIT_SCRIPT).toBe('audit:spot');
  });
});
