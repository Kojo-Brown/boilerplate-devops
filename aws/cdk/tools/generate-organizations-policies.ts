#!/usr/bin/env node
/**
 * Write the Organizations documents the tag catalogue generates.
 *
 * Two files, both checked in:
 *
 *   policy/organizations/tag-enforcement-scp.json
 *   policy/organizations/cost-allocation-tag-policy.json
 *
 * They are checked in rather than synthesised on demand because nothing in this
 * repository can attach them. An SCP and a tag policy are attached in the
 * organization's *management* account, by hand or by a pipeline that runs
 * there — not by `cdk deploy` into a member account. The file is the artefact
 * someone copies, so it has to exist as a file, be reviewable in a diff, and be
 * the same thing the catalogue says it is.
 *
 * That last part is what `npm run audit:tagging` enforces: the checked-in bytes
 * must equal what this script writes today. A hand-edited SCP that no longer
 * matches `lib/tagging-policy.ts` is the failure this pair is built to prevent,
 * because both halves keep working — the catalogue still validates, the
 * document still attaches, and they govern different things.
 *
 * Usage:
 *   npm run policy:organizations            # write both files
 *   npx ts-node tools/generate-organizations-policies.ts --check   # exit 1 on drift
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildOrganizationsTagPolicy,
  buildTagEnforcementScp,
  serialisePolicy,
} from '../lib/tagging-policy';

/** Repository-relative path → the bytes it should hold. */
export const organizationsPolicyFiles = (): Record<string, string> => ({
  'policy/organizations/tag-enforcement-scp.json': serialisePolicy(buildTagEnforcementScp()),
  'policy/organizations/cost-allocation-tag-policy.json': serialisePolicy(
    buildOrganizationsTagPolicy(),
  ),
});

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const check = process.argv.includes('--check');
  const drifted: string[] = [];

  for (const [relative, contents] of Object.entries(organizationsPolicyFiles())) {
    const absolute = path.join(repoRoot, relative);
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : undefined;

    if (current === contents) continue;

    if (check) {
      drifted.push(relative);
      continue;
    }

    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
    console.log(`${current === undefined ? 'created' : 'updated'} ${relative}`);
  }

  if (drifted.length > 0) {
    console.error(
      `\n${drifted.length} Organizations policy file(s) differ from the catalogue:\n` +
        `${drifted.map((file) => `  ${file}`).join('\n')}\n\n` +
        'Run `npm run policy:organizations` and commit the result. Editing the JSON by hand ' +
        'leaves a document that attaches cleanly and no longer says what lib/tagging-policy.ts ' +
        'says.\n',
    );
    process.exit(1);
  }

  if (!check) console.log('Organizations policy files are up to date.');
}
