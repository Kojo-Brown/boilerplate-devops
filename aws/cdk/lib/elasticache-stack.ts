import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import { Construct } from 'constructs';

export interface ElastiCacheStackProps extends cdk.StackProps {
  /** VPC from VpcStack (required) */
  readonly vpc: ec2.IVpc;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** Redis engine version (default: '7.1') */
  readonly engineVersion?: string;
  /** ElastiCache node type (default: cache.t3.small) */
  readonly cacheNodeType?: string;
  /** Number of read replicas; 0 = single-node, 1+ enables Multi-AZ failover */
  readonly numReadReplicas?: number;
  /** Override Multi-AZ (default: true when numReadReplicas > 0) */
  readonly multiAzEnabled?: boolean;
  /** Encryption at rest (default: true) */
  readonly atRestEncryptionEnabled?: boolean;
  /** Encryption in transit / TLS (default: true) */
  readonly transitEncryptionEnabled?: boolean;
  /** Automated snapshot retention in days; 0 disables snapshots (default: 7) */
  readonly snapshotRetentionLimit?: number;
  /** Daily snapshot window in UTC (default: '02:00-03:00') */
  readonly snapshotWindow?: string;
  /** Weekly maintenance window in UTC (default: 'sun:03:00-sun:04:00') */
  readonly preferredMaintenanceWindow?: string;
  /** Security groups allowed to connect on port 6379 */
  readonly allowedSecurityGroups?: ec2.ISecurityGroup[];
}

/**
 * ElastiCache Redis replication group (cluster mode disabled) with optional
 * Multi-AZ automatic failover.
 *
 * Architecture:
 *   Private subnets → subnet group → replication group
 *   1 primary node  +  N read replicas (Multi-AZ when N > 0)
 *
 * Security defaults:
 *   - Placed in private subnets (no internet access)
 *   - Security group: no inbound by default; callers supply allowedSecurityGroups
 *   - Encryption at rest and in transit (TLS) enabled
 *   - Auth token disabled — network isolation + SG enforcement is the boundary
 *
 * Resilience defaults (production):
 *   - 1 read replica → automatic failover in ~20 s if primary fails
 *   - Multi-AZ: replica placed in a different AZ from the primary
 *   - Auto minor version upgrades during the maintenance window
 *   - 7-day automated snapshots
 *
 * Resilience defaults (staging / single-node):
 *   - 0 read replicas; Multi-AZ and auto-failover disabled to reduce cost
 */
export class ElastiCacheStack extends cdk.Stack {
  public readonly replicationGroup: elasticache.CfnReplicationGroup;
  public readonly subnetGroup: elasticache.CfnSubnetGroup;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: ElastiCacheStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const engineVersion = props.engineVersion ?? '7.1';
    const cacheNodeType = props.cacheNodeType ?? 'cache.t3.small';
    const numReadReplicas = props.numReadReplicas ?? (envName === 'production' ? 1 : 0);
    const multiAzEnabled = props.multiAzEnabled ?? numReadReplicas > 0;
    const atRestEncryptionEnabled = props.atRestEncryptionEnabled ?? true;
    const transitEncryptionEnabled = props.transitEncryptionEnabled ?? true;
    const snapshotRetentionLimit = props.snapshotRetentionLimit ?? 7;
    const snapshotWindow = props.snapshotWindow ?? '02:00-03:00';
    const preferredMaintenanceWindow =
      props.preferredMaintenanceWindow ?? 'sun:03:00-sun:04:00';

    // Automatic failover requires at least one replica
    const automaticFailoverEnabled = multiAzEnabled && numReadReplicas > 0;

    // Cluster-mode disabled: total nodes = 1 primary + N replicas
    const numCacheClusters = 1 + numReadReplicas;

    // Parameter group family derived from the major engine version (e.g. redis7)
    const parameterGroupFamily = `redis${engineVersion.split('.')[0]}`;

    // ── Security Group ─────────────────────────────────────────────────────────
    this.securityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      securityGroupName: `${envName}-redis-sg`,
      vpc: props.vpc,
      description: `ElastiCache Redis security group for ${envName}`,
      allowAllOutbound: false,
    });

    for (const sg of props.allowedSecurityGroups ?? []) {
      this.securityGroup.addIngressRule(
        sg,
        ec2.Port.tcp(6379),
        'Redis from allowed security group',
      );
    }

    // ── Cache Subnet Group ─────────────────────────────────────────────────────
    this.subnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      cacheSubnetGroupName: `${envName}-redis-subnet-group`,
      description: `ElastiCache Redis private subnet group for ${envName}`,
      subnetIds: props.vpc.privateSubnets.map((s) => s.subnetId),
    });

    // ── Parameter Group ────────────────────────────────────────────────────────
    const parameterGroup = new elasticache.CfnParameterGroup(this, 'RedisParameterGroup', {
      cacheParameterGroupFamily: parameterGroupFamily,
      description: `${envName} Redis parameter group`,
      properties: {
        // Evict keys with an expiry first; safe default for app-level caching
        'maxmemory-policy': 'volatile-lru',
        // Keyspace notifications are expensive; leave off unless required
        'notify-keyspace-events': '',
        // Background deletion avoids latency spikes during eviction/expiry
        'lazyfree-lazy-eviction': 'yes',
        'lazyfree-lazy-expire': 'yes',
        'lazyfree-lazy-server-del': 'yes',
      },
    });

    // ── Replication Group ──────────────────────────────────────────────────────
    this.replicationGroup = new elasticache.CfnReplicationGroup(
      this,
      'RedisReplicationGroup',
      {
        replicationGroupDescription: `${envName} Redis replication group`,
        replicationGroupId: `${envName}-redis`,
        engine: 'redis',
        engineVersion,
        cacheNodeType,
        numCacheClusters,
        automaticFailoverEnabled,
        multiAzEnabled,
        atRestEncryptionEnabled,
        transitEncryptionEnabled,
        port: 6379,
        cacheSubnetGroupName: this.subnetGroup.ref,
        securityGroupIds: [this.securityGroup.securityGroupId],
        cacheParameterGroupName: parameterGroup.ref,
        snapshotRetentionLimit,
        snapshotWindow,
        preferredMaintenanceWindow,
        autoMinorVersionUpgrade: true,
      },
    );

    this.replicationGroup.addDependency(this.subnetGroup);
    this.replicationGroup.addDependency(parameterGroup);

    // ── Tags ───────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ────────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RedisPrimaryEndpoint', {
      value: this.replicationGroup.attrPrimaryEndPointAddress,
      description: 'Redis primary endpoint (write)',
      exportName: `${envName}-redis-primary-endpoint`,
    });

    new cdk.CfnOutput(this, 'RedisPrimaryPort', {
      value: this.replicationGroup.attrPrimaryEndPointPort,
      description: 'Redis primary endpoint port',
      exportName: `${envName}-redis-primary-port`,
    });

    new cdk.CfnOutput(this, 'RedisReaderEndpoint', {
      value: this.replicationGroup.attrReaderEndPointAddress,
      description: 'Redis reader endpoint (for read-heavy workloads)',
      exportName: `${envName}-redis-reader-endpoint`,
    });

    new cdk.CfnOutput(this, 'RedisSecurityGroupId', {
      value: this.securityGroup.securityGroupId,
      description: 'Redis security group ID — add ingress rules from consumer stacks',
      exportName: `${envName}-redis-sg-id`,
    });

    new cdk.CfnOutput(this, 'RedisReplicationGroupId', {
      value: this.replicationGroup.ref,
      description: 'ElastiCache replication group ID',
      exportName: `${envName}-redis-replication-group-id`,
    });
  }
}
