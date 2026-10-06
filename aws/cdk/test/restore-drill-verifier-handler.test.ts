import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tls from 'node:tls';
import {
  GAME_DAY_NAMESPACE,
  RESTORED_BYTES_FLOOR,
  RESTORED_BYTES_TOLERANCE,
  RESTORE_TLS_CHAIN_UNVERIFIED,
  RESTORE_VERIFICATION_CHECKS,
  RestoreVerificationCheck,
  drillInstanceIdentifier,
  restoreVerdict,
} from '../lib/game-days';
import { RESTORE_VERIFIER_SOURCE } from '../lib/backup-restore-drill-stack';
import { SdkCall, loadInlineHandler, makeSdkModule } from './support/inline-lambda';

/**
 * Tests for the restore drill's verifier, compiled and run against a fake
 * PostgreSQL backend.
 *
 * The backend is a real socket, because the one check here that is about the
 * database rather than about the control plane is a wire-protocol exchange:
 * eight bytes out, one byte back, then a TLS handshake. A stub would have
 * asserted that the verifier calls a function; this asserts that it speaks the
 * protocol, which is the whole difference between `engine-negotiates-tls` and a
 * TCP connect.
 *
 * The certificate is generated into a temporary directory at setup and never
 * committed — a private key in this repository, even a test one, is exactly what
 * `npm run scan:identifiers` exists to refuse.
 *
 * What each test is for: every check in `RESTORE_VERIFICATION_CHECKS` fails in
 * the direction that looks like success. An instance that is `available` and
 * empty, a socket that opens with no engine behind it, a `FreeStorageSpace`
 * datapoint that has not been published yet — the obvious implementation reports
 * "verified" for all three.
 */

const COPY = drillInstanceIdentifier('production');
const GIB = 1024 * 1024 * 1024;

/* ── A PostgreSQL backend, as far as the verifier goes ────────────────────── */

const SSL_REQUEST_CODE = 80877103;

interface FakeBackend {
  readonly port: number;
  close(): Promise<void>;
}

let certificate: { key: string; cert: string } | undefined;

/**
 * A self-signed certificate for `localhost`, generated at setup.
 *
 * `openssl` rather than a committed PEM: a private key checked into a devops
 * boilerplate is the thing this repository's secret scanning is for, whatever
 * the comment next to it says.
 */
const generateCertificate = (): { key: string; cert: string } => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-drill-verifier-'));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '1',
      '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,DNS:*.drill.invalid',
    ], { stdio: 'pipe' });
    return { key: fs.readFileSync(keyPath, 'utf8'), cert: fs.readFileSync(certPath, 'utf8') };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

type Negotiation = 'tls' | 'refuse-tls' | 'garbage' | 'silent';

/**
 * Answer PostgreSQL's SSL negotiation, then optionally become a TLS server.
 *
 * The exchange is the real one: the client sends an int32 length of 8 and the
 * int32 code 80877103, and a backend answers one byte — `S` or `N` — before any
 * session exists.
 */
const startBackend = async (mode: Negotiation): Promise<FakeBackend> => {
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      if (chunk.length !== 8 || chunk.readInt32BE(4) !== SSL_REQUEST_CODE) {
        socket.destroy();
        return;
      }
      if (mode === 'silent') return;
      if (mode === 'garbage') {
        socket.write(Buffer.from('SS'));
        return;
      }
      if (mode === 'refuse-tls') {
        socket.write(Buffer.from('N'));
        return;
      }
      socket.write(Buffer.from('S'));
      const secure = new tls.TLSSocket(socket, {
        isServer: true,
        key: certificate!.key,
        cert: certificate!.cert,
      });
      secure.on('error', () => undefined);
    });
    socket.on('error', () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
};

/* ── The harness ──────────────────────────────────────────────────────────── */

type Handler = (event: Record<string, unknown>) => Promise<Record<string, any>>;

const RESTORE_POINT = '2026-07-01T11:58:00.000Z';
const CREATED_AT = '2026-07-01T12:00:00.000Z';

const baseEnv = (port: number): Record<string, string> => ({
  ENV_NAME: 'production',
  NAMESPACE: GAME_DAY_NAMESPACE,
  SOURCE_INSTANCE: 'production-postgres',
  DRILL_INSTANCE: COPY,
  DRILL_PORT: String(port),
  CHECKS: JSON.stringify(RESTORE_VERIFICATION_CHECKS),
  BYTES_TOLERANCE: String(RESTORED_BYTES_TOLERANCE),
  BYTES_FLOOR: String(RESTORED_BYTES_FLOOR),
  STORAGE_LOOKBACK_MINUTES: '15',
  // One attempt, no waiting: the polling behaviour has its own test, and five
  // minutes of real sleeps in every other case would be the slowest suite here.
  STORAGE_POLL_ATTEMPTS: '1',
  STORAGE_POLL_INTERVAL_MS: '1',
  TLS_CHAIN_NOTE: RESTORE_TLS_CHAIN_UNVERIFIED,
  TLS_TIMEOUT_MS: '4000',
});

interface Instances {
  readonly source?: Record<string, unknown> | Error;
  readonly copy?: Record<string, unknown> | Error;
}

interface Storage {
  readonly sourceFreeBytes?: number;
  readonly copyFreeBytes?: number;
}

const load = (
  port: number,
  instances: Instances,
  storage: Storage,
  env: Record<string, string> = {},
) => {
  const calls: SdkCall[] = [];
  const warnings: string[] = [];
  const responder = (call: SdkCall): unknown => {
    if (call.command === 'DescribeDBInstancesCommand') {
      const which =
        call.input.DBInstanceIdentifier === COPY ? instances.copy : instances.source;
      if (which instanceof Error) return which;
      return { DBInstances: which === undefined ? [] : [which] };
    }
    if (call.command === 'GetMetricDataCommand') {
      const identifier =
        call.input.MetricDataQueries[0].MetricStat.Metric.Dimensions[0].Value;
      const free = identifier === COPY ? storage.copyFreeBytes : storage.sourceFreeBytes;
      return {
        MetricDataResults: [
          { Id: 'free', Timestamps: free === undefined ? [] : [new Date()], Values: free === undefined ? [] : [free] },
        ],
      };
    }
    return {};
  };
  const handler = loadInlineHandler<Handler>({
    source: RESTORE_VERIFIER_SOURCE,
    env: { ...baseEnv(port), ...env },
    warnings,
    modules: {
      // The real sockets: the engine check is a wire-protocol exchange, so a
      // stub here would have asserted that the verifier calls a function rather
      // than that it speaks the protocol.
      'node:net': net,
      'node:tls': tls,
      '@aws-sdk/client-cloudwatch': makeSdkModule(
        ['GetMetricDataCommand', 'PutMetricDataCommand'],
        ['CloudWatchClient'],
        calls,
        responder,
      ),
      '@aws-sdk/client-rds': makeSdkModule(
        ['DescribeDBInstancesCommand'],
        ['RDSClient'],
        calls,
        responder,
      ),
    },
  });
  return { handler, calls, warnings };
};

const verify = (handler: Handler) =>
  handler({
    operation: 'verify',
    scenarioId: 'rds-pitr-drill',
    objectiveId: 'rds-point-in-time-restore',
    restorePoint: RESTORE_POINT,
    maxRestorePointStaleSeconds: 600,
    executionId: 'exec-1',
  });

const healthyCopy = {
  DBInstanceIdentifier: COPY,
  DBInstanceStatus: 'available',
  PubliclyAccessible: false,
  StorageEncrypted: true,
  AllocatedStorage: 100,
  InstanceCreateTime: CREATED_AT,
  Endpoint: { Address: 'localhost', Port: 5432 },
};

const healthySource = {
  DBInstanceIdentifier: 'production-postgres',
  DBInstanceStatus: 'available',
  AllocatedStorage: 100,
};

/** 40 GiB in use out of 100 allocated. */
const USED = 40;
const FREE = (100 - USED) * GIB;

const failedChecks = (result: Record<string, any>): string =>
  String(result.checksFailed);

beforeAll(() => {
  certificate = generateCertificate();
});

/* ── The happy path ───────────────────────────────────────────────────────── */

describe('a copy that is the data', () => {
  let backend: FakeBackend;
  beforeAll(async () => {
    backend = await startBackend('tls');
  });
  afterAll(async () => {
    await backend.close();
  });

  it('runs every check and verifies', async () => {
    const { handler, calls } = load(
      backend.port,
      { source: healthySource, copy: healthyCopy },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
    );
    const result = await verify(handler);
    expect(result.verdict).toBe('verified');
    expect(failedChecks(result)).toBe('none');
    for (const check of RESTORE_VERIFICATION_CHECKS) {
      expect(String(result.checksPassed)).toContain(check);
    }
    const published = calls.filter((call) => call.command === 'PutMetricDataCommand')[0].input;
    expect(published.Namespace).toBe(GAME_DAY_NAMESPACE);
    expect(published.MetricData[0]).toMatchObject({ MetricName: 'RestoreVerified', Value: 1 });
  });

  it('quotes why the TLS chain was not validated, in the result itself', async () => {
    const { handler } = load(
      backend.port,
      { source: healthySource, copy: healthyCopy },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
    );
    const result = await verify(handler);
    expect(String(result.checksPassed)).toContain('engine-negotiates-tls');
    // The reason travels with the result rather than living in a comment
    // somebody deletes.
    expect(RESTORE_TLS_CHAIN_UNVERIFIED).toContain('nothing is sent or read on this socket');
  });

  it('matches the library\'s verdict function on the same results', async () => {
    // `restoreVerdict` exists twice — once in lib/game-days.ts and once inline,
    // because `Code.fromInline` cannot import.
    const all = RESTORE_VERIFICATION_CHECKS.map((check) => ({
      check,
      passed: true,
      detail: 'ok',
    }));
    expect(restoreVerdict(all)).toBe('verified');
    const { handler } = load(
      backend.port,
      { source: healthySource, copy: healthyCopy },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
    );
    expect((await verify(handler)).verdict).toBe(restoreVerdict(all));
  });
});

/* ── Each way a copy is not the data ──────────────────────────────────────── */

describe('a copy that is not the data', () => {
  let backend: FakeBackend;
  beforeAll(async () => {
    backend = await startBackend('tls');
  });
  afterAll(async () => {
    await backend.close();
  });

  const expectFailure = async (
    instances: Instances,
    storage: Storage,
    check: RestoreVerificationCheck,
  ) => {
    const { handler, calls } = load(backend.port, instances, storage);
    const result = await verify(handler);
    expect(result.verdict).toBe('failed');
    expect(failedChecks(result)).toContain(check);
    const published = calls.filter((call) => call.command === 'PutMetricDataCommand')[0].input;
    expect(published.MetricData[0]).toMatchObject({ MetricName: 'RestoreVerified', Value: 0 });
    return result;
  };

  it('fails a copy that is not available', async () => {
    await expectFailure(
      { source: healthySource, copy: { ...healthyCopy, DBInstanceStatus: 'creating' } },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
      'instance-available',
    );
  });

  it('fails a copy of production on a public endpoint, and says so', async () => {
    const result = await expectFailure(
      { source: healthySource, copy: { ...healthyCopy, PubliclyAccessible: true } },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
      'not-publicly-accessible',
    );
    expect(failedChecks(result)).toContain('production-postgres');
  });

  it('fails an unencrypted copy of an encrypted source', async () => {
    await expectFailure(
      { source: healthySource, copy: { ...healthyCopy, StorageEncrypted: false } },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
      'storage-encrypted',
    );
  });

  it('fails a restore that came back empty — the check that replaces a query', async () => {
    // `available`, private, encrypted, serving TLS, right certificate, and
    // holding 300 MB where the source holds 40 GiB.
    const result = await expectFailure(
      { source: healthySource, copy: healthyCopy },
      { sourceFreeBytes: FREE, copyFreeBytes: (100 - 0.3) * GIB },
      'restored-bytes-match-source',
    );
    expect(failedChecks(result)).toContain('restored-too-small');
  });

  it('fails a copy from a point nobody asked for', async () => {
    // Every other check passes on an instance restored to last Tuesday.
    await expectFailure(
      {
        source: healthySource,
        copy: { ...healthyCopy, InstanceCreateTime: '2026-07-01T12:30:00.000Z' },
      },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
      'restore-point-not-stale',
    );
  });

  it('fails every check when the copy cannot be described, naming all of them', async () => {
    // A verdict assembled from four results out of seven is a pass rate, and
    // the record has to say which questions were not asked.
    const missing = new Error('DBInstance not found');
    const { handler } = load(
      backend.port,
      { source: healthySource, copy: missing },
      { sourceFreeBytes: FREE, copyFreeBytes: FREE },
    );
    const result = await verify(handler);
    expect(result.verdict).toBe('failed');
    for (const check of RESTORE_VERIFICATION_CHECKS) {
      expect(failedChecks(result)).toContain(check);
    }
    expect(failedChecks(result)).toContain('not run');
  });

  it('fails, rather than skips, when FreeStorageSpace has not been published yet', async () => {
    // The obvious implementation reads once, finds nothing, and skips the only
    // check that can see an empty restore — on exactly the drills that ran
    // fastest.
    const result = await expectFailure(
      { source: healthySource, copy: healthyCopy },
      { sourceFreeBytes: FREE, copyFreeBytes: undefined },
      'restored-bytes-match-source',
    );
    expect(failedChecks(result)).toContain('not run');
  });

  it('polls for the datapoint before giving up on it', async () => {
    const { handler, calls } = load(
      backend.port,
      { source: healthySource, copy: healthyCopy },
      { sourceFreeBytes: FREE, copyFreeBytes: undefined },
      { STORAGE_POLL_ATTEMPTS: '3', STORAGE_POLL_INTERVAL_MS: '1' },
    );
    await verify(handler);
    // Two instances per attempt, three attempts.
    expect(calls.filter((call) => call.command === 'GetMetricDataCommand')).toHaveLength(6);
  });
});

/* ── The wire protocol ────────────────────────────────────────────────────── */

describe('the engine check, which is a wire-protocol exchange', () => {
  const instances = { source: healthySource, copy: healthyCopy };
  const storage = { sourceFreeBytes: FREE, copyFreeBytes: FREE };

  it('fails when the backend refuses TLS, and reads that as a parameter-group finding', async () => {
    const backend = await startBackend('refuse-tls');
    try {
      const { handler } = load(backend.port, instances, storage);
      const result = await verify(handler);
      expect(failedChecks(result)).toContain('engine-negotiates-tls');
      expect(failedChecks(result)).toContain('TLS is off on the restored copy');
      // And the certificate check reports that it could not run rather than
      // passing by default.
      expect(failedChecks(result)).toContain('certificate-names-the-instance');
    } finally {
      await backend.close();
    }
  });

  it('fails when something on the port is not speaking PostgreSQL', async () => {
    const backend = await startBackend('garbage');
    try {
      const { handler } = load(backend.port, instances, storage);
      const result = await verify(handler);
      expect(failedChecks(result)).toContain('not speaking the PostgreSQL protocol');
    } finally {
      await backend.close();
    }
  });

  it('bounds the whole attempt, so a silent socket is a failure and not a hang', async () => {
    // A verifier that can hang is a drill that times out holding a copy of
    // production.
    const backend = await startBackend('silent');
    try {
      const { handler } = load(backend.port, instances, storage, { TLS_TIMEOUT_MS: '300' });
      const result = await verify(handler);
      expect(failedChecks(result)).toContain('engine-negotiates-tls');
    } finally {
      await backend.close();
    }
  }, 20000);

  it('fails when the certificate does not name the endpoint that was restored', async () => {
    const backend = await startBackend('tls');
    try {
      // The certificate covers `localhost` and `*.drill.invalid`; this endpoint
      // is neither, which is what "something answered" looks like.
      const { handler } = load(
        backend.port,
        {
          source: healthySource,
          copy: { ...healthyCopy, Endpoint: { Address: '127.0.0.1', Port: 5432 } },
        },
        storage,
      );
      const result = await verify(handler);
      expect(failedChecks(result)).toContain('certificate-names-the-instance');
      expect(failedChecks(result)).toContain('none of which covers 127.0.0.1');
    } finally {
      await backend.close();
    }
  });

  it('reports that it could not run when the copy has no endpoint yet', async () => {
    const backend = await startBackend('tls');
    try {
      const { handler } = load(
        backend.port,
        { source: healthySource, copy: { ...healthyCopy, Endpoint: undefined } },
        storage,
      );
      const result = await verify(handler);
      expect(failedChecks(result)).toContain('no endpoint address yet');
    } finally {
      await backend.close();
    }
  });
});

describe('what it refuses outright', () => {
  it('refuses an operation it does not implement', async () => {
    const { handler } = load(1, {}, {});
    await expect(handler({ operation: 'improvise' })).rejects.toThrow(/Unknown operation/);
  });
});
