#!/usr/bin/env node
/**
 * Scan the repository for hardcoded AWS account IDs, ARNs, and credentials.
 *
 * Everything in this repository is copy-paste material: a workflow template, a
 * CDK stack, or a tracing snippet is meant to be lifted into someone else's
 * account. A literal account ID that survives the copy is both a small
 * information leak and a deployment that silently targets the wrong account, and
 * a literal credential is an incident. Both classes are cheap to catch
 * mechanically and expensive to catch by review, so this runs as a CI gate.
 *
 * Scope, deliberately narrow:
 *
 *   • Account IDs and the ARNs that embed them. Only the AWS documentation
 *     account IDs are permitted — see RESERVED_EXAMPLE_ACCOUNT_IDS. Any other
 *     twelve-digit identifier is treated as real. ARNs are covered by the same
 *     rule because the account field is the only part of an ARN that identifies
 *     a real tenant; `arn:aws:s3:::my-bucket/*` gives nothing away.
 *
 *   • Credentials with an unambiguous shape — AWS key IDs, PEM private keys,
 *     and the provider token prefixes that are structurally identifiable.
 *
 * Entropy-based detection of secrets that have no distinctive shape is
 * TruffleHog's job, not this script's; see `workflow-templates/secret-scanning.yml`.
 * Duplicating it here with a homegrown heuristic would trade a well-tuned
 * detector for a noisy one.
 *
 * Usage:
 *   npm run scan:identifiers            # scans the repository root
 *   npx ts-node tools/scan-hardcoded-identifiers.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * Account IDs AWS reserves for documentation and examples. These are not real
 * tenants, and every placeholder in this repository uses one of them.
 * Source: AWS documentation conventions — the same IDs appear throughout the
 * AWS service guides and IAM policy examples.
 */
export const RESERVED_EXAMPLE_ACCOUNT_IDS: readonly string[] = [
  '012345678901',
  '111111111111',
  '111122223333',
  '123456789012',
  '222222222222',
  '333333333333',
  '444455556666',
  '444444444444',
  '555555555555',
  '666666666666',
  '777777777777',
  '777788889999',
  '888888888888',
  '999999999999',
];

export type RuleId =
  | 'aws-account-id'
  | 'aws-access-key-id'
  | 'aws-secret-access-key'
  | 'private-key'
  | 'provider-token';

export interface Finding {
  /** Path of the offending file, relative to the scan root. */
  readonly file: string;
  /** One-based line number. */
  readonly line: number;
  readonly rule: RuleId;
  /** The matched text, truncated so a real secret is never echoed in full. */
  readonly match: string;
  readonly message: string;
}

interface Rule {
  readonly id: RuleId;
  /** Must carry the `g` flag; `lastIndex` is reset before every use. */
  readonly pattern: RegExp;
  readonly message: string;
  /** Matches this returns true for are documented examples, not real values. */
  readonly isExample?: (match: string) => boolean;
  /**
   * Files this rule does not apply to. Only the account-ID rule opts out of
   * anything: generated manifests carry long digit runs that mean nothing here,
   * while a credential in a generated file is still a credential.
   */
  readonly skipFile?: (relativePath: string) => boolean;
}

/** Lockfiles and scanner baselines: machine-generated, digit-dense, reviewed by tooling. */
const isGeneratedManifest = (relativePath: string): boolean => {
  const base = path.basename(relativePath);
  return base === 'package-lock.json' || base === '.checkov.baseline';
};

/**
 * AWS suffixes its published example credentials with `EXAMPLE`
 * (`AKIAIOSFODNN7EXAMPLE`, `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY`). Real
 * keys are random, so the convention is a reliable discriminator.
 */
const isAwsDocumentationExample = (match: string): boolean => match.includes('EXAMPLE');

export const RULES: readonly Rule[] = [
  {
    id: 'aws-account-id',
    // Bounded by non-digits rather than word boundaries so that IDs embedded in
    // ARNs, ECR image URIs, and hyphenated identifiers are still caught.
    pattern: /(?<!\d)\d{12}(?!\d)/g,
    message:
      'hardcoded AWS account ID — use process.env.CDK_DEFAULT_ACCOUNT, a stack ' +
      'token, or one of the reserved example IDs',
    isExample: (match) => RESERVED_EXAMPLE_ACCOUNT_IDS.includes(match),
    skipFile: isGeneratedManifest,
  },
  {
    id: 'aws-access-key-id',
    // The unique-identifier prefixes AWS assigns per principal type.
    pattern: /\b(?:AKIA|ASIA|AROA|AIDA|AGPA|AIPA|ANPA|ANVA|ABIA|ACCA)[A-Z0-9]{16}\b/g,
    message: 'AWS access key ID — this repository uses OIDC role assumption, never static keys',
    isExample: isAwsDocumentationExample,
  },
  {
    id: 'aws-secret-access-key',
    pattern: /aws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
    message: 'AWS secret access key — this repository uses OIDC role assumption, never static keys',
    isExample: isAwsDocumentationExample,
  },
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    message: 'PEM private key block — keep private keys in Secrets Manager, never in git',
  },
  {
    id: 'provider-token',
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
    message: 'provider access token — read it from the GitHub secret store at runtime',
  },
];

/**
 * Inline suppression: `scan-allow: <rule-id> <reason>` on the offending line.
 *
 * The reason is mandatory. A suppression without one is indistinguishable from
 * someone silencing the scanner to get a push through, which is exactly what
 * this gate exists to prevent.
 */
const suppressionFor = (line: string, rule: RuleId): boolean => {
  const match = new RegExp(`scan-allow:\\s*${rule}\\s+(\\S.*)$`).exec(line);
  return match !== null && match[1].trim().length > 0;
};

/** Show enough of a match to locate it without reprinting a live credential. */
const redact = (match: string, rule: RuleId): string =>
  rule === 'aws-account-id' ? match : `${match.slice(0, 6)}…(${match.length} chars)`;

/** Scan one file's contents. Pure — the unit tests drive this directly. */
export const scanContent = (relativePath: string, content: string): Finding[] => {
  const findings: Finding[] = [];
  const lines = content.split('\n');

  for (const rule of RULES) {
    if (rule.skipFile?.(relativePath)) continue;

    lines.forEach((line, index) => {
      rule.pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = rule.pattern.exec(line)) !== null) {
        // Capture group 1 when present (assignment rules match the whole
        // `key = value` expression but only the value is the secret).
        const value = match[1] ?? match[0];

        // Zero-width matches would loop forever; no rule produces one today,
        // but a future pattern edit should fail loudly rather than hang CI.
        if (match[0].length === 0) {
          throw new Error(`rule ${rule.id} produced a zero-width match`);
        }

        if (rule.isExample?.(value)) continue;
        if (suppressionFor(line, rule.id)) continue;

        findings.push({
          file: relativePath,
          line: index + 1,
          rule: rule.id,
          match: redact(value, rule.id),
          message: rule.message,
        });
      }
    });
  }

  return findings;
};

/** Directories with nothing hand-written in them. */
const SKIPPED_DIRECTORIES: readonly string[] = [
  '.git',
  'node_modules',
  'cdk.out',
  '.cdk.staging',
  'dist',
  'coverage',
  '__pycache__',
];

/** Heuristic: a NUL byte in the first block means the file is not source. */
const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0);

/** Every scannable file under `root`, as paths relative to it. */
export const collectFiles = (root: string, directory: string = root): string[] => {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.includes(entry.name)) continue;
      files.push(...collectFiles(root, absolute));
      continue;
    }

    if (!entry.isFile()) continue;
    files.push(path.relative(root, absolute));
  }

  return files.sort();
};

/** Scan a directory tree. Returns findings ordered by file, then line. */
export const scanDirectory = (root: string): Finding[] => {
  const findings: Finding[] = [];

  for (const relativePath of collectFiles(root)) {
    const buffer = fs.readFileSync(path.join(root, relativePath));
    if (isBinary(buffer)) continue;
    findings.push(...scanContent(relativePath, buffer.toString('utf8')));
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};

export const formatFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.file}:${f.line}  [${f.rule}]  ${f.match}\n    ${f.message}`).join('\n');

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  // Default to the repository root so the script behaves the same wherever it
  // is invoked from: tools/ → aws/cdk/ → aws/ → repo root.
  const root = path.resolve(process.argv[2] ?? path.join(__dirname, '..', '..', '..'));
  const findings = scanDirectory(root);

  if (findings.length > 0) {
    console.error(`\n${findings.length} hardcoded identifier(s) found in ${root}:\n`);
    console.error(formatFindings(findings));
    console.error(
      '\nIf a match is a deliberate placeholder, use a reserved example account ID ' +
        'or add `scan-allow: <rule-id> <reason>` to the line.\n',
    );
    process.exit(1);
  }

  console.log(`No hardcoded account IDs, ARNs, or credentials found in ${root}.`);
}
