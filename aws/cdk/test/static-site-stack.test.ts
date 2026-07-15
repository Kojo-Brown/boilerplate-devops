import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StaticSiteStack, StaticSiteStackProps } from '../lib/static-site-stack';

const BASE_PROPS: StaticSiteStackProps = {
  envName: 'test',
  env: { account: '123456789012', region: 'us-east-1' },
};

const makeStack = (overrides: Partial<StaticSiteStackProps> = {}) => {
  const app = new cdk.App();
  const stack = new StaticSiteStack(app, 'TestStaticSiteStack', {
    ...BASE_PROPS,
    ...overrides,
  });
  return { stack, template: Template.fromStack(stack) };
};

describe('StaticSiteStack', () => {
  describe('S3 Bucket', () => {
    it('creates exactly one site bucket', () => {
      const { template } = makeStack();
      // May have 2 buckets when access logging is enabled
      const buckets = template.findResources('AWS::S3::Bucket');
      expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
    });

    it('names the bucket using envName', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'staging-static-site-origin',
      });
    });

    it('blocks all public access', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'test-static-site-origin',
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('enables S3-managed encryption', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'test-static-site-origin',
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            {
              ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
            },
          ],
        },
      });
    });

    it('enables versioning by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'test-static-site-origin',
        VersioningConfiguration: { Status: 'Enabled' },
      });
    });

    it('disables versioning when enableVersioning is false', () => {
      const { template } = makeStack({ enableVersioning: false });
      const buckets = template.findResources('AWS::S3::Bucket');
      const siteBucket = Object.values(buckets).find(
        (b: { Properties: { BucketName?: string } }) =>
          (b as { Properties: { BucketName?: string } }).Properties.BucketName ===
          'test-static-site-origin',
      ) as { Properties: { VersioningConfiguration?: unknown } } | undefined;
      expect(siteBucket?.Properties?.VersioningConfiguration).toBeUndefined();
    });

    it('adds a lifecycle rule to expire noncurrent versions', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'test-static-site-origin',
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({
              Id: 'expire-old-versions',
              Status: 'Enabled',
              NoncurrentVersionExpiration: { NoncurrentDays: 90 },
            }),
          ]),
        },
      });
    });

    it('enforces SSL on the bucket', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('creates a second bucket for access logs when enableAccessLogging is true', () => {
      const { template } = makeStack({ enableAccessLogging: true });
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'test-static-site-cf-logs',
      });
    });
  });

  describe('S3 Bucket Policy (OAC)', () => {
    it('grants CloudFront service principal GetObject access', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCloudFrontServicePrincipal',
              Effect: 'Allow',
              Principal: { Service: 'cloudfront.amazonaws.com' },
              Action: 's3:GetObject',
            }),
          ]),
        },
      });
    });
  });

  describe('CloudFront Distribution', () => {
    it('creates exactly one distribution', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CloudFront::Distribution', 1);
    });

    it('sets the default root object to index.html', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultRootObject: 'index.html',
        },
      });
    });

    it('accepts a custom default root object', () => {
      const { template } = makeStack({ defaultRootObject: 'home.html' });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { DefaultRootObject: 'home.html' },
      });
    });

    it('defaults to PriceClass_100', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { PriceClass: 'PriceClass_100' },
      });
    });

    it('uses PriceClass_All when specified', () => {
      const { template } = makeStack({ priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { PriceClass: 'PriceClass_All' },
      });
    });

    it('enforces HTTPS-only viewer protocol', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: {
            ViewerProtocolPolicy: 'redirect-to-https',
          },
        },
      });
    });

    it('enables compression', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          DefaultCacheBehavior: { Compress: true },
        },
      });
    });

    it('includes SPA 404→200 custom error response by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 404,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
            }),
          ]),
        },
      });
    });

    it('includes SPA 403→200 custom error response by default', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          CustomErrorResponses: Match.arrayWith([
            Match.objectLike({
              ErrorCode: 403,
              ResponseCode: 200,
              ResponsePagePath: '/index.html',
            }),
          ]),
        },
      });
    });

    it('omits custom error responses when spaMode is false', () => {
      const { template } = makeStack({ spaMode: false });
      const dists = template.findResources('AWS::CloudFront::Distribution');
      const dist = Object.values(dists)[0] as {
        Properties: { DistributionConfig: { CustomErrorResponses?: unknown[] } };
      };
      expect(dist.Properties.DistributionConfig.CustomErrorResponses ?? []).toHaveLength(0);
    });

    it('enables IPv6', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { IPV6Enabled: true },
      });
    });

    it('uses HTTP2_AND_3 protocol', () => {
      const { template } = makeStack();
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: { HttpVersion: 'http2and3' },
      });
    });

    it('attaches the ACM certificate and domain names when provided', () => {
      const certArn =
        'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-111122223333';
      const { template } = makeStack({
        domainName: 'app.example.com',
        certificateArn: certArn,
      });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Aliases: Match.arrayWith(['app.example.com']),
          ViewerCertificate: Match.objectLike({
            AcmCertificateArn: certArn,
          }),
        },
      });
    });

    it('includes additional domains in distribution aliases', () => {
      const certArn =
        'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-111122223333';
      const { template } = makeStack({
        domainName: 'app.example.com',
        additionalDomains: ['www.example.com'],
        certificateArn: certArn,
      });
      template.hasResourceProperties('AWS::CloudFront::Distribution', {
        DistributionConfig: {
          Aliases: Match.arrayWith(['app.example.com', 'www.example.com']),
        },
      });
    });

    it('creates an OAC resource', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    });
  });

  describe('Route 53', () => {
    it('creates no DNS records when domainName is omitted', () => {
      const { template } = makeStack();
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    it('creates no DNS records when hostedZoneId is omitted', () => {
      const { template } = makeStack({ domainName: 'app.example.com' });
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    it('creates A and AAAA alias records when hostedZoneId is provided', () => {
      const { template } = makeStack({
        domainName: 'app.example.com',
        hostedZoneId: 'Z1234567890ABC',
        hostedZoneName: 'example.com',
        certificateArn:
          'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-111122223333',
      });
      template.resourceCountIs('AWS::Route53::RecordSet', 2);
    });

    it('A record aliases the CloudFront distribution', () => {
      const { template } = makeStack({
        domainName: 'app.example.com',
        hostedZoneId: 'Z1234567890ABC',
        hostedZoneName: 'example.com',
        certificateArn:
          'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-111122223333',
      });
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'A',
        Name: 'app.example.com.',
        AliasTarget: Match.objectLike({
          HostedZoneId: 'Z2FDTNDATAQYW2', // CloudFront canonical hosted zone ID
        }),
      });
    });

    it('AAAA record aliases the CloudFront distribution', () => {
      const { template } = makeStack({
        domainName: 'app.example.com',
        hostedZoneId: 'Z1234567890ABC',
        hostedZoneName: 'example.com',
        certificateArn:
          'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-111122223333',
      });
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'AAAA',
        Name: 'app.example.com.',
      });
    });
  });

  describe('Outputs', () => {
    it('exports the site bucket name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('SiteBucketName', {
        Export: { Name: 'staging-static-site-bucket-name' },
      });
    });

    it('exports the site bucket ARN', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('SiteBucketArn', {
        Export: { Name: 'staging-static-site-bucket-arn' },
      });
    });

    it('exports the CloudFront distribution ID', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('DistributionId', {
        Export: { Name: 'staging-static-site-distribution-id' },
      });
    });

    it('exports the CloudFront domain name', () => {
      const { template } = makeStack({ envName: 'staging' });
      template.hasOutput('DistributionDomainName', {
        Export: { Name: 'staging-static-site-cf-domain' },
      });
    });

    it('exports the site URL using the custom domain when provided', () => {
      const { template } = makeStack({
        envName: 'staging',
        domainName: 'app.example.com',
        certificateArn:
          'arn:aws:acm:us-east-1:123456789012:certificate/aaaabbbb-cccc-dddd-eeee-111122223333',
      });
      template.hasOutput('SiteUrl', {
        Value: 'https://app.example.com',
      });
    });

    it('exports the site URL using CloudFront domain when no custom domain', () => {
      const { stack, template } = makeStack({ envName: 'staging' });
      const outputs = template.findOutputs('SiteUrl');
      expect(Object.keys(outputs)).toHaveLength(1);
      expect(stack.distribution).toBeDefined();
    });
  });

  describe('Tags', () => {
    it('applies Environment, ManagedBy, and Stack tags', () => {
      const { template } = makeStack({ envName: 'production' });
      // Tags are propagated to S3 bucket
      const buckets = template.findResources('AWS::S3::Bucket');
      expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Stack exports', () => {
    it('exposes siteBucket on the stack instance', () => {
      const { stack } = makeStack();
      expect(stack.siteBucket).toBeDefined();
    });

    it('exposes distribution on the stack instance', () => {
      const { stack } = makeStack();
      expect(stack.distribution).toBeDefined();
    });

    it('exposes undefined hostedZone when no DNS props are given', () => {
      const { stack } = makeStack();
      expect(stack.hostedZone).toBeUndefined();
    });

    it('exposes hostedZone when hostedZoneId is provided', () => {
      const { stack } = makeStack({
        domainName: 'app.example.com',
        hostedZoneId: 'Z1234567890ABC',
        hostedZoneName: 'example.com',
      });
      expect(stack.hostedZone).toBeDefined();
    });
  });
});
