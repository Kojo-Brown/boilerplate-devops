import { RUNBOOK_ENRICHER_SOURCE } from '../lib/runbook-stack';
import { matchesPattern } from '../lib/runbooks';

/**
 * Behavioural tests for the inline enricher.
 *
 * `lambda.Code.fromInline` ships this as a string, so nothing else in the build
 * parses it: `tsc` sees a template literal and `cdk synth` embeds it verbatim.
 * Every decision in here fails in the same direction — an alert that arrives
 * looking complete and is not, or an alert that does not arrive at all — so the
 * handler is compiled and run against recording stubs rather than asserted on as
 * text.
 */

interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

type Handler = (event: unknown) => Promise<{
  enriched: number;
  started: number;
  unmatched: number;
}>;

const makeSdkModule = (
  commandNames: string[],
  clientNames: string[],
  calls: SdkCall[],
  responder: (call: SdkCall) => unknown,
) => {
  const module: Record<string, unknown> = {};

  for (const name of commandNames) {
    module[name] = class {
      readonly __name = name;
      constructor(readonly input: Record<string, any>) {}
    };
  }
  for (const clientName of clientNames) {
    module[clientName] = class {
      async send(command: { __name: string; input: Record<string, any> }) {
        const call = { command: command.__name, input: command.input };
        calls.push(call);
        const result = responder(call);
        if (result instanceof Error) throw result;
        return result;
      }
    };
  }
  return module;
};

const RUNBOOKS = [
  {
    id: 'api-5xx',
    title: 'The API is returning 5xx',
    owner: 'platform-team',
    summary: 'Requests are failing at the load balancer.',
    url: 'https://docs.invalid/docs/runbooks.md#2-the-api-is-returning-5xx',
    patterns: ['*-alb-5xx-*', '*-canary-5xx'],
    firstStep: {
      documentName: 'production-rb-ecs-service-state',
      summary: 'reads the ECS service',
      alarmFilledParameters: [] as string[],
    },
  },
  {
    id: 'platform-tooling',
    title: 'A platform component has stopped reporting',
    owner: 'platform-team',
    summary: 'Something that measures the platform has failed.',
    url: 'https://docs.invalid/docs/runbooks.md#9-a-platform-component-has-stopped-reporting',
    patterns: ['*-errors'],
    firstStep: {
      documentName: 'production-rb-alarm-history',
      summary: 'reads the alarm history',
      alarmFilledParameters: ['AlarmName'],
    },
  },
];

interface Harness {
  readonly handler: Handler;
  readonly calls: SdkCall[];
}

const load = (
  responder: (call: SdkCall) => unknown = () => ({ AutomationExecutionId: 'exec-1' }),
  runbooks: unknown = RUNBOOKS,
): Harness => {
  const calls: SdkCall[] = [];
  const modules: Record<string, unknown> = {
    '@aws-sdk/client-ssm': makeSdkModule(
      ['StartAutomationExecutionCommand'],
      ['SSMClient'],
      calls,
      responder,
    ),
    '@aws-sdk/client-sns': makeSdkModule(['PublishCommand'], ['SNSClient'], calls, responder),
  };

  const module = { exports: {} as { handler?: Handler } };
  const requireStub = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require: ${id}`);
    return modules[id];
  };

  const previous = { ...process.env };
  process.env.AWS_REGION = 'us-east-1';
  process.env.RUNBOOKS = JSON.stringify(runbooks);
  process.env.ALERT_TOPIC_ARN = 'arn:aws:sns:us-east-1:111122223333:production-runbook-alerts';
  process.env.ENV_NAME = 'production';

  try {
    const factory = new Function('require', 'module', 'exports', 'console', RUNBOOK_ENRICHER_SOURCE);
    factory(requireStub, module, module.exports, { log: () => undefined });
  } finally {
    // The handler reads its configuration at module scope, so it is already
    // captured by the time this runs; restoring the environment here keeps one
    // test's configuration out of the next one's.
    process.env = previous;
  }

  return { handler: module.exports.handler!, calls };
};

const notification = (message: Record<string, unknown>) => ({
  Records: [
    {
      Sns: {
        TopicArn: 'arn:aws:sns:us-east-1:111122223333:production-cloudwatch-alarms',
        Subject: 'ALARM',
        Message: JSON.stringify(message),
      },
    },
  ],
});

const ALB_ALARM = {
  AlarmName: 'production-alb-5xx-target',
  AlarmArn: 'arn:aws:cloudwatch:eu-west-1:111122223333:alarm:production-alb-5xx-target',
  NewStateValue: 'ALARM',
  NewStateReason: 'Threshold Crossed: 1 datapoint [12.0] was greater than the threshold (5.0).',
  StateChangeTime: '2026-09-26T04:02:11.000+0000',
  Region: 'EU (Ireland)',
};

const published = (calls: SdkCall[]) =>
  calls.filter((call) => call.command === 'PublishCommand').map((call) => call.input);

const automations = (calls: SdkCall[]) =>
  calls.filter((call) => call.command === 'StartAutomationExecutionCommand').map((call) => call.input);

describe('enriching an alarm', () => {
  it('starts the runbook\'s first step and publishes the execution with it', async () => {
    const { handler, calls } = load();
    const result = await handler(notification(ALB_ALARM));

    expect(result).toEqual({ enriched: 1, started: 1, unmatched: 0 });
    expect(automations(calls)).toEqual([
      { DocumentName: 'production-rb-ecs-service-state', Parameters: {} },
    ]);

    const [message] = published(calls);
    expect(message.Message).toContain('The API is returning 5xx');
    expect(message.Message).toContain('docs/runbooks.md#2-the-api-is-returning-5xx');
    expect(message.Message).toContain('Already running: exec-1');
    expect(message.Message).toContain('reads the ECS service');
  });

  it('fills the parameters the alarm carries, and only those', async () => {
    const { handler, calls } = load();
    await handler(
      notification({ ...ALB_ALARM, AlarmName: 'production-slo-budget-reporter-errors' }),
    );

    expect(automations(calls)).toEqual([
      {
        DocumentName: 'production-rb-alarm-history',
        Parameters: { AlarmName: ['production-slo-budget-reporter-errors'] },
      },
    ]);
  });

  it('takes the region from the alarm ARN, not from the enricher', async () => {
    // `Region` in a CloudWatch notification is a display name — "EU (Ireland)" —
    // and putting it in a console URL produces a link that does not resolve. The
    // ARN is the only machine-readable region in the message.
    const { handler, calls } = load();
    await handler(notification(ALB_ALARM));
    expect(published(calls)[0].Message).toContain('eu-west-1.console.aws.amazon.com');
  });

  it('keeps the subject inside the 100 characters SNS accepts', async () => {
    const { handler, calls } = load();
    await handler(notification({ ...ALB_ALARM, AlarmName: 'x'.repeat(200) }));

    const subject = published(calls)[0].Subject as string;
    expect(subject.length).toBeLessThanOrEqual(100);
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

describe('when something is missing', () => {
  it('still publishes an alert for an alarm no runbook matches', async () => {
    const { handler, calls } = load();
    const result = await handler(notification({ ...ALB_ALARM, AlarmName: 'production-mystery' }));

    expect(result).toEqual({ enriched: 1, started: 0, unmatched: 1 });
    expect(automations(calls)).toHaveLength(0);
    const [message] = published(calls);
    expect(message.Message).toContain('No runbook matches this alarm name');
    expect(message.Message).toContain('production-mystery');
  });

  it('still publishes when the automation will not start, with the command to run', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'StartAutomationExecutionCommand'
        ? new Error('InvalidDocument: production-rb-ecs-service-state does not exist')
        : {},
    );
    const result = await handler(notification(ALB_ALARM));

    expect(result).toEqual({ enriched: 1, started: 0, unmatched: 0 });
    const [message] = published(calls);
    expect(message.Message).toContain('Could not be started automatically');
    expect(message.Message).toContain(
      'aws ssm start-automation-execution --document-name production-rb-ecs-service-state',
    );
    expect(message.Message).toContain('--region eu-west-1');
  });

  it('includes the parameters in the fallback command, so it can be pasted as-is', async () => {
    const { handler, calls } = load((call) =>
      call.command === 'StartAutomationExecutionCommand' ? new Error('throttled') : {},
    );
    await handler(notification({ ...ALB_ALARM, AlarmName: 'production-reporter-errors' }));
    expect(published(calls)[0].Message).toContain(
      "--parameters 'AlarmName=production-reporter-errors'",
    );
  });

  it('publishes a notification it cannot parse rather than dropping it', async () => {
    // Something other than CloudWatch publishes to a topic an alarm also uses.
    // Dropping it would be this function deciding what the rota may see.
    const { handler, calls } = load();
    const result = await handler({
      Records: [{ Sns: { Subject: 'budget exceeded', Message: 'not json' } }],
    });

    expect(result.enriched).toBe(1);
    expect(published(calls)[0].Message).toContain('not json');
  });

  it('throws when the publish itself fails, so SNS retries into the dead-letter queue', async () => {
    const { handler } = load((call) =>
      call.command === 'PublishCommand' ? new Error('KMSAccessDenied') : { AutomationExecutionId: 'e' },
    );
    await expect(handler(notification(ALB_ALARM))).rejects.toThrow('KMSAccessDenied');
  });
});

describe('recoveries', () => {
  it('announces an OK transition without starting anything', async () => {
    const { handler, calls } = load();
    const result = await handler(notification({ ...ALB_ALARM, NewStateValue: 'OK' }));

    expect(result).toEqual({ enriched: 1, started: 0, unmatched: 0 });
    expect(automations(calls)).toHaveLength(0);
    expect(published(calls)[0].Subject).toContain('[OK]');
    // The runbook is still attached: a recovery two minutes into an incident is
    // not the same as the incident being over.
    expect(published(calls)[0].Message).toContain('docs/runbooks.md');
  });

  it('handles a batch of records, which SNS is allowed to deliver', async () => {
    const { handler, calls } = load();
    const result = await handler({
      Records: [
        notification(ALB_ALARM).Records[0],
        notification({ ...ALB_ALARM, AlarmName: 'production-canary-5xx' }).Records[0],
      ],
    });

    expect(result).toEqual({ enriched: 2, started: 2, unmatched: 0 });
    expect(published(calls)).toHaveLength(2);
  });
});

describe('the two matchers', () => {
  /*
   * The enricher is a string, so it cannot import `matchesPattern` and carries
   * its own copy. A copy that drifts matches nothing, and an alert with no
   * runbook on it looks exactly like an alarm nobody has written a runbook for —
   * which is the state this whole feature exists to make impossible. Both are
   * run over the same pairs, each against a catalogue holding only that pattern,
   * so the two answers are directly comparable.
   */
  const cases: [string, string][] = [
    ['*-alb-5xx-*', 'production-alb-5xx-target'],
    ['*-alb-5xx-*', 'production-alb-5xx'],
    ['*-canary-*-*-?', 'production-canary-us-east-1'],
    ['*-canary-*-*-?', 'production-canary-ticket'],
    ['*-burn-fast', 'production-api-availability-burn-fast'],
    ['*-burn-fast', 'production-slo-burn-rate-fast'],
    ['*lead-time-unmeasurable', 'DoraMetricsStack-lead-time-unmeasurable'],
    ['a.c', 'abc'],
    ['a.c', 'a.c'],
    ['*-errors', 'production-reporter-errors'],
    ['exact-name', 'exact-name'],
    ['exact-name', 'prefixed-exact-name'],
  ];

  it.each(cases)('agrees with lib/runbooks.ts on %s / %s', async (pattern, name) => {
    const { handler, calls } = load(undefined, [{ ...RUNBOOKS[0], patterns: [pattern] }]);
    await handler(notification({ ...ALB_ALARM, AlarmName: name }));

    const matchedInHandler = !(published(calls)[0].Message as string).includes(
      'No runbook matches',
    );
    expect(matchedInHandler).toBe(matchesPattern(pattern, name));
  });
});
