# boilerplate-devops — Agent Instructions

## What this repo is
GitHub Actions + AWS CI/CD templates, copy-paste ready. Spec-driven and PR-driven: one `SPEC.md` item per run.

## Your job (scheduled agent, every 4h)
1. `git checkout main && git pull --ff-only origin main`
2. Read `SPEC.md`, take the **first** `- [ ]` item. Phase 0 items always win.
3. `git checkout -b <type>/<kebab-slug>` (`feat`/`fix`/`chore`/`ci`/`docs`)
4. Implement it completely — source, types, tests, docs.
5. Run every gate locally; **all must pass** before pushing:
   ```
   npm ci
   npx tsc --noEmit
   npx checkov -d . --quiet
   npm test
   npx cdk synth
   ```
6. Commit, `git push -u origin <branch>`, then `gh pr create`.
7. `gh pr checks --watch` → **merge only if every check is green**:
   `gh pr merge --squash --delete-branch`
8. Pull main, mark the item `- [x]` in `SPEC.md`, update
   `../PROGRESS.md`, push as a `chore:` commit.

If a check fails, fix forward on the same branch. Never merge red. Never
weaken a test or lower a threshold to force green — if a gate is genuinely
wrong, change it deliberately and say why in the PR.

## Secrets
Never commit real credentials, tokens, keys, or `.env` files. Placeholders in
`.env.example` only; CI reads from the GitHub secret store. Test fixtures must
look obviously fake. Scan `git diff --cached` before every push.

## Conventions
- Reusable workflows in `.github/workflows/`; consumable templates in `workflow-templates/`
- OIDC role assumption only — never long-lived AWS keys
- Every IaC change must `cdk synth` cleanly and pass Checkov
- Least privilege by default; document any wildcard in an IAM policy
- Pin Actions and base images by digest

See `../ROUTINE.md` for the full workflow.
