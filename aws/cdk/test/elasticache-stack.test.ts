import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { VpcStack } from '../lib/vpc-stack';
import { ElastiCacheStack, ElastiCacheStackProps } from '../lib/elasticache-stack';

const makeStacks = (props: Partial<ElastiCacheStackProps> = {}) => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpcStack', {
    envName: 'test',
    maxAzs: 2,
    natGateways: 1,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const stack = new ElastiCacheStack(app, 'TestElastiCacheStack', {
    vpc: vpcStack.vpc,
    envName: 'test',
    env: { account: '123456789012', region: 'us-east-1' },
    ...props,
  });
  return { template: Template.fromStack(stack), stack, vpcStack };
};

describe('ElastiCacheStack', () => {
  describe('Security Group', () => {
    it('creates a security group for Redis', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupDescription: Match.stringLikeRegexp('ElastiCache Redis'),
      });
    });

    it('names the security group with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::EC2::SecurityGroup', {
        GroupName: 'staging-redis-sg',
      });
    });

    it('does not allow all outbound by default', () => {
      const { template } = makeStacks();
      const sgs = template.findResources('AWS::EC2::SecurityGroup', {
        Properties: Match.objectLike({ GroupName: Match.stringLikeRegexp('redis') }),
      });
      const sg = Object.values(sgs)[0] as { Properties: Record<string, unknown> };
      expect(sg.Properties['SecurityGroupEgress']).toBeUndefined();
    });

    it('adds a port-6379 ingress rule for each allowed security group', () => {
      const app = new cdk.App();
      const vpcStack = new VpcStack(app, 'VpcStack', {
        envName: 'test',
        maxAzs: 2,
        natGateways: 1,
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const allowedSg = new ec2.SecurityGroup(vpcStack, 'AllowedSg', {
        vpc: vpcStack.vpc,
        description: 'test consumer sg',
      });
      const stack = new ElastiCacheStack(app, 'ElastiCacheStack', {
        vpc: vpcStack.vpc,
        envName: 'test',
        allowedSecurityGroups: [allowedSg],
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        FromPort: 6379,
        ToPort: 6379,
        IpProtocol: 'tcp',
      });
    });
  });

  describe('Cache Subnet Group', () => {
    it('creates exactly one cache subnet group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElastiCache::SubnetGroup', 1);
    });

    it('names the subnet group with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElastiCache::SubnetGroup', {
        CacheSubnetGroupName: 'staging-redis-subnet-group',
      });
    });

    it('places the subnet group in private subnets', () => {
      const { template } = makeStacks();
      const subnetGroups = template.findResources('AWS::ElastiCache::SubnetGroup');
      const subnetGroup = Object.values(subnetGroups)[0] as {
        Properties: { SubnetIds: unknown[] };
      };
      expect(subnetGroup.Properties.SubnetIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Parameter Group', () => {
    it('creates exactly one cache parameter group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElastiCache::ParameterGroup', 1);
    });

    it('uses the redis7 family for engine version 7.1', () => {
      const { template } = makeStacks({ engineVersion: '7.1' });
      template.hasResourceProperties('AWS::ElastiCache::ParameterGroup', {
        CacheParameterGroupFamily: 'redis7',
      });
    });

    it('sets maxmemory-policy to volatile-lru', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ParameterGroup', {
        Properties: Match.objectLike({ 'maxmemory-policy': 'volatile-lru' }),
      });
    });

    it('enables lazy eviction and lazy expire', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ParameterGroup', {
        Properties: Match.objectLike({
          'lazyfree-lazy-eviction': 'yes',
          'lazyfree-lazy-expire': 'yes',
          'lazyfree-lazy-server-del': 'yes',
        }),
      });
    });

    it('disables keyspace notifications by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ParameterGroup', {
        Properties: Match.objectLike({ 'notify-keyspace-events': '' }),
      });
    });
  });

  describe('Replication Group — resource existence', () => {
    it('creates exactly one replication group', () => {
      const { template } = makeStacks();
      template.resourceCountIs('AWS::ElastiCache::ReplicationGroup', 1);
    });

    it('uses the Redis engine', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        Engine: 'redis',
      });
    });

    it('sets the replication group ID with the env prefix', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        ReplicationGroupId: 'staging-redis',
      });
    });

    it('defaults to engine version 7.1', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        EngineVersion: '7.1',
      });
    });

    it('respects a custom engine version', () => {
      const { template } = makeStacks({ engineVersion: '7.0' });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        EngineVersion: '7.0',
      });
    });

    it('defaults to cache.t3.small node type', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        CacheNodeType: 'cache.t3.small',
      });
    });

    it('respects a custom node type', () => {
      const { template } = makeStacks({ cacheNodeType: 'cache.r7g.large' });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        CacheNodeType: 'cache.r7g.large',
      });
    });

    it('enables auto minor version upgrades', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        AutoMinorVersionUpgrade: true,
      });
    });

    it('listens on port 6379', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        Port: 6379,
      });
    });
  });

  describe('Replication Group — encryption', () => {
    it('enables encryption at rest by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        AtRestEncryptionEnabled: true,
      });
    });

    it('enables in-transit encryption by default', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        TransitEncryptionEnabled: true,
      });
    });

    it('can disable at-rest encryption', () => {
      const { template } = makeStacks({ atRestEncryptionEnabled: false });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        AtRestEncryptionEnabled: false,
      });
    });

    it('can disable in-transit encryption', () => {
      const { template } = makeStacks({ transitEncryptionEnabled: false });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        TransitEncryptionEnabled: false,
      });
    });
  });

  describe('Replication Group — single-node (staging default)', () => {
    it('creates 1 cache cluster when numReadReplicas is 0', () => {
      const { template } = makeStacks({ numReadReplicas: 0 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        NumCacheClusters: 1,
      });
    });

    it('disables automatic failover for single-node', () => {
      const { template } = makeStacks({ numReadReplicas: 0 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        AutomaticFailoverEnabled: false,
      });
    });

    it('disables Multi-AZ for single-node', () => {
      const { template } = makeStacks({ numReadReplicas: 0 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        MultiAZEnabled: false,
      });
    });
  });

  describe('Replication Group — Multi-AZ (production default)', () => {
    it('creates 2 cache clusters when numReadReplicas is 1', () => {
      const { template } = makeStacks({ numReadReplicas: 1 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        NumCacheClusters: 2,
      });
    });

    it('enables automatic failover when numReadReplicas > 0', () => {
      const { template } = makeStacks({ numReadReplicas: 1 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        AutomaticFailoverEnabled: true,
      });
    });

    it('enables Multi-AZ when numReadReplicas > 0', () => {
      const { template } = makeStacks({ numReadReplicas: 1 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        MultiAZEnabled: true,
      });
    });

    it('supports multiple read replicas', () => {
      const { template } = makeStacks({ numReadReplicas: 2 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        NumCacheClusters: 3,
      });
    });
  });

  describe('Replication Group — snapshots', () => {
    it('defaults to 7-day snapshot retention', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        SnapshotRetentionLimit: 7,
      });
    });

    it('respects a custom snapshot retention', () => {
      const { template } = makeStacks({ snapshotRetentionLimit: 14 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        SnapshotRetentionLimit: 14,
      });
    });

    it('can disable snapshots by setting retention to 0', () => {
      const { template } = makeStacks({ snapshotRetentionLimit: 0 });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        SnapshotRetentionLimit: 0,
      });
    });

    it('defaults to the 02:00-03:00 UTC snapshot window', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        SnapshotWindow: '02:00-03:00',
      });
    });

    it('defaults to the Sunday 03:00-04:00 UTC maintenance window', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        PreferredMaintenanceWindow: 'sun:03:00-sun:04:00',
      });
    });
  });

  describe('CloudFormation Outputs', () => {
    it('exports the primary endpoint', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RedisPrimaryEndpoint', {
        Export: { Name: 'test-redis-primary-endpoint' },
      });
    });

    it('exports the primary port', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RedisPrimaryPort', {
        Export: { Name: 'test-redis-primary-port' },
      });
    });

    it('exports the reader endpoint', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RedisReaderEndpoint', {
        Export: { Name: 'test-redis-reader-endpoint' },
      });
    });

    it('exports the security group ID', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RedisSecurityGroupId', {
        Export: { Name: 'test-redis-sg-id' },
      });
    });

    it('exports the replication group ID', () => {
      const { template } = makeStacks({ envName: 'test' });
      template.hasOutput('RedisReplicationGroupId', {
        Export: { Name: 'test-redis-replication-group-id' },
      });
    });
  });

  describe('Tags', () => {
    it('tags replication group with the environment name', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'Environment', Value: 'staging' }),
        ]),
      });
    });

    it('tags replication group as ManagedBy CDK', () => {
      const { template } = makeStacks();
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        Tags: Match.arrayWith([
          Match.objectLike({ Key: 'ManagedBy', Value: 'CDK' }),
        ]),
      });
    });
  });

  describe('envName-driven defaults', () => {
    it('defaults to 1 read replica for production envName', () => {
      const { template } = makeStacks({ envName: 'production' });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        NumCacheClusters: 2,
        MultiAZEnabled: true,
        AutomaticFailoverEnabled: true,
      });
    });

    it('defaults to 0 read replicas for non-production envName', () => {
      const { template } = makeStacks({ envName: 'staging' });
      template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        NumCacheClusters: 1,
        MultiAZEnabled: false,
        AutomaticFailoverEnabled: false,
      });
    });
  });
});
