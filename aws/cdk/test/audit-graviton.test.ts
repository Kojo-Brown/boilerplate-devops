import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { ElastiCacheStack } from '../lib/elasticache-stack';
import { OtelCollectorStack } from '../lib/otel-collector-stack';
import { RdsStack } from '../lib/rds-stack';
import { VpcStack } from '../lib/vpc-stack';
import { ADOT_COLLECTOR_IMAGE, PINNED_IMAGES } from '../lib/base-images';
import { COMPUTE_WORKLOADS, type Workload } from '../lib/graviton-migration';
import {
  AUDIT_SCRIPT,
  BLOCKER_SECTIONS,
  GRAVITON_AUDIT_RULES,
  LAYER_PACKAGES,
  type TemplateFile,
  auditGraviton,
  elfMachine,
  measureLayerArchitectures,
  platformsBuiltBy,
  readComputeResources,
  readZipEntryHead,
} from '../tools/audit-graviton';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Tests for the architecture gate.
 *
 * The load-bearing ones are the two that use real inputs: the stacks this
 * repository ships go through the audit against the real catalogue entries for
 * them, and the layer zips in `node_modules` are read with the real zip and ELF
 * readers. Those are what fail if the gate stops matching what the repository
 * produces, instead of passing everything in CI.
 *
 * The rest are the near misses: one property removed from an otherwise correct
 * template, because every one of those deploys cleanly and fails at task
 * placement, at a custom resource, or at a node group that never joins.
 */

const ENV = { account: '123456789012', region: 'us-east-1' };
const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const CDK_ROOT = path.join(__dirname, '..');

/** The guide, and the build pipeline, as the repository actually ships them. */
const SHIPPED_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'graviton.md'), 'utf8');
const SHIPPED_BUILD_WORKFLOW = fs.readFileSync(
  path.join(REPO_ROOT, 'workflow-templates', 'docker-build-push.yml'),
  'utf8',
);
const CI = `      - name: Audit processor architectures\n        run: npm run ${AUDIT_SCRIPT}\n`;

const only = (ids: readonly string[]): readonly Workload[] =>
  COMPUTE_WORKLOADS.filter((workload) => ids.includes(workload.id));

/**
 * The three stacks whose architecture this change actually moved, synthesised
 * twice each where the catalogue expects two copies.
 */
const shippedTemplates = (): TemplateFile[] => {
  const templates: TemplateFile[] = [];
  for (const envName of ['Staging', 'Production']) {
    // `cdk synth` records the construct path of every resource and
    // `Template.fromStack` does not, so the audit's matcher — which is a suffix
    // of that path — would have nothing to match in a test without this.
    const app = new cdk.App({ context: { 'aws:cdk:enable-path-metadata': true } });
    const vpcStack = new VpcStack(app, `VpcStack-${envName}`, {
      envName: envName.toLowerCase(),
      maxAzs: 2,
      natGateways: 1,
      env: ENV,
    });
    const clientSg = new ec2.SecurityGroup(vpcStack, 'ClientSecurityGroup', {
      vpc: vpcStack.vpc,
      description: 'Stands in for EcsStack.taskSecurityGroup',
    });
    const rds = new RdsStack(app, `RdsStack-${envName}`, {
      vpc: vpcStack.vpc,
      envName: envName.toLowerCase(),
      env: ENV,
    });
    const cache = new ElastiCacheStack(app, `ElastiCacheStack-${envName}`, {
      vpc: vpcStack.vpc,
      envName: envName.toLowerCase(),
      env: ENV,
    });
    const otel = new OtelCollectorStack(app, `OtelCollectorStack-${envName}`, {
      vpc: vpcStack.vpc,
      envName: envName.toLowerCase(),
      clientSecurityGroups: [clientSg],
      env: ENV,
    });
    for (const stack of [rds, cache, otel]) {
      templates.push({
        path: `${stack.stackName}.template.json`,
        document: Template.fromStack(stack).toJSON(),
      });
    }
  }
  return templates;
};

const SHIPPED_IDS = [
  'rds-postgres-instance',
  'elasticache-redis-nodes',
  'otel-sampler-task',
  // RdsStack asks CDK for a log group with a retention period, which creates a
  // log-retention function per stack. It is in the catalogue for the same reason
  // every other framework function is: it exists, and nothing here names it.
  'cdk-log-retention',
];

const auditShipped = (overrides: Partial<Parameters<typeof auditGraviton>[0]> = {}) =>
  auditGraviton({
    templates: shippedTemplates(),
    gravitonDoc: SHIPPED_DOC,
    buildWorkflow: SHIPPED_BUILD_WORKFLOW,
    ciWorkflow: CI,
    workloads: only(SHIPPED_IDS),
    ...overrides,
  });

describe('the stacks this repository actually ships', () => {
  it('passes the audit against the catalogue entries for them', () => {
    const result = auditShipped();
    expect(result.violations).toEqual([]);
    // Two RDS instances, two replication groups, two task definitions — and two
    // log-retention functions nobody asked for, which is the smallest version of
    // the finding in §7 of the guide.
    expect(result.resourcesRead).toBe(8);
  });

  it('reads Graviton out of the templates rather than out of the catalogue', () => {
    const resources = readComputeResources(shippedTemplates());
    const byKind = (kind: string) => resources.filter((resource) => resource.kind === kind);
    expect(byKind('rds-instance').map((resource) => resource.declared)).toEqual(['arm64', 'arm64']);
    expect(byKind('elasticache-node').map((resource) => resource.declared)).toEqual([
      'arm64',
      'arm64',
    ]);
    expect(byKind('fargate-task-definition').map((resource) => resource.declared)).toEqual([
      'arm64',
      'arm64',
    ]);
  });

  it('fails when the collector task definition goes back to the ECS default', () => {
    // The near miss this rule exists for: deleting `runtimePlatform` leaves no
    // trace in the diff of what it changed, and ECS reads its absence as x86.
    const templates = shippedTemplates().map((template) => {
      const document = JSON.parse(JSON.stringify(template.document));
      for (const resource of Object.values(document.Resources) as any[]) {
        if (resource.Type === 'AWS::ECS::TaskDefinition') delete resource.Properties.RuntimePlatform;
      }
      return { ...template, document };
    });
    const { violations } = auditShipped({ templates });
    expect(violations.map((violation) => violation.rule)).toContain('architecture-undeclared');
  });

  it('fails when the database class goes back to x86 under an unchanged catalogue', () => {
    const templates = shippedTemplates().map((template) => {
      const document = JSON.parse(JSON.stringify(template.document));
      for (const resource of Object.values(document.Resources) as any[]) {
        if (resource.Type === 'AWS::RDS::DBInstance') {
          resource.Properties.DBInstanceClass = 'db.t3.medium';
        }
      }
      return { ...template, document };
    });
    const { violations } = auditShipped({ templates });
    const mismatches = violations.filter((violation) => violation.rule === 'architecture-mismatch');
    expect(mismatches).toHaveLength(2);
    expect(mismatches[0].message).toContain('db.t3.medium');
  });

  it('fails when an ARM64 task definition is pointed at an unmeasured image', () => {
    // The failure no template can show: this deploys, and the task never starts.
    const templates = shippedTemplates().map((template) => {
      const document = JSON.parse(JSON.stringify(template.document));
      for (const resource of Object.values(document.Resources) as any[]) {
        if (resource.Type !== 'AWS::ECS::TaskDefinition') continue;
        for (const container of resource.Properties.ContainerDefinitions) {
          container.Image = 'public.ecr.aws/example/collector:amd64-only';
        }
      }
      return { ...template, document };
    });
    const { violations } = auditShipped({ templates });
    expect(violations.map((violation) => violation.rule)).toContain('image-platform-missing-arm');
  });

  it('reads the collector image as the pin it is, so the measurement applies', () => {
    const resources = readComputeResources(shippedTemplates());
    const images = resources.flatMap((resource) => resource.images);
    expect(images).toContain(ADOT_COLLECTOR_IMAGE.reference);
  });

  it('fails when a copy is added without being classified', () => {
    const extra = shippedTemplates();
    const rds = extra.find((template) => template.path.startsWith('RdsStack'))!;
    extra.push({ ...rds, path: 'RdsStack-Sandbox.template.json' });
    const rules = auditShipped({ templates: extra }).violations.map((violation) => violation.rule);
    expect(rules).toContain('workload-count-drift');
  });
});

describe('classification', () => {
  const lambdaTemplate = (overrides: Record<string, unknown> = {}): TemplateFile => ({
    path: 'ExampleStack-Staging.template.json',
    document: {
      Resources: {
        Function: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs22.x', Architectures: ['arm64'], ...overrides },
          Metadata: { 'aws:cdk:path': 'ExampleStack-Staging/Example/Resource' },
        },
      },
    },
  });

  const EXAMPLE: Workload = {
    id: 'example',
    kind: 'lambda',
    owner: 'repository',
    constructPathSuffix: 'Example/Resource',
    architecture: 'arm64',
    verdict: 'migrated',
    image: 'none',
    mechanics: 'redeploy',
    priceIds: ['lambda-gb-second'],
    expectedResources: 1,
  };

  const audit = (templates: TemplateFile[], workloads: readonly Workload[]) =>
    auditGraviton({
      templates,
      gravitonDoc: SHIPPED_DOC,
      buildWorkflow: SHIPPED_BUILD_WORKFLOW,
      workloads,
    }).violations.map((violation) => violation.rule);

  it('passes a classified, declared, matching resource', () => {
    expect(audit([lambdaTemplate()], [EXAMPLE])).toEqual([]);
  });

  it('folds a catalogue finding into its own report rather than trusting the data', () => {
    // The gate reads the catalogue, so a catalogue that contradicts itself has
    // to fail here too and not only in the unit test next door — CI runs this
    // one against the real data.
    const rules = audit([lambdaTemplate()], [{ ...EXAMPLE, blocker: 'framework-chooses' }]);
    expect(rules).toContain('catalogue');
  });

  it('reports a resource no entry matches', () => {
    expect(audit([lambdaTemplate()], [{ ...EXAMPLE, constructPathSuffix: 'Other/Resource' }])).toContain(
      'workload-unclassified',
    );
  });

  it('reports a resource two entries both claim', () => {
    const rules = audit([lambdaTemplate()], [EXAMPLE, { ...EXAMPLE, id: 'example-again' }]);
    expect(rules).toContain('workload-ambiguous');
  });

  it('separates two entries with the same construct id by stack', () => {
    // The real case: five task definitions in five stacks all live at
    // `TaskDefinition/Resource`, two of them ours and three the consumer's.
    const templates = [
      lambdaTemplate(),
      {
        path: 'OtherStack-Staging.template.json',
        document: {
          Resources: {
            Function: {
              Type: 'AWS::Lambda::Function',
              Properties: { Runtime: 'nodejs22.x' },
              Metadata: { 'aws:cdk:path': 'OtherStack-Staging/Example/Resource' },
            },
          },
        },
      },
    ];
    const rules = audit(templates, [
      { ...EXAMPLE, stackPrefixes: ['ExampleStack'] },
      {
        ...EXAMPLE,
        id: 'other',
        stackPrefixes: ['OtherStack'],
        owner: 'cdk',
        architecture: 'x86_64',
        verdict: 'unavailable',
        blocker: 'framework-chooses',
        mechanics: 'none',
        priceIds: [],
      },
    ]);
    expect(rules).toEqual([]);
  });

  it('treats an undeclared framework function as x86 rather than as a violation', () => {
    const rules = audit([lambdaTemplate({ Architectures: undefined })], [
      {
        ...EXAMPLE,
        owner: 'cdk',
        architecture: 'x86_64',
        verdict: 'unavailable',
        blocker: 'framework-chooses',
        mechanics: 'none',
        priceIds: [],
      },
    ]);
    expect(rules).toEqual([]);
  });

  it('reports an undeclared function of ours, where the default and a choice look the same', () => {
    expect(audit([lambdaTemplate({ Architectures: undefined })], [EXAMPLE])).toContain(
      'architecture-undeclared',
    );
  });
});

describe('node groups', () => {
  const nodegroup = (amiType: string, instanceTypes: string[]): TemplateFile => ({
    path: 'EksStack-Staging.template.json',
    document: {
      Resources: {
        Nodegroup: {
          Type: 'AWS::EKS::Nodegroup',
          Properties: { AmiType: amiType, InstanceTypes: instanceTypes },
          Metadata: { 'aws:cdk:path': 'EksStack-Staging/Group/Resource' },
        },
      },
    },
  });

  const GROUP: Workload = {
    id: 'group',
    kind: 'eks-nodegroup',
    owner: 'repository',
    constructPathSuffix: 'Group/Resource',
    architecture: 'x86_64',
    verdict: 'blocked',
    blocker: 'consumer-image-single-platform',
    image: 'consumer-supplied',
    mechanics: 'node-replacement',
    priceIds: ['ec2-m-large-hour-graviton3'],
    expectedResources: 1,
  };

  const audit = (template: TemplateFile, workload: Workload = GROUP) =>
    auditGraviton({
      templates: [template],
      gravitonDoc: SHIPPED_DOC,
      buildWorkflow: SHIPPED_BUILD_WORKFLOW,
      workloads: [workload],
    }).violations.map((violation) => violation.rule);

  it('passes an x86 AMI with x86 instance types', () => {
    expect(audit(nodegroup('AL2023_x86_64_STANDARD', ['m6i.large']))).toEqual([]);
  });

  it('reports an AMI type and instance types that disagree', () => {
    // CloudFormation accepts it. The nodes boot an AMI their processor cannot
    // execute, never join, and the stack waits for them until the node group
    // times out.
    expect(audit(nodegroup('AL2023_ARM_64_STANDARD', ['m6i.large']))).toContain(
      'nodegroup-architecture-split',
    );
  });

  it('reads a Graviton node group out of both halves when they agree', () => {
    const rules = audit(nodegroup('AL2023_ARM_64_STANDARD', ['m7g.large']), {
      ...GROUP,
      architecture: 'arm64',
      verdict: 'migrated',
      blocker: undefined,
      image: 'none',
    });
    expect(rules).toEqual([]);
  });
});

describe('the build pipeline, in both directions', () => {
  const CONSUMER: Workload = {
    id: 'service',
    kind: 'fargate-task-definition',
    owner: 'repository',
    constructPathSuffix: 'TaskDefinition/Resource',
    architecture: 'x86_64',
    verdict: 'blocked',
    blocker: 'consumer-image-single-platform',
    image: 'consumer-supplied',
    mechanics: 'task-revision',
    priceIds: ['fargate-vcpu-hour'],
    expectedResources: 0,
  };

  const audit = (buildWorkflow: string, workload: Workload) =>
    auditGraviton({
      templates: [{ path: 'Empty.template.json', document: { Resources: {} } }],
      gravitonDoc: SHIPPED_DOC,
      buildWorkflow,
      workloads: [{ ...workload, expectedResources: 0 }],
    }).violations.map((violation) => violation.rule);

  it('finds no platform in the pipeline this repository ships today', () => {
    expect(platformsBuiltBy(SHIPPED_BUILD_WORKFLOW)).toEqual([]);
    expect(SHIPPED_BUILD_WORKFLOW).toContain('docker build -f "$DOCKERFILE"');
  });

  it('reads --platform off a buildx invocation', () => {
    expect(platformsBuiltBy('run: docker buildx build --platform linux/amd64,linux/arm64 .')).toEqual([
      'linux/amd64',
      'linux/arm64',
    ]);
  });

  it('reads the platforms input of docker/build-push-action', () => {
    expect(platformsBuiltBy('        with:\n          platforms: linux/arm64\n')).toEqual([
      'linux/arm64',
    ]);
  });

  it('requires the blocker while the pipeline builds one platform', () => {
    expect(audit(SHIPPED_BUILD_WORKFLOW, { ...CONSUMER, blocker: 'no-arm64-runtime' })).toContain(
      'pipeline-blocker-missing',
    );
  });

  it('rejects the blocker once the pipeline builds arm64', () => {
    // A blocker outliving its constraint is how a task definition stays on x86
    // for a year after the reason stopped being true.
    expect(
      audit(`${SHIPPED_BUILD_WORKFLOW}\n          platforms: linux/amd64,linux/arm64\n`, CONSUMER),
    ).toContain('pipeline-blocker-stale');
  });
});

describe('layer binaries', () => {
  it('reads ELF machine names out of the layer zips this repository installs', () => {
    // The measurement the `layer-binaries-x86` blocker rests on, run against the
    // real packages rather than described. kubectl and helm are statically
    // linked x86-64 binaries; an arm64 function carrying them starts and then
    // fails on its first kubectl call, inside a custom resource, mid-deploy.
    const machines = measureLayerArchitectures(CDK_ROOT);
    expect(machines.get('@aws-cdk/lambda-layer-kubectl-v33')).toEqual(['x86-64', 'x86-64']);
    expect(machines.get('@aws-cdk/asset-awscli-v1')).toEqual(['x86-64']);
  });

  it('inflates enough of a 50 MB entry to read its header', () => {
    const zip = fs.readFileSync(
      path.join(CDK_ROOT, 'node_modules', '@aws-cdk/lambda-layer-kubectl-v33', 'lib', 'layer.zip'),
    );
    const entry = readZipEntryHead(zip, ['kubectl/kubectl']);
    expect(entry?.name).toBe('kubectl/kubectl');
    expect(entry?.head.length).toBe(64);
    expect(elfMachine(entry!.head)).toBe('x86-64');
  });

  it('decodes the two machine values that decide this question', () => {
    const header = (machine: number) => {
      const buffer = Buffer.alloc(24);
      buffer.writeUInt32BE(0x7f454c46, 0);
      buffer.writeUInt16LE(machine, 18);
      return buffer;
    };
    expect(elfMachine(header(0x3e))).toBe('x86-64');
    expect(elfMachine(header(0xb7))).toBe('aarch64');
    expect(elfMachine(Buffer.from('not an elf file at all'))).toBeUndefined();
    expect(elfMachine(Buffer.alloc(4))).toBeUndefined();
  });

  it('reports a layer it cannot read rather than passing it', () => {
    const { violations } = auditGraviton({
      templates: [{ path: 'Empty.template.json', document: { Resources: {} } }],
      gravitonDoc: SHIPPED_DOC,
      buildWorkflow: SHIPPED_BUILD_WORKFLOW,
      workloads: [],
      layerMachines: new Map(LAYER_PACKAGES.map((layer) => [layer.packageName, []])),
    });
    expect(violations.map((violation) => violation.rule)).toEqual([
      'layer-architecture-drift',
      'layer-architecture-drift',
    ]);
  });

  it('reports a blocker that has outlived the layer it describes', () => {
    const { violations } = auditGraviton({
      templates: [{ path: 'Empty.template.json', document: { Resources: {} } }],
      gravitonDoc: SHIPPED_DOC,
      buildWorkflow: SHIPPED_BUILD_WORKFLOW,
      workloads: only(['cdk-eks-kubectl-handler']).map((workload) => ({
        ...workload,
        expectedResources: 0,
      })),
      layerMachines: new Map([
        ['@aws-cdk/lambda-layer-kubectl-v33', ['aarch64', 'aarch64']],
        ['@aws-cdk/asset-awscli-v1', ['x86-64']],
      ]),
    });
    expect(violations.map((violation) => violation.rule)).toContain('layer-architecture-drift');
  });
});

describe('the guide and the wiring', () => {
  const base = {
    templates: [{ path: 'Empty.template.json', document: { Resources: {} } }],
    buildWorkflow: SHIPPED_BUILD_WORKFLOW,
    workloads: [] as readonly Workload[],
  };

  it('accepts the guide as shipped', () => {
    expect(auditGraviton({ ...base, gravitonDoc: SHIPPED_DOC }).violations).toEqual([]);
  });

  it('reports a table edited by hand', () => {
    const edited = SHIPPED_DOC.replace('| 5.88% | 6.25% |', '| 20.00% | 25.00% |');
    expect(edited).not.toEqual(SHIPPED_DOC);
    const rules = auditGraviton({ ...base, gravitonDoc: edited }).violations.map(
      (violation) => violation.rule,
    );
    expect(rules).toContain('doc-table-drift');
  });

  it('reports a blocker with no section to explain it', () => {
    const renamed = SHIPPED_DOC.replace(
      `## ${BLOCKER_SECTIONS['no-arm64-runtime']}`,
      '## Somewhere else entirely',
    );
    const rules = auditGraviton({ ...base, gravitonDoc: renamed }).violations.map(
      (violation) => violation.rule,
    );
    expect(rules).toContain('blocker-section-missing');
  });

  it('declares a section for every blocker the catalogue can produce', () => {
    const blockers = new Set(
      COMPUTE_WORKLOADS.map((workload) => workload.blocker).filter(Boolean) as string[],
    );
    for (const blocker of blockers) {
      expect(SHIPPED_DOC).toContain(`## ${BLOCKER_SECTIONS[blocker as never]}`);
    }
  });

  it('holds its silence about price age until asked, then names the stale offer', () => {
    const quiet = auditGraviton({ ...base, gravitonDoc: SHIPPED_DOC }).violations;
    expect(quiet.filter((violation) => violation.rule === 'price-stale')).toEqual([]);
    // Deliberately opt-in: a date nobody chose must not turn an unrelated pull
    // request red. Same reason audit:flags and audit:vulns run without --now.
    const loud = auditGraviton({
      ...base,
      gravitonDoc: SHIPPED_DOC,
      now: new Date('2027-06-01T00:00:00Z'),
    }).violations;
    expect(loud.every((violation) => violation.rule === 'price-stale')).toBe(true);
    expect(loud.length).toBeGreaterThan(0);
  });

  it('reports a gate nothing runs', () => {
    const rules = auditGraviton({
      ...base,
      gravitonDoc: SHIPPED_DOC,
      ciWorkflow: 'jobs:\n  cdk:\n    steps:\n      - run: npm test\n',
    }).violations.map((violation) => violation.rule);
    expect(rules).toContain('audit-not-run-in-ci');
  });

  it('is wired into the repository CI workflow', () => {
    const workflow = fs.readFileSync(
      path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    expect(
      auditGraviton({ ...base, gravitonDoc: SHIPPED_DOC, ciWorkflow: workflow }).violations,
    ).toEqual([]);
  });

  it('documents every rule it can emit, and tests every rule it documents', () => {
    // Two directions, because both failures are silent. A rule with no line in
    // the tool's header is a rule nobody reading the file knows exists; a rule
    // with no test is a rule that has never been seen to fire. Sixteen is also
    // the number docs/graviton.md and the README quote.
    const tool = fs.readFileSync(path.join(__dirname, '..', 'tools', 'audit-graviton.ts'), 'utf8');
    const header = tool.slice(0, tool.indexOf('*/'));
    const suite = fs.readFileSync(__filename.replace(/\.js$/, '.ts'), 'utf8');
    expect(GRAVITON_AUDIT_RULES).toHaveLength(16);
    for (const rule of GRAVITON_AUDIT_RULES) {
      expect([rule, header.includes(rule)]).toEqual([rule, true]);
      expect([rule, suite.includes(`'${rule}'`)]).toEqual([rule, true]);
    }
  });

  it('requires every pinned image to be classified', () => {
    expect(PINNED_IMAGES.length).toBeGreaterThan(0);
    expect(
      auditGraviton({ ...base, gravitonDoc: SHIPPED_DOC }).violations.filter(
        (violation) => violation.rule === 'image-platform-unrecorded',
      ),
    ).toEqual([]);
  });
});
