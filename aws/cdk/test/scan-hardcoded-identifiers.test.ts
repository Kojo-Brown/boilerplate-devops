import * as path from 'path';
import {
  RESERVED_EXAMPLE_ACCOUNT_IDS,
  collectFiles,
  formatFindings,
  scanContent,
  scanDirectory,
} from '../tools/scan-hardcoded-identifiers';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Fixtures are assembled from fragments so no line in this file ever contains a
// complete credential-shaped literal. That keeps the suite honest against the
// very scanner it tests: the repository-wide scan below reads this file too, and
// a fixture that tripped it would have to be suppressed, which would mean the
// gate no longer proves what it claims.
const fakeAccessKeyId = `AKIA${'J7QK4XN2WD5HR8VB'}`;
const fakeGitHubToken = `ghp_${'0Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx'}`;
const fakeSlackToken = `xoxb-${'2417839265-placeholdervalue'}`;
const fakePemHeader = `-----BEGIN ${'RSA '}PRIVATE KEY-----`;

// Exactly 40 characters from the secret-access-key charset, which is all the
// rule keys on. An earlier version of this fixture mutated the tail of AWS's
// published example key; it was inert, but it carried the entropy profile of a
// live key and GitGuardian flagged it on PR #21 — correctly, since a scanner
// cannot know a realistic-looking key is fake. Low entropy exercises the length
// and charset constraints identically, so nothing is given up by being obvious.
const fakeSecretAccessKey = 'fakeAwsSecretKeyForTestingOnly'.padEnd(40, '0');

// Not in RESERVED_EXAMPLE_ACCOUNT_IDS — these stand in for a real tenant's ID,
// and so are assembled in pieces for the same reason as the fixtures above.
const realLookingAccountId = ['4091', '8372', '6554'].join('');
const secondAccountId = ['3084', '7261', '9354'].join('');

describe('scanContent', () => {
  describe('aws-account-id', () => {
    it('flags an account ID that is not a reserved example', () => {
      const findings = scanContent('lib/example-stack.ts', `const account = '${realLookingAccountId}';`);

      expect(findings).toEqual([
        expect.objectContaining({
          file: 'lib/example-stack.ts',
          line: 1,
          rule: 'aws-account-id',
          match: realLookingAccountId,
        }),
      ]);
    });

    it('allows every reserved example account ID', () => {
      const content = RESERVED_EXAMPLE_ACCOUNT_IDS.map((id) => `account: '${id}',`).join('\n');

      expect(scanContent('bin/app.ts', content)).toEqual([]);
    });

    it('flags an account ID embedded in an ARN', () => {
      const arn = `arn:aws:iam::${realLookingAccountId}:role/deploy`;
      const findings = scanContent('workflow-templates/deploy.yml', `          role-to-assume: ${arn}`);

      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('aws-account-id');
    });

    it('flags an account ID embedded in an ECR image URI', () => {
      const uri = `${realLookingAccountId}.dkr.ecr.us-east-1.amazonaws.com/app:latest`;

      expect(scanContent('bin/app.ts', `image: '${uri}',`)).toHaveLength(1);
    });

    it('leaves ARNs that carry no account ID alone', () => {
      const content = [
        "resources: ['arn:aws:s3:::my-bucket/*'],",
        'resources: [`arn:aws:ssm:*:*:parameter/app/${envName}/*`],',
        'const arn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;',
      ].join('\n');

      expect(scanContent('lib/github-oidc-stack.ts', content)).toEqual([]);
    });

    it('does not match digit runs longer or shorter than twelve', () => {
      const content = ['const eleven = 12345678901;', 'const thirteen = 1234567890123;'].join('\n');

      expect(scanContent('lib/example-stack.ts', content)).toEqual([]);
    });

    it('reports every occurrence on a line', () => {
      const findings = scanContent(
        'lib/example-stack.ts',
        `const ids = ['${realLookingAccountId}', '${secondAccountId}'];`,
      );

      expect(findings.map((f) => f.match)).toEqual([realLookingAccountId, secondAccountId]);
    });

    it('skips generated manifests, whose digit runs are meaningless here', () => {
      const content = `"resolved": "https://registry.npmjs.org/x/-/x-${realLookingAccountId}.tgz"`;

      expect(scanContent('aws/cdk/package-lock.json', content)).toEqual([]);
      expect(scanContent('.checkov.baseline', content)).toEqual([]);
    });
  });

  describe('credentials', () => {
    it('flags an AWS access key ID', () => {
      const findings = scanContent('.github/workflows/deploy.yml', `  AWS_ACCESS_KEY_ID: ${fakeAccessKeyId}`);

      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('aws-access-key-id');
    });

    it('allows the AWS documentation example key, which is published', () => {
      expect(scanContent('README.md', `AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`)).toEqual([]);
    });

    it('flags an AWS secret access key assignment', () => {
      const findings = scanContent('.env', `aws_secret_access_key = "${fakeSecretAccessKey}"`);

      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('aws-secret-access-key');
    });

    it('does not flag a value too short to be a secret access key', () => {
      const tooShort = fakeSecretAccessKey.slice(0, 39);

      expect(scanContent('.env', `aws_secret_access_key = "${tooShort}"`)).toEqual([]);
    });

    it('allows the AWS documentation example secret key', () => {
      const content = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';

      expect(scanContent('README.md', content)).toEqual([]);
    });

    it('flags a PEM private key block', () => {
      const findings = scanContent('aws/cdk/lib/example-stack.ts', `const key = '${fakePemHeader}';`);

      expect(findings).toHaveLength(1);
      expect(findings[0].rule).toBe('private-key');
    });

    it('flags GitHub and Slack tokens', () => {
      const content = [`token: ${fakeGitHubToken}`, `webhook: ${fakeSlackToken}`].join('\n');
      const findings = scanContent('workflow-templates/notify.yml', content);

      expect(findings.map((f) => f.rule)).toEqual(['provider-token', 'provider-token']);
    });

    it('leaves secret-store references alone', () => {
      const content = [
        '  AWS_ROLE_ARN: ${{ secrets.AWS_ROLE_ARN }}',
        '  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      ].join('\n');

      expect(scanContent('workflow-templates/deploy.yml', content)).toEqual([]);
    });

    it('applies credential rules to generated manifests too', () => {
      const content = `"_authToken": "${fakeGitHubToken}"`;

      expect(scanContent('aws/cdk/package-lock.json', content)).toHaveLength(1);
    });

    it('redacts the matched value so the report never reprints a live secret', () => {
      const [finding] = scanContent('.github/workflows/deploy.yml', `key: ${fakeAccessKeyId}`);

      expect(finding.match).not.toContain(fakeAccessKeyId);
      expect(finding.match).toContain('AKIAJ7');
    });
  });

  describe('inline suppression', () => {
    it('honours `scan-allow: <rule> <reason>` on the offending line', () => {
      const content = `const account = '${realLookingAccountId}'; // scan-allow: aws-account-id documented in ADR-4`;

      expect(scanContent('lib/example-stack.ts', content)).toEqual([]);
    });

    it('rejects a suppression with no reason', () => {
      const content = `const account = '${realLookingAccountId}'; // scan-allow: aws-account-id`;

      expect(scanContent('lib/example-stack.ts', content)).toHaveLength(1);
    });

    it('does not suppress a different rule', () => {
      const content = `key: ${fakeAccessKeyId} # scan-allow: aws-account-id wrong rule id`;

      expect(scanContent('workflow-templates/deploy.yml', content)).toHaveLength(1);
    });

    it('does not leak to neighbouring lines', () => {
      const content = [
        `const a = '${realLookingAccountId}'; // scan-allow: aws-account-id documented in ADR-4`,
        `const b = '${realLookingAccountId}';`,
      ].join('\n');

      expect(scanContent('lib/example-stack.ts', content)).toEqual([
        expect.objectContaining({ line: 2 }),
      ]);
    });
  });
});

describe('formatFindings', () => {
  it('renders one locatable line per finding plus its remediation', () => {
    const output = formatFindings(scanContent('bin/app.ts', `account: '${realLookingAccountId}'`));

    expect(output).toContain('bin/app.ts:1');
    expect(output).toContain('[aws-account-id]');
    expect(output).toContain('CDK_DEFAULT_ACCOUNT');
  });
});

describe('collectFiles', () => {
  it('walks the repository without descending into generated directories', () => {
    const files = collectFiles(REPO_ROOT);

    expect(files).toContain(path.join('workflow-templates', 'deploy-ecs.yml'));
    expect(files).toContain(path.join('aws', 'cdk', 'bin', 'app.ts'));
    expect(files.some((file) => file.split(path.sep).includes('node_modules'))).toBe(false);
    expect(files.some((file) => file.split(path.sep).includes('.git'))).toBe(false);
    expect(files.some((file) => file.split(path.sep).includes('cdk.out'))).toBe(false);
  });
});

// The Phase 0 spec item this scanner was written for — "verify no template
// contains a hardcoded account id, ARN, or credential" — is only verified for
// as long as something keeps checking. This is that something.
describe('the repository itself', () => {
  it('contains no hardcoded account IDs, ARNs, or credentials', () => {
    expect(formatFindings(scanDirectory(REPO_ROOT))).toBe('');
  });
});
