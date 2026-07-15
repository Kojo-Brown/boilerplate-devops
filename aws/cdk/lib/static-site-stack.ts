import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53_targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface StaticSiteStackProps extends cdk.StackProps {
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;

  /**
   * Primary domain name for the site (e.g. "app.example.com").
   * Required when `hostedZoneId` or `hostedZoneName` is provided.
   * Also used as the CloudFront alternate domain name (CNAME).
   */
  readonly domainName?: string;

  /**
   * Additional CNAMEs for the CloudFront distribution (e.g. "www.example.com").
   * Ignored when `domainName` is omitted.
   */
  readonly additionalDomains?: string[];

  /**
   * ACM certificate ARN for HTTPS.  MUST be in us-east-1 (CloudFront requirement).
   * Required when `domainName` is provided.
   */
  readonly certificateArn?: string;

  /**
   * Route 53 hosted zone ID.  When supplied (with `domainName`) the stack
   * creates A + AAAA alias records pointing at the CloudFront distribution.
   * Mutually exclusive with `hostedZoneName` — prefer ID to avoid a lookup.
   */
  readonly hostedZoneId?: string;

  /**
   * Route 53 hosted zone name (e.g. "example.com").
   * Used when `hostedZoneId` is unknown — triggers a lookup at deploy time.
   */
  readonly hostedZoneName?: string;

  /**
   * CloudFront price class.  PriceClass.PRICE_CLASS_100 (US/EU) is cheaper;
   * PRICE_CLASS_ALL gives global edge coverage.  Default: PRICE_CLASS_100.
   */
  readonly priceClass?: cloudfront.PriceClass;

  /**
   * Enable S3 bucket versioning so old deploys can be recovered.
   * Default: true
   */
  readonly enableVersioning?: boolean;

  /**
   * Number of non-current object versions to retain.  Older versions are
   * expired to control cost.  Default: 5.
   */
  readonly noncurrentVersionsToKeep?: number;

  /**
   * Treat the site as a Single-Page Application — rewrite 404 responses from
   * S3 to 200 /index.html so client-side routing works.  Default: true.
   */
  readonly spaMode?: boolean;

  /**
   * CloudFront default root object served when "/" is requested.
   * Default: "index.html".
   */
  readonly defaultRootObject?: string;

  /**
   * Enable CloudFront access logging.  Logs are written to a dedicated
   * S3 bucket named <siteBucketName>-cf-logs.  Default: false.
   */
  readonly enableAccessLogging?: boolean;

  /**
   * Minimum TLS protocol version.  Default: TLS_V1_2_2021.
   */
  readonly minimumProtocolVersion?: cloudfront.SecurityPolicyProtocol;
}

/**
 * S3 static website bucket + CloudFront distribution + Route 53 alias records.
 *
 * Architecture:
 *   Browser → CloudFront (HTTPS, OAC) → S3 bucket (private, no public access)
 *
 *   CloudFront features:
 *     • Origin Access Control (OAC) — bucket never exposed directly
 *     • Gzip + Brotli compression
 *     • HTTPS-only viewer protocol
 *     • Managed caching policy (CachingOptimized)
 *     • Security headers response policy (CORS-With-Preflight-And-SecurityHeadersPolicy)
 *     • Custom error response: 404 → 200 /index.html (SPA mode, opt-out)
 *     • Configurable price class (default: US/EU only)
 *
 *   Route 53:
 *     • A (IPv4) and AAAA (IPv6) alias records → CloudFront distribution
 *     • Created only when domainName + (hostedZoneId | hostedZoneName) are provided
 *
 * Deploy this stack to us-east-1.  The ACM certificate must also be in us-east-1.
 */
export class StaticSiteStack extends cdk.Stack {
  public readonly siteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  public readonly hostedZone: route53.IHostedZone | undefined;
  public readonly aRecord: route53.ARecord | undefined;
  public readonly aaaaRecord: route53.AaaaRecord | undefined;

  constructor(scope: Construct, id: string, props: StaticSiteStackProps = {}) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const spaMode = props.spaMode !== false;
    const defaultRootObject = props.defaultRootObject ?? 'index.html';
    const priceClass = props.priceClass ?? cloudfront.PriceClass.PRICE_CLASS_100;
    const enableVersioning = props.enableVersioning !== false;
    const noncurrentVersionsToKeep = props.noncurrentVersionsToKeep ?? 5;
    const enableAccessLogging = props.enableAccessLogging === true;
    const minimumProtocolVersion =
      props.minimumProtocolVersion ?? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021;

    // ── S3 Origin Bucket ──────────────────────────────────────────────────────
    // All public access is blocked; CloudFront reads via OAC (bucket policy).
    this.siteBucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${envName}-static-site-origin`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: enableVersioning,
      enforceSSL: true,
      removalPolicy:
        envName === 'production' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: envName !== 'production',
      lifecycleRules: enableVersioning
        ? [
            {
              id: 'expire-old-versions',
              enabled: true,
              noncurrentVersionExpiration: cdk.Duration.days(90),
              noncurrentVersionsToRetain: noncurrentVersionsToKeep,
            },
          ]
        : [],
    });

    // ── Optional: CloudFront Access Log Bucket ────────────────────────────────
    let logBucket: s3.Bucket | undefined;
    if (enableAccessLogging) {
      logBucket = new s3.Bucket(this, 'AccessLogBucket', {
        bucketName: `${envName}-static-site-cf-logs`,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [
          {
            id: 'expire-logs',
            enabled: true,
            expiration: cdk.Duration.days(90),
          },
        ],
      });
    }

    // ── ACM Certificate ───────────────────────────────────────────────────────
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn)
      : undefined;

    // ── Alternate domain names ────────────────────────────────────────────────
    const domainNames: string[] = [];
    if (props.domainName) {
      domainNames.push(props.domainName);
      if (props.additionalDomains) {
        domainNames.push(...props.additionalDomains);
      }
    }

    // ── CloudFront Distribution ───────────────────────────────────────────────
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${envName} static site`,
      defaultRootObject,
      priceClass,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion,

      ...(certificate && domainNames.length > 0
        ? { certificate, domainNames }
        : {}),

      defaultBehavior: {
        origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(this.siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy
            .CORS_WITH_PREFLIGHT_AND_SECURITY_HEADERS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      },

      errorResponses: spaMode
        ? [
            {
              httpStatus: 403,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
              ttl: cdk.Duration.seconds(0),
            },
            {
              httpStatus: 404,
              responseHttpStatus: 200,
              responsePagePath: '/index.html',
              ttl: cdk.Duration.seconds(0),
            },
          ]
        : [],

      ...(enableAccessLogging && logBucket
        ? {
            logBucket,
            logFilePrefix: `${envName}/`,
            enableIpv6: true,
          }
        : { enableIpv6: true }),
    });

    // The OAC-based origin construct adds the bucket policy automatically,
    // but we need to ensure the bucket policy allows the CloudFront service
    // principal with the distribution ARN via OAC condition.
    // S3BucketOrigin.withOriginAccessControl handles this; add explicit grant
    // for additional safety with a resource-based policy statement.
    this.siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipal',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.siteBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`,
          },
        },
      }),
    );

    // ── Route 53 Alias Records ────────────────────────────────────────────────
    if (props.domainName && (props.hostedZoneId || props.hostedZoneName)) {
      if (props.hostedZoneId) {
        this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(
          this,
          'HostedZone',
          {
            hostedZoneId: props.hostedZoneId,
            zoneName: props.hostedZoneName ?? props.domainName.split('.').slice(-2).join('.'),
          },
        );
      } else {
        this.hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
          domainName: props.hostedZoneName!,
        });
      }

      const cfTarget = new route53_targets.CloudFrontTarget(this.distribution);

      this.aRecord = new route53.ARecord(this, 'ARecord', {
        zone: this.hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(cfTarget),
        comment: `${envName} static site — CloudFront alias (IPv4)`,
      });

      this.aaaaRecord = new route53.AaaaRecord(this, 'AaaaRecord', {
        zone: this.hostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(cfTarget),
        comment: `${envName} static site — CloudFront alias (IPv6)`,
      });
    }

    // ── Tags ─────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'SiteBucketName', {
      value: this.siteBucket.bucketName,
      description: 'S3 bucket name — sync build artifacts here to deploy',
      exportName: `${envName}-static-site-bucket-name`,
    });

    new cdk.CfnOutput(this, 'SiteBucketArn', {
      value: this.siteBucket.bucketArn,
      description: 'S3 bucket ARN',
      exportName: `${envName}-static-site-bucket-arn`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      description: 'CloudFront distribution ID — required for cache invalidation',
      exportName: `${envName}-static-site-distribution-id`,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      description: 'CloudFront domain name (*.cloudfront.net)',
      exportName: `${envName}-static-site-cf-domain`,
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value:
        props.domainName
          ? `https://${props.domainName}`
          : `https://${this.distribution.distributionDomainName}`,
      description: 'Public URL of the static site',
      exportName: `${envName}-static-site-url`,
    });
  }
}
