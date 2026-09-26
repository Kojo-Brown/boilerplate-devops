import {
  ALARM_FILLED_PARAMETERS,
  EnrichmentExemption,
  RunbookDefinition,
  firstStepDocumentName,
} from '../lib/runbooks';
import { ENRICHED_TOPIC_SUFFIX } from '../lib/runbook-stack';
import {
  ASSUME_ROLE_PARAMETER,
  DOCUMENT_NAME_INFIX,
  ENRICHED_TOPIC_SUFFIX as AUDIT_ENRICHED_TOPIC_SUFFIX,
  ENRICHER_FUNCTION_SUFFIX,
  FIRST_STEP_ACTION,
  READ_ONLY_API_PREFIXES,
  RunbookAuditRule,
  TemplateFile,
  anchorsIn,
  auditRunbooks,
  headingSlug,
} from '../tools/audit-runbooks';

/**
 * Rules over the synthesised templates.
 *
 * Each one is asserted twice: a tree that satisfies it reports nothing, and a
 * tree missing exactly one property reports exactly that rule. A gate whose
 * detection has quietly stopped working passes identically to a tree with
 * nothing wrong in it, which is the failure this file exists for.
 */

const DOC = `
# Runbooks

## 2. The API is returning 5xx

## 9. A platform component has stopped reporting
`;

const CATALOGUE: RunbookDefinition[] = [
  {
    id: 'api-5xx',
    title: 'The API is returning 5xx',
    owner: 'platform-team',
    anchor: '#2-the-api-is-returning-5xx',
    alarmNamePatterns: ['*-alb-5xx-*'],
    summary: 'Requests are failing.',
    firstStep: {
      documentKey: 'ecs-service-state',
      summary: 'reads the ECS service',
      alarmFilledParameters: [],
    },
  },
  {
    id: 'platform-tooling',
    title: 'A platform component has stopped reporting',
    owner: 'platform-team',
    anchor: '#9-a-platform-component-has-stopped-reporting',
    alarmNamePatterns: ['*-enricher-errors'],
    summary: 'Something that measures the platform has failed.',
    firstStep: {
      documentKey: 'alarm-history',
      summary: 'reads the alarm history',
      alarmFilledParameters: ['AlarmName'],
    },
  },
];

const EXEMPTIONS: EnrichmentExemption[] = [
  {
    topicNamePattern: '*-canary-*-*-?',
    reason:
      'Per-region canary topics live in the probing region, and SNS cannot deliver to a Lambda ' +
      'outside its own region.',
  },
];

const document = (key: string, overrides: Record<string, unknown> = {}) => ({
  Type: 'AWS::SSM::Document',
  Properties: {
    Name: firstStepDocumentName('test', key),
    DocumentType: 'Automation',
    Content: {
      schemaVersion: '0.3',
      assumeRole: `{{ ${ASSUME_ROLE_PARAMETER} }}`,
      parameters: {
        [ASSUME_ROLE_PARAMETER]: { type: 'String', default: { 'Fn::GetAtt': ['Role', 'Arn'] } },
        ...((overrides.parameters as Record<string, unknown>) ?? {}),
      },
      mainSteps: (overrides.mainSteps as unknown[]) ?? [
        {
          name: 'readDescribeServices',
          action: FIRST_STEP_ACTION,
          inputs: { Service: 'ecs', Api: 'DescribeServices' },
        },
      ],
    },
  },
});

/** A tree in which every rule is satisfied. */
const goodTree = (): TemplateFile[] => [
  {
    path: 'AlarmStack.template.json',
    document: {
      Resources: {
        AlarmTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: 'test-cloudwatch-alarms' },
        },
        Alb5xx: {
          Type: 'AWS::CloudWatch::Alarm',
          Properties: {
            AlarmName: 'test-alb-5xx-target',
            AlarmActions: [{ Ref: 'AlarmTopic' }],
          },
        },
        Rollback: {
          // No SNS action: an actuator, not a notification. Nobody is woken by
          // it, so it needs no runbook.
          Type: 'AWS::CloudWatch::Alarm',
          Properties: {
            AlarmName: 'test-deployment-rollback',
            AlarmActions: [{ Ref: 'SomeDeploymentGroup' }],
          },
        },
      },
      Outputs: {
        AlarmTopicArn: {
          Value: { Ref: 'AlarmTopic' },
          Export: { Name: 'AlarmStack:AlarmTopicArn' },
        },
      },
    },
  },
  {
    path: 'RunbookStack.template.json',
    document: {
      Resources: {
        EcsServiceStateDocument: document('ecs-service-state', {
          parameters: { ClusterName: { type: 'String', default: 'test-cluster' } },
        }),
        AlarmHistoryDocument: document('alarm-history', {
          parameters: { AlarmName: { type: 'String' } },
          mainSteps: [
            {
              name: 'readDescribeAlarmHistory',
              action: FIRST_STEP_ACTION,
              inputs: { Service: 'cloudwatch', Api: 'DescribeAlarmHistory' },
            },
          ],
        }),
        Enricher: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            FunctionName: `test${ENRICHER_FUNCTION_SUFFIX}`,
            DeadLetterConfig: { TargetArn: { 'Fn::GetAtt': ['Dlq', 'Arn'] } },
          },
        },
        AlertTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: `test${AUDIT_ENRICHED_TOPIC_SUFFIX}` },
        },
        EnricherErrors: {
          Type: 'AWS::CloudWatch::Alarm',
          Properties: {
            AlarmName: 'test-enricher-errors',
            AlarmActions: [{ Ref: 'AlertTopic' }],
          },
        },
        Subscription: {
          Type: 'AWS::SNS::Subscription',
          Properties: {
            Protocol: 'lambda',
            Endpoint: { 'Fn::GetAtt': ['Enricher', 'Arn'] },
            TopicArn: { 'Fn::ImportValue': 'AlarmStack:AlarmTopicArn' },
          },
        },
      },
    },
  },
  {
    path: 'CanaryStack.template.json',
    document: {
      Resources: {
        RegionalTopic: {
          Type: 'AWS::SNS::Topic',
          Properties: { TopicName: 'test-canary-us-east-1' },
        },
        // Exempt: the topic is in another region, so it matches the exemption
        // rather than the enricher.
        CanaryFailed: {
          Type: 'AWS::CloudWatch::Alarm',
          Properties: {
            AlarmName: 'test-alb-5xx-canary',
            AlarmActions: [{ Ref: 'RegionalTopic' }],
          },
        },
      },
    },
  },
];

const audit = (templates: TemplateFile[], runbookDoc = DOC) =>
  auditRunbooks({ templates, runbookDoc, catalogue: CATALOGUE, exemptions: EXEMPTIONS });

const rules = (templates: TemplateFile[], runbookDoc = DOC): RunbookAuditRule[] =>
  audit(templates, runbookDoc).violations.map((violation) => violation.rule);

/** Edit one resource in one template of a fresh good tree. */
const mutate = (
  file: string,
  logicalId: string,
  change: (resource: any) => void,
): TemplateFile[] => {
  const templates = goodTree();
  const target = templates.find((template) => template.path === file)!;
  change((target.document as any).Resources[logicalId]);
  return templates;
};

describe('the restated constants', () => {
  it('match what lib/ exports', () => {
    expect(`-${firstStepDocumentName('', '').replace(/^-/, '')}`).toBe(DOCUMENT_NAME_INFIX);
    expect(AUDIT_ENRICHED_TOPIC_SUFFIX).toBe(`-${ENRICHED_TOPIC_SUFFIX}`);
    expect([...ALARM_FILLED_PARAMETERS]).toEqual(['AlarmName']);
  });

  it('name only verbs that cannot change anything', () => {
    expect([...READ_ONLY_API_PREFIXES]).toEqual(['Describe', 'Get', 'List']);
  });
});

describe('a tree with nothing wrong in it', () => {
  it('reports no violations', () => {
    expect(rules(goodTree())).toEqual([]);
  });

  it('reads what it says it read', () => {
    const result = audit(goodTree());
    expect(result.alarmsRead).toBe(3);
    expect(result.documentsRead).toBe(2);
    expect(result.enrichedTopics).toBe(1);
  });

  it('resolves a cross-stack subscription back to the topic the alarm names', () => {
    // The subscription references the topic as `Fn::ImportValue` and the alarm
    // as `Ref`. Without the export index those are two different strings for one
    // topic, and every cross-stack subscription reads as missing.
    expect(rules(goodTree())).not.toContain('alarm-topic-without-enricher');
  });
});

describe('coverage', () => {
  it('reports an alarm that wakes someone and matches nothing', () => {
    const templates = mutate('AlarmStack.template.json', 'Alb5xx', (resource) => {
      resource.Properties.AlarmName = 'test-something-new';
    });
    expect(rules(templates)).toContain('alarm-without-runbook');
  });

  it('does not ask for a runbook for an alarm that notifies no topic', () => {
    // `test-deployment-rollback` in the fixture drives CodeDeploy and wakes
    // nobody.
    expect(rules(goodTree())).not.toContain('alarm-without-runbook');
  });

  it('reports an alarm two runbooks claim', () => {
    const catalogue = [CATALOGUE[0], { ...CATALOGUE[1], alarmNamePatterns: ['*-alb-5xx-*'] }];
    const violations = auditRunbooks({
      templates: goodTree(),
      runbookDoc: DOC,
      catalogue,
      exemptions: EXEMPTIONS,
    }).violations;
    expect(violations.map((violation) => violation.rule)).toContain('alarm-matches-two-runbooks');
  });

  it('reports a runbook no alarm reaches', () => {
    const templates = mutate('RunbookStack.template.json', 'EnricherErrors', (resource) => {
      resource.Properties.AlarmName = 'test-renamed-since';
    });
    // The alarm now matches nothing *and* leaves its runbook unreachable: both
    // halves of the same rename.
    expect(rules(templates)).toEqual(
      expect.arrayContaining(['alarm-without-runbook', 'runbook-without-alarms']),
    );
  });
});

describe('the link', () => {
  it('reports an anchor with no heading behind it', () => {
    const renamed = DOC.replace('## 2. The API is returning 5xx', '## 2. The API is failing');
    expect(rules(goodTree(), renamed)).toContain('runbook-anchor-missing');
  });

  it('slugs a heading the way GitHub does', () => {
    expect(headingSlug('9. A platform component has stopped reporting')).toBe(
      '9-a-platform-component-has-stopped-reporting',
    );
    expect(headingSlug('The API is returning 5xx')).toBe('the-api-is-returning-5xx');
    expect(headingSlug("Don't drop `code` — or dashes")).toBe('dont-drop-code--or-dashes');
  });

  it('collects every heading level', () => {
    expect(anchorsIn('# One\n### Three\ntext\n')).toEqual(new Set(['#one', '#three']));
  });
});

describe('the first step', () => {
  it('reports a first step whose document nothing creates', () => {
    const templates = goodTree().filter(
      (template) => template.path !== 'RunbookStack.template.json',
    );
    expect(rules(templates)).toContain('first-step-document-missing');
  });

  it('reports a step that is not a single read call', () => {
    const templates = mutate('RunbookStack.template.json', 'EcsServiceStateDocument', (resource) => {
      resource.Properties.Content.mainSteps.push({
        name: 'second',
        action: FIRST_STEP_ACTION,
        inputs: { Service: 'ecs', Api: 'DescribeTasks' },
      });
    });
    expect(rules(templates)).toContain('first-step-action-not-a-read');
  });

  it('reports a step that runs code', () => {
    const templates = mutate('RunbookStack.template.json', 'EcsServiceStateDocument', (resource) => {
      resource.Properties.Content.mainSteps = [
        { name: 'script', action: 'aws:executeScript', inputs: { Runtime: 'python3.11' } },
      ];
    });
    expect(rules(templates)).toContain('first-step-action-not-a-read');
  });

  it('reports a verb that changes something', () => {
    const templates = mutate('RunbookStack.template.json', 'EcsServiceStateDocument', (resource) => {
      resource.Properties.Content.mainSteps[0].inputs.Api = 'UpdateService';
    });
    expect(rules(templates)).toContain('first-step-not-read-only');
  });

  it('reports a step that does not say what it calls', () => {
    const templates = mutate('RunbookStack.template.json', 'EcsServiceStateDocument', (resource) => {
      delete resource.Properties.Content.mainSteps[0].inputs.Api;
    });
    expect(rules(templates)).toContain('first-step-not-read-only');
  });

  it('reports a parameter with no default the enricher cannot supply', () => {
    const templates = mutate('RunbookStack.template.json', 'EcsServiceStateDocument', (resource) => {
      delete resource.Properties.Content.parameters.ClusterName.default;
    });
    expect(rules(templates)).toContain('first-step-parameter-unfillable');
  });

  it('accepts a parameter with no default that the runbook says the enricher fills', () => {
    // `AlarmName` on the alarm-history document is exactly this case.
    expect(rules(goodTree())).not.toContain('first-step-parameter-unfillable');
  });

  it('reports a placeholder default', () => {
    const templates = mutate('RunbookStack.template.json', 'EcsServiceStateDocument', (resource) => {
      resource.Properties.Content.parameters.ClusterName.default = 'TODO';
    });
    expect(rules(templates)).toContain('first-step-default-placeholder');
  });

  it('does not mistake an unresolved intrinsic for a placeholder', () => {
    // The assume-role default is an `Fn::GetAtt` in every real template, and it
    // is a real value at deploy time.
    expect(rules(goodTree())).not.toContain('first-step-default-placeholder');
  });

  it('checks a document no runbook names, because the role that runs it is shared', () => {
    const templates = goodTree();
    (templates[1].document as any).Resources.StrayDocument = document('restart-service', {
      mainSteps: [
        {
          name: 'restart',
          action: FIRST_STEP_ACTION,
          inputs: { Service: 'ecs', Api: 'UpdateService' },
        },
      ],
    });
    expect(rules(templates)).toContain('first-step-not-read-only');
  });
});

describe('the seam between alarm and enricher', () => {
  it('reports an alarm on a topic nothing enriches and nothing exempts', () => {
    const templates = goodTree();
    delete (templates[1].document as any).Resources.Subscription;
    expect(rules(templates)).toContain('alarm-topic-without-enricher');
  });

  it('allows the enriched topic itself, which takes the enricher\'s own alarm', () => {
    expect(rules(goodTree())).not.toContain('alarm-topic-without-enricher');
  });

  it('reports an exemption describing a topic that no longer exists', () => {
    const templates = goodTree().filter(
      (template) => template.path !== 'CanaryStack.template.json',
    );
    expect(rules(templates)).toContain('exemption-matches-no-topic');
  });

  it('reports an enricher that drops what it cannot process', () => {
    const templates = mutate('RunbookStack.template.json', 'Enricher', (resource) => {
      delete resource.Properties.DeadLetterConfig;
    });
    expect(rules(templates)).toContain('enricher-without-dead-letter');
  });

  it('does not count a subscription to something other than the enricher', () => {
    const templates = goodTree();
    (templates[1].document as any).Resources.Subscription.Properties.Endpoint = {
      'Fn::GetAtt': ['SomeOtherFunction', 'Arn'],
    };
    expect(rules(templates)).toContain('alarm-topic-without-enricher');
  });
});

describe('the catalogue rules', () => {
  it('are reported by this gate too, so one command covers both', () => {
    const violations = auditRunbooks({
      templates: goodTree(),
      runbookDoc: DOC,
      catalogue: [{ ...CATALOGUE[0], owner: 'alex@example.com' }, CATALOGUE[1]],
      exemptions: EXEMPTIONS,
    }).violations;
    expect(violations.map((violation) => violation.rule)).toContain('catalogue');
    expect(violations.find((violation) => violation.rule === 'catalogue')?.message).toContain(
      'owner-is-an-individual',
    );
  });
});
