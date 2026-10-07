import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { ChaosFisStack } from '../lib/chaos-fis-stack';
import {
  ALB_5XX_STOP_CONDITION,
  CHAOS_EXPERIMENTS,
  PROBE_CONNECT_STOP_CONDITION,
} from '../lib/fis-experiments';
import {
  AUDIT_SCRIPT,
  type TemplateFile,
  anchorForHeading,
  anchorsIn,
  auditFisExperiments,
} from '../tools/audit-fis-experiments';

/**
 * Tests for the chaos gate.
 *
 * The load-bearing one is `the stacks this repository actually ships`: the whole
 * synthesised output goes through the audit, so a rule that stops matching what
 * `ChaosFisStack` produces fails here rather than passing everything in CI. The
 * rest are the near misses — each one a single property removed from an
 * otherwise correct template, because each of those deploys cleanly and fails
 * only when somebody starts the experiment.
 */

const VPC_CONTEXT = {
  'availability-zones:account=123456789012:region=us-east-1': ['us-east-1a', 'us-east-1b'],
};
const ENV = { account: '123456789012', region: 'us-east-1' };

/** The headings the catalogue's anchors resolve against. */
const DOC = [
  '## 2. A task disappears',
  '## 3. The network gets slow rather than broken',
  '## 4. An Availability Zone is cut off',
].join('\n\n');

const CI = `      - name: Audit the chaos experiments\n        run: npm run ${AUDIT_SCRIPT}\n`;

/**
 * The templates a real deployment produces: the chaos stack, the VPC it
 * partitions, the alarms it stops on, and the ECS task definition the latency
 * fault reaches into.
 */
const shippedTemplates = (options: {
  natGateways?: number;
  /** `null` omits it, which is the near miss; omitting the option keeps the real value. */
  pidMode?: ecs.PidMode | null;
  enableFaultInjection?: boolean;
  probePeriodSeconds?: number;
} = {}): TemplateFile[] => {
  const app = new cdk.App({ context: VPC_CONTEXT });

  const vpcStack = new cdk.Stack(app, 'VpcStack-Staging', { env: ENV });
  const vpc = new ec2.Vpc(vpcStack, 'Vpc', {
    maxAzs: 2,
    natGateways: options.natGateways ?? 2,
  });

  const ecsStack = new cdk.Stack(app, 'EcsStack-Staging', { env: ENV });
  const taskDefinition = new ecs.FargateTaskDefinition(ecsStack, 'TaskDefinition', {
    enableFaultInjection: options.enableFaultInjection ?? true,
    ...(options.pidMode === null ? {} : { pidMode: options.pidMode ?? ecs.PidMode.TASK }),
    runtimePlatform: {
      operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      cpuArchitecture: ecs.CpuArchitecture.X86_64,
    },
  });
  taskDefinition.addContainer('App', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:stable'),
  });

  const alarmStack = new cdk.Stack(app, 'CloudWatchAlarmsStack-Staging', { env: ENV });
  const alarmFor = (name: string, periodSeconds: number, evaluationPeriods: number) =>
    new cloudwatch.Alarm(alarmStack, name, {
      alarmName: `staging-${name}`,
      metric: new cloudwatch.Metric({
        namespace: 'Test',
        metricName: name,
        period: cdk.Duration.seconds(periodSeconds),
      }),
      threshold: 1,
      evaluationPeriods,
    });

  const chaosStack = new ChaosFisStack(app, 'ChaosFisStack-Staging', {
    envName: 'staging',
    vpc,
    service: { clusterName: 'staging-cluster', serviceName: 'staging-service' },
    stopConditionAlarms: {
      [PROBE_CONNECT_STOP_CONDITION.alarmName]: alarmFor(
        'db-connect-failing',
        options.probePeriodSeconds ?? PROBE_CONNECT_STOP_CONDITION.periodSeconds,
        PROBE_CONNECT_STOP_CONDITION.evaluationPeriods,
      ),
      [ALB_5XX_STOP_CONDITION.alarmName]: alarmFor(
        'alb-5xx-elb',
        ALB_5XX_STOP_CONDITION.periodSeconds,
        ALB_5XX_STOP_CONDITION.evaluationPeriods,
      ),
    },
    env: ENV,
  });

  return [
    { path: 'VpcStack-Staging.template.json', document: Template.fromStack(vpcStack).toJSON() },
    { path: 'EcsStack-Staging.template.json', document: Template.fromStack(ecsStack).toJSON() },
    {
      path: 'CloudWatchAlarmsStack-Staging.template.json',
      document: Template.fromStack(alarmStack).toJSON(),
    },
    {
      path: 'ChaosFisStack-Staging.template.json',
      document: Template.fromStack(chaosStack).toJSON(),
    },
  ];
};

const audit = (templates: TemplateFile[], chaosDoc = DOC, ciWorkflow: string | undefined = CI) =>
  auditFisExperiments({ templates, chaosDoc, ciWorkflow });

const rules = (templates: TemplateFile[], ...rest: [string?, string?]) =>
  audit(templates, ...(rest as [string, string])).violations.map((v) => v.rule);

/** Mutate the chaos stack's template in place and return the set. */
const withChaosTemplate = (
  templates: TemplateFile[],
  mutate: (resources: Record<string, any>) => void,
): TemplateFile[] =>
  templates.map((file) => {
    if (file.path !== 'ChaosFisStack-Staging.template.json') return file;
    const document = JSON.parse(JSON.stringify(file.document));
    mutate(document.Resources);
    return { path: file.path, document };
  });

const fisResources = (resources: Record<string, any>): Record<string, any>[] =>
  Object.values(resources).filter(
    (resource: any) => resource.Type === 'AWS::FIS::ExperimentTemplate',
  );

const fisResourceFor = (resources: Record<string, any>, experimentId: string): any => {
  const found = fisResources(resources).find(
    (resource: any) => resource.Properties?.Tags?.Experiment === experimentId,
  );
  if (found === undefined) throw new Error(`no template for ${experimentId}`);
  return found;
};

describe('the stacks this repository actually ships', () => {
  it('passes the gate', () => {
    const result = audit(shippedTemplates());
    expect(result.violations).toEqual([]);
    expect(result.templatesRead).toBe(CHAOS_EXPERIMENTS.length);
    expect(result.environmentsRead).toEqual(['staging']);
  });

  it('reads something, so a green result is not an empty one', () => {
    expect(audit(shippedTemplates()).templatesRead).toBeGreaterThan(0);
  });
});

describe('guardrail rules', () => {
  it("reports a stop condition that is FIS's none", () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      fisResourceFor(resources, 'ecs-task-loss').Properties.StopConditions = [{ Source: 'none' }];
    });
    expect(rules(templates)).toContain('stop-condition-none');
  });

  it('reports a template with no stop conditions at all', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      fisResourceFor(resources, 'ecs-task-loss').Properties.StopConditions = [];
    });
    expect(rules(templates)).toContain('stop-condition-none');
  });

  it('reports a stop condition whose source is neither an alarm nor none', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      fisResourceFor(resources, 'ecs-task-loss').Properties.StopConditions = [
        { Source: 'aws:cloudwatch:composite-alarm', Value: 'arn:aws:cloudwatch:::alarm/x' },
      ];
    });
    expect(rules(templates)).toContain('stop-condition-not-an-alarm');
  });

  it('reports a guardrail no stack creates', () => {
    const templates = shippedTemplates().filter(
      (file) => file.path !== 'CloudWatchAlarmsStack-Staging.template.json',
    );
    expect(rules(templates)).toContain('stop-condition-alarm-missing');
  });

  it("reports an alarm whose real detection window is not the one the duration was sized against", () => {
    // `periodMinutes` is a prop with a default in the stack that owns the alarm,
    // so widening it is a change with no diff in the catalogue at all.
    const templates = shippedTemplates({ probePeriodSeconds: 300 });
    expect(rules(templates)).toContain('stop-condition-window-drift');
  });
});

describe('record and wiring rules', () => {
  it('reports a template that records nothing about which targets resolved', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      delete fisResourceFor(resources, 'ecs-task-loss').Properties.LogConfiguration;
    });
    expect(rules(templates)).toContain('experiment-without-logs');
  });

  it('reports a logging block FIS will not accept', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      fisResourceFor(resources, 'ecs-task-loss').Properties.LogConfiguration.LogSchemaVersion = 1;
    });
    expect(rules(templates)).toContain('log-schema-version-wrong');
  });

  it('reports an action pointing at its target under a key that action does not define', () => {
    // The shape of a template copied from an EC2 example into an ECS action.
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      const action = fisResourceFor(resources, 'ecs-task-loss').Properties.Actions.instance;
      action.Targets = { Instances: 'Tasks-Target-1' };
    });
    expect(rules(templates)).toContain('action-target-key-wrong');
  });

  it('reports a selection mode the blast-radius rules never passed', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      fisResourceFor(resources, 'ecs-task-loss').Properties.Targets['Tasks-Target-1'].SelectionMode =
        'ALL';
    });
    expect(rules(templates)).toContain('target-selection-widened');
  });

  it('reports a catalogue entry no stack synthesised', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      for (const [logicalId, resource] of Object.entries(resources)) {
        if ((resource as any).Properties?.Tags?.Experiment === 'ecs-task-loss') {
          delete resources[logicalId];
        }
      }
    });
    expect(rules(templates)).toContain('experiment-template-missing');
  });

  it('reports a template pointing at a doc section that is not there', () => {
    expect(rules(shippedTemplates(), '## 2. A task disappears')).toContain(
      'experiment-anchor-missing',
    );
  });

  it('reports a gate no job runs', () => {
    expect(rules(shippedTemplates(), DOC, 'jobs:\n  cdk:\n    steps: []\n')).toContain(
      'audit-not-run-in-ci',
    );
  });
});

describe('the cross-stack rules, which are the reason this gate exists', () => {
  it('reports PidMode missing from the task definition the latency fault enters', () => {
    // A one-line diff to EcsStack that looks like tidying up. The service stays
    // healthy and the experiment template still synthesises.
    const templates = shippedTemplates({ pidMode: null });
    expect(rules(templates)).toContain('task-definition-pid-mode');
  });

  it('reports EnableFaultInjection missing from it', () => {
    const templates = shippedTemplates({ enableFaultInjection: false });
    expect(rules(templates)).toContain('task-definition-fault-injection');
  });

  it('reports the latency action missing useEcsFaultInjectionEndpoints', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      const action = fisResourceFor(resources, 'ecs-task-network-latency').Properties.Actions
        .latency;
      delete action.Parameters.useEcsFaultInjectionEndpoints;
    });
    expect(rules(templates)).toContain('latency-endpoints-unset');
  });

  it('reports an AZ experiment over a VPC with one NAT gateway', () => {
    // Not an AZ fault: every private subnet egresses through whichever AZ holds
    // the gateway, so partitioning that AZ is a total loss of outbound
    // connectivity including from the AZ that was supposed to survive.
    const templates = shippedTemplates({ natGateways: 1 });
    expect(rules(templates)).toContain('single-nat-gateway');
  });

  it('reports an AZ target that spans Availability Zones', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      const target = fisResourceFor(resources, 'availability-zone-partition').Properties.Targets[
        'Subnets-Target-1'
      ];
      target.ResourceArns = [...target.ResourceArns, 'arn:aws:ec2:us-east-1:1:subnet/extra'];
    });
    expect(rules(templates)).toContain('az-target-spans-azs');
  });

  it('reports an AZ target that leaves a subnet group in the AZ connected', () => {
    const templates = withChaosTemplate(shippedTemplates(), (resources) => {
      const target = fisResourceFor(resources, 'availability-zone-partition').Properties.Targets[
        'Subnets-Target-1'
      ];
      target.ResourceArns = target.ResourceArns.slice(0, 1);
    });
    expect(rules(templates)).toContain('az-target-partial-az');
  });
});

describe('anchors', () => {
  it.each([
    ['## 2. A task disappears', '#2-a-task-disappears'],
    ['## 3. The network gets slow rather than broken', '#3-the-network-gets-slow-rather-than-broken'],
    ['## 4. An Availability Zone is cut off', '#4-an-availability-zone-is-cut-off'],
    ['### 6.1 `none` is the default', '#61-none-is-the-default'],
  ])('builds %s into %s', (heading, anchor) => {
    expect(anchorForHeading(heading)).toBe(anchor);
  });

  it('reads anchors from headings only, not from prose that happens to contain one', () => {
    const markdown = '# Title\n\nSee #2-a-task-disappears for details.\n';
    expect(anchorsIn(markdown).has('#2-a-task-disappears')).toBe(false);
    expect(anchorsIn(markdown).has('#title')).toBe(true);
  });

  it('matches every anchor the shipped catalogue declares against the shipped doc', () => {
    // The real file, not the fixture: this is what keeps the catalogue's anchors
    // and docs/chaos-engineering.md from drifting apart.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const doc = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'docs', 'chaos-engineering.md'),
      'utf8',
    );
    const anchors = anchorsIn(doc);
    for (const experiment of CHAOS_EXPERIMENTS) {
      expect(anchors.has(experiment.anchor)).toBe(true);
    }
  });
});
