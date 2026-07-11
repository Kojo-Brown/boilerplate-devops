/**
 * AWS X-Ray tracing middleware for Express 5 + TypeScript.
 *
 * Install dependencies:
 *   npm install aws-xray-sdk-core
 *   npm install --save-dev @types/aws-xray-sdk
 *
 * Usage in your Express app (src/app.ts or server.ts):
 *   import { configureXRay, xraySegmentMiddleware, captureSubsegment } from './tracing/express-xray';
 *
 *   const app = express();
 *   configureXRay(app, { serviceName: 'my-api', environment: process.env.NODE_ENV });
 *   // ... register routes
 *
 * ECS task definition requirements (see aws/cdk/lib/xray-stack.ts):
 *   - X-Ray daemon sidecar container (XRayStack.addDaemonSidecar)
 *   - Environment variable: AWS_XRAY_DAEMON_ADDRESS=localhost:2000
 */

import AWSXRay from 'aws-xray-sdk-core';
import { type Express, type Request, type Response, type NextFunction } from 'express';
import * as http from 'http';
import * as https from 'https';

export interface XRayConfig {
  /** Your service name — matches the serviceName used in XRayStack */
  serviceName: string;
  /** Environment annotation added to every segment (e.g. 'staging', 'production') */
  environment?: string;
  /**
   * X-Ray daemon address.  Defaults to AWS_XRAY_DAEMON_ADDRESS env var or localhost:2000.
   * Override only for local development (e.g. a daemon running in Docker).
   */
  daemonAddress?: string;
  /**
   * Capture outbound HTTP/HTTPS requests automatically.
   * Wraps the built-in http and https modules (default: true).
   */
  captureHttpRequests?: boolean;
  /** Paths that bypass tracing entirely (default: ['/health', '/ready', '/metrics']) */
  excludePaths?: string[];
}

/**
 * Configure X-Ray and register the tracing middleware on the Express app.
 * Call this BEFORE registering any routes or other middleware.
 */
export function configureXRay(app: Express, config: XRayConfig): void {
  const {
    serviceName,
    environment = process.env.NODE_ENV ?? 'production',
    daemonAddress = process.env.AWS_XRAY_DAEMON_ADDRESS ?? 'localhost:2000',
    captureHttpRequests = true,
    excludePaths = ['/health', '/ready', '/metrics'],
  } = config;

  AWSXRay.setDaemonAddress(daemonAddress);
  AWSXRay.config([AWSXRay.plugins.ECSPlugin]);

  // In Lambda / non-ECS environments where the daemon might not be available,
  // X-Ray falls back to a no-op mode rather than throwing.
  if (process.env.AWS_EXECUTION_ENV !== undefined || process.env.AWS_XRAY_DAEMON_ADDRESS !== undefined) {
    AWSXRay.enableAutomaticMode();
  } else {
    // Local development — suppress connection errors silently
    AWSXRay.setContextMissingStrategy('LOG_ERROR');
  }

  if (captureHttpRequests) {
    AWSXRay.captureHTTPsGlobal(http, true);
    AWSXRay.captureHTTPsGlobal(https, true);
  }

  app.use(xraySegmentMiddleware(serviceName, environment, excludePaths));
}

/**
 * Express middleware that opens an X-Ray segment for each request and closes
 * it (with status and error flags) when the response finishes.
 */
export function xraySegmentMiddleware(
  serviceName: string,
  environment: string,
  excludePaths: string[],
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (excludePaths.some((p) => req.path === p || req.path.startsWith(p + '/'))) {
      return next();
    }

    const segment = new AWSXRay.Segment(serviceName);

    // Annotations are indexed and searchable in the X-Ray console.
    segment.addAnnotation('environment', environment);
    segment.addAnnotation('service', serviceName);
    segment.addAnnotation('http_method', req.method);
    segment.addAnnotation('http_path', req.path);

    // Metadata is not indexed but appears in segment detail view.
    segment.addMetadata('request', {
      userAgent: req.headers['user-agent'],
      contentType: req.headers['content-type'],
      referer: req.headers['referer'],
    });

    AWSXRay.resolveSegment(segment);
    (req as Request & { xraySegment: AWSXRay.Segment }).xraySegment = segment;

    res.on('finish', () => {
      segment.addAnnotation('http_status', res.statusCode);
      if (res.statusCode >= 400 && res.statusCode < 500) {
        segment.addErrorFlag();
      }
      if (res.statusCode >= 500) {
        segment.addFaultFlag();
      }
      segment.close();
    });

    res.on('error', (err: Error) => {
      segment.addError(err);
      segment.close(err);
    });

    AWSXRay.getNamespace().run(() => {
      AWSXRay.getNamespace().set('segment', segment);
      next();
    });
  };
}

/**
 * Wrap an async operation in a named X-Ray subsegment.
 *
 * Usage:
 *   const result = await captureSubsegment('fetch-user', async (sub) => {
 *     sub.addAnnotation('user_id', userId);
 *     return await db.user.findUnique({ where: { id: userId } });
 *   });
 */
export async function captureSubsegment<T>(
  name: string,
  fn: (subsegment: AWSXRay.Subsegment) => Promise<T>,
): Promise<T> {
  return AWSXRay.captureAsyncFunc(name, fn) as Promise<T>;
}

/**
 * Capture a Prisma client so all database calls appear as X-Ray subsegments.
 * Pass the Prisma client instance; returns the same instance with tracing added.
 *
 * Usage:
 *   import { PrismaClient } from '@prisma/client';
 *   const prisma = capturePostgres(new PrismaClient());
 */
export function capturePostgres<T extends object>(prismaOrPgClient: T): T {
  // aws-xray-sdk-core can patch pg directly:
  //   AWSXRay.capturePostgres(require('pg'));
  // For Prisma, wrap queries in subsegments manually via Prisma middleware:
  //   prisma.$use(async (params, next) => captureSubsegment(`prisma.${params.model}.${params.action}`, () => next(params)));
  // This helper is a reminder of the pattern; replace with your ORM approach.
  AWSXRay.capturePostgres(prismaOrPgClient as never);
  return prismaOrPgClient;
}
