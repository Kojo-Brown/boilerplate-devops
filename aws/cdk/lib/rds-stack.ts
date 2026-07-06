import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface RdsStackProps extends cdk.StackProps {
  /** VPC from VpcStack (required) */
  readonly vpc: ec2.IVpc;
  /** Environment name used for resource naming and tagging */
  readonly envName?: string;
  /** PostgreSQL database name (default: appdb) */
  readonly databaseName?: string;
  /** RDS instance type (default: t3.medium) */
  readonly instanceType?: ec2.InstanceType;
  /** PostgreSQL engine version (default: VER_16) */
  readonly postgresVersion?: rds.PostgresEngineVersion;
  /** Enable Multi-AZ standby replica (default: true) */
  readonly multiAz?: boolean;
  /** Initial allocated storage in GiB (default: 100) */
  readonly allocatedStorageGiB?: number;
  /** Maximum auto-scaled storage in GiB (default: 500) */
  readonly maxAllocatedStorageGiB?: number;
  /** Automated backup retention in days (default: 7) */
  readonly backupRetentionDays?: number;
  /** Secret rotation interval in days (default: 30) */
  readonly secretRotationDays?: number;
  /** Security groups permitted to connect on port 5432 */
  readonly allowedSecurityGroups?: ec2.ISecurityGroup[];
  /** Override deletion protection (defaults to true in production) */
  readonly deletionProtection?: boolean;
}

/**
 * RDS PostgreSQL (Multi-AZ) instance with Secrets Manager automatic rotation.
 *
 * Architecture:
 *   Private subnets → DB subnet group (isolated from internet)
 *   Secrets Manager stores & rotates the master password every N days
 *   Rotation Lambda placed in the same private subnets; reaches SM via NAT
 *
 * Security defaults:
 *   - Storage encrypted (AWS-managed KMS key)
 *   - IAM database authentication enabled
 *   - Deletion protection on in production; snapshot on destroy elsewhere
 *   - No inbound rules by default — callers supply allowedSecurityGroups
 *
 * Observability:
 *   - Performance Insights (7-day retention)
 *   - postgresql + upgrade logs shipped to CloudWatch (30-day retention)
 *   - Parameter group enables slow-query logging (>1 s) and pg_stat_statements
 */
export class RdsStack extends cdk.Stack {
  public readonly instance: rds.DatabaseInstance;
  public readonly secret: secretsmanager.ISecret;
  public readonly securityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: RdsStackProps) {
    super(scope, id, props);

    const envName = props.envName ?? 'production';
    const databaseName = props.databaseName ?? 'appdb';
    const multiAz = props.multiAz ?? true;
    const allocatedStorageGiB = props.allocatedStorageGiB ?? 100;
    const maxAllocatedStorageGiB = props.maxAllocatedStorageGiB ?? 500;
    const backupRetentionDays = props.backupRetentionDays ?? 7;
    const secretRotationDays = props.secretRotationDays ?? 30;
    const deletionProtection = props.deletionProtection ?? envName === 'production';
    const instanceType =
      props.instanceType ??
      ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);
    const postgresVersion = props.postgresVersion ?? rds.PostgresEngineVersion.VER_16;
    const engine = rds.DatabaseInstanceEngine.postgres({ version: postgresVersion });

    // ── Security Group ────────────────────────────────────────────────────────
    this.securityGroup = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      securityGroupName: `${envName}-rds-sg`,
      vpc: props.vpc,
      description: `RDS PostgreSQL security group for ${envName}`,
      allowAllOutbound: false,
    });

    for (const sg of props.allowedSecurityGroups ?? []) {
      this.securityGroup.addIngressRule(
        sg,
        ec2.Port.tcp(5432),
        'PostgreSQL from allowed security group',
      );
    }

    // ── Master Credentials (Secrets Manager) ──────────────────────────────────
    const masterSecret = new secretsmanager.Secret(this, 'RdsMasterSecret', {
      secretName: `/${envName}/rds/master-credentials`,
      description: `RDS master credentials for the ${envName} PostgreSQL instance`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 32,
      },
      removalPolicy: deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
    });

    this.secret = masterSecret;

    // ── Parameter Group ───────────────────────────────────────────────────────
    const parameterGroup = new rds.ParameterGroup(this, 'ParameterGroup', {
      engine,
      description: `${envName} PostgreSQL parameters`,
      parameters: {
        log_connections: '1',
        log_disconnections: '1',
        log_min_duration_statement: '1000', // log queries slower than 1 s
        shared_preload_libraries: 'pg_stat_statements',
      },
    });

    // ── RDS PostgreSQL Instance ───────────────────────────────────────────────
    this.instance = new rds.DatabaseInstance(this, 'RdsInstance', {
      instanceIdentifier: `${envName}-postgres`,
      engine,
      instanceType,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.securityGroup],
      multiAz,
      allocatedStorage: allocatedStorageGiB,
      maxAllocatedStorage: maxAllocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      databaseName,
      credentials: rds.Credentials.fromSecret(masterSecret),
      backupRetention: cdk.Duration.days(backupRetentionDays),
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      autoMinorVersionUpgrade: true,
      deletionProtection,
      removalPolicy: deletionProtection
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.SNAPSHOT,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      parameterGroup,
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      iamAuthentication: true,
    });

    // ── Automatic Secret Rotation ─────────────────────────────────────────────
    // CDK creates a rotation Lambda in private subnets; it reaches Secrets
    // Manager via the NAT Gateway and connects to RDS via the security group
    // ingress rule that addRotationSingleUser() adds automatically.
    this.instance.addRotationSingleUser({
      automaticallyAfter: cdk.Duration.days(secretRotationDays),
    });

    // ── Tags ──────────────────────────────────────────────────────────────────
    cdk.Tags.of(this).add('Environment', envName);
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('Stack', id);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'RdsEndpoint', {
      value: this.instance.instanceEndpoint.hostname,
      description: 'RDS PostgreSQL endpoint hostname',
      exportName: `${envName}-rds-endpoint`,
    });

    new cdk.CfnOutput(this, 'RdsPort', {
      value: cdk.Token.asString(this.instance.instanceEndpoint.port),
      description: 'RDS PostgreSQL port',
      exportName: `${envName}-rds-port`,
    });

    new cdk.CfnOutput(this, 'RdsSecretArn', {
      value: masterSecret.secretArn,
      description: 'Secrets Manager ARN for RDS master credentials',
      exportName: `${envName}-rds-secret-arn`,
    });

    new cdk.CfnOutput(this, 'RdsDatabaseName', {
      value: databaseName,
      description: 'PostgreSQL database name',
      exportName: `${envName}-rds-database-name`,
    });

    new cdk.CfnOutput(this, 'RdsInstanceId', {
      value: this.instance.instanceIdentifier,
      description: 'RDS instance identifier',
      exportName: `${envName}-rds-instance-id`,
    });
  }
}
