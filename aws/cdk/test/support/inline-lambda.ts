/**
 * Compile and run a handler that ships as an inline source string.
 *
 * `lambda.Code.fromInline` means nothing else in the build parses these: `tsc`
 * sees a template literal and `cdk synth` embeds it verbatim. So they are
 * compiled here and run against recording stubs, which is the only way a defect
 * in one surfaces before it surfaces as a measurement nobody can reproduce.
 *
 * The same shape as `test/runbook-enricher-handler.test.ts`'s local harness,
 * lifted out because three handlers in `FailoverGameDayStack` need it.
 */

export interface SdkCall {
  readonly command: string;
  readonly input: Record<string, any>;
}

export type Responder = (call: SdkCall) => unknown;

/**
 * A stand-in for an `@aws-sdk/client-*` module.
 *
 * Commands become classes that remember their own name, and clients record
 * every `send` before handing the call to the responder. A responder returning
 * an `Error` throws it, so a test can make one API fail without making them all
 * fail.
 */
export const makeSdkModule = (
  commandNames: readonly string[],
  clientNames: readonly string[],
  calls: SdkCall[],
  responder: Responder,
): Record<string, unknown> => {
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

export interface LoadOptions {
  readonly source: string;
  /** Module id → stub. A `require` of anything else throws, loudly. */
  readonly modules: Record<string, unknown>;
  /** Environment the handler reads at module scope. */
  readonly env: Record<string, string>;
  /** Collected `console.warn` output, for the tests that assert on a log line. */
  readonly warnings?: string[];
}

export const loadInlineHandler = <T>(options: LoadOptions): T => {
  const module = { exports: {} as Record<string, unknown> };
  const requireStub = (id: string) => {
    if (!(id in options.modules)) throw new Error(`unexpected require: ${id}`);
    return options.modules[id];
  };

  const previous = { ...process.env };
  Object.assign(process.env, { AWS_REGION: 'us-east-1' }, options.env);

  try {
    const factory = new Function('require', 'module', 'exports', 'console', options.source);
    factory(requireStub, module, module.exports, {
      log: () => undefined,
      warn: (line: string) => options.warnings?.push(line),
      error: () => undefined,
    });
  } finally {
    // The handlers read their configuration at module scope, so it is captured
    // by the time this runs; restoring here keeps one test's configuration out
    // of the next one's.
    process.env = previous;
  }

  return module.exports.handler as T;
};
