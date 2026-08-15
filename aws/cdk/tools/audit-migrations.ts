#!/usr/bin/env node
/**
 * Audit SQL migrations for expand/contract safety.
 *
 * A deployment is not atomic. For a window that lasts from seconds (rolling) to
 * an hour (canary), the old code and the new code are both serving traffic
 * against one database. In this repository the window is wider than most teams
 * assume, because `DbMigrationStack` runs migrations from CodeDeploy's
 * *BeforeAllowTraffic* hook — the schema changes while **only the old code is
 * running**. A migration that requires the new code to already be deployed will
 * take production down before the deployment it belongs to has shifted a single
 * request.
 *
 * Expand/contract is the discipline that makes that window survivable: every
 * schema change is decomposed into an additive step that the old code does not
 * notice, and a destructive step that ships once no running code refers to the
 * thing being removed. The two steps are separate deployments, usually several
 * releases apart. See `docs/expand-contract-migrations.md`.
 *
 * The discipline is easy to state and easy to violate by accident, because the
 * violations look like ordinary SQL and fail only under load, only in
 * production, and only during the deployment. That is what this script exists
 * to catch. It is not a SQL linter — it does not care about style, and it does
 * not parse SQL into a full syntax tree. It classifies statements as additive or
 * destructive, reads the phase each migration declares about itself, and reports
 * where the two disagree.
 *
 * The rules, and the production failure each one prevents:
 *
 *   missing-header                  nobody can tell which phase a file is
 *   header-name-mismatch            a copy-pasted header describing another file
 *   unknown-phase                   a phase outside the vocabulary
 *   duplicate-sequence              two migrations claiming one ordinal
 *   mixed-phase                     expand and contract in one deployment, so
 *                                   there is no release where a rollback is safe
 *   phase-mismatch                  the file does something its phase forbids
 *   contract-without-safe-after     a drop with no record of what stopped using it
 *   irreversible-rename             no window exists where old and new both work
 *   in-place-type-change            full table rewrite under ACCESS EXCLUSIVE
 *   not-null-without-default        old code's INSERTs start failing immediately
 *   set-not-null-full-scan          full scan under ACCESS EXCLUSIVE
 *   index-without-concurrently      writes blocked for the length of the build
 *   concurrent-index-in-transaction the migration aborts at runtime
 *   unvalidated-constraint          full scan under ACCESS EXCLUSIVE
 *   constraint-never-validated      a NOT VALID constraint nothing ever validated
 *   unbounded-backfill              one transaction over the whole table
 *   unbatched-backfill              a backfill with no batch bound
 *
 * Statements inside dollar-quoted bodies (`DO $$ ... $$`, function bodies) are
 * analysed too. A `DROP TABLE` is no less destructive for being wrapped in
 * PL/pgSQL, and a backfill loop is *only* ever written that way.
 *
 * Dialect: PostgreSQL. The locking rules encoded here are Postgres' — `ADD
 * COLUMN ... DEFAULT` is metadata-only from 11, `SET NOT NULL` can skip its scan
 * from 12 given a validated CHECK, and `CREATE INDEX CONCURRENTLY` cannot run
 * in a transaction block in any version.
 *
 * Usage:
 *   npm run audit:migrations                             # db/migrations
 *   npx ts-node tools/audit-migrations.ts <dir>
 *
 * Exits non-zero when anything is found.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Where migrations live, relative to the repository root. */
export const DEFAULT_MIGRATIONS_DIR = path.posix.join('db', 'migrations');

export type Phase = 'baseline' | 'expand' | 'backfill' | 'contract';

export const PHASES: readonly Phase[] = ['baseline', 'expand', 'backfill', 'contract'];

export type FindingRule =
  | 'missing-header'
  | 'header-name-mismatch'
  | 'unknown-phase'
  | 'duplicate-sequence'
  | 'mixed-phase'
  | 'phase-mismatch'
  | 'contract-without-safe-after'
  | 'irreversible-rename'
  | 'in-place-type-change'
  | 'not-null-without-default'
  | 'set-not-null-full-scan'
  | 'index-without-concurrently'
  | 'concurrent-index-in-transaction'
  | 'unvalidated-constraint'
  | 'constraint-never-validated'
  | 'unbounded-backfill'
  | 'unbatched-backfill';

export interface Finding {
  readonly rule: FindingRule;
  /** Path of the offending migration, as the reader would type it. */
  readonly file: string;
  /** One-based line number of the statement or header key at fault. */
  readonly line: number;
  readonly message: string;
}

/** One SQL statement, in both the form a human reads and the form we match on. */
export interface Statement {
  /** Verbatim source, used only for reporting. */
  readonly text: string;
  /**
   * The same span with comments, string literals, quoted identifiers, and
   * dollar-quoted bodies blanked out, so a keyword inside a string cannot be
   * mistaken for a keyword in the statement.
   */
  readonly code: string;
  /** One-based line number where the statement starts. */
  readonly line: number;
  /** True when the statement came from inside a dollar-quoted body. */
  readonly inBlock: boolean;
}

export interface Migration {
  /** Repository-relative path, POSIX separators. */
  readonly file: string;
  /** The `NNN` prefix of the filename. */
  readonly sequence: number;
  /** The filename without its `.sql` extension. */
  readonly name: string;
  /** Header keys, lowercased, in declaration order. */
  readonly header: ReadonlyMap<string, string>;
  /** One-based line each header key was declared on. */
  readonly headerLines: ReadonlyMap<string, number>;
  readonly statements: readonly Statement[];
}

/* ────────────────────────────── lexing ─────────────────────────────────── */

interface DollarBlock {
  /** Body between the delimiters, exclusive. */
  readonly body: string;
  /** Index of the first character of the body within the source. */
  readonly offset: number;
}

interface Lexed {
  /**
   * The source with every non-code span replaced by spaces. Newlines are
   * preserved so that an index into `masked` is an index into the source, and
   * line numbers survive.
   */
  readonly masked: string;
  readonly blocks: readonly DollarBlock[];
}

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Blank out everything that is not executable SQL.
 *
 * Handling string literals is not pedantry: `INSERT INTO audit VALUES ('DROP
 * COLUMN full_name')` is an ordinary insert, and matching keywords against raw
 * text would classify it as a destructive migration. Dollar quoting has to be
 * tag-aware because `$$` and `$body$` nest inside each other in practice, and
 * block comments nest in Postgres where they do not in the SQL standard.
 */
export const lex = (sql: string): Lexed => {
  const out = sql.split('');
  const blocks: DollarBlock[] = [];
  const end = sql.length;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < end; k += 1) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  /** Consume a quoted run ending at an unescaped `quote`; doubling escapes. */
  const skipQuoted = (start: number, quote: string): number => {
    let j = start + 1;
    while (j < end) {
      if (sql[j] === quote) {
        if (sql[j + 1] === quote) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j += 1;
    }
    return end;
  };

  let i = 0;
  while (i < end) {
    const pair = sql.slice(i, i + 2);

    if (pair === '--') {
      const newline = sql.indexOf('\n', i);
      const stop = newline === -1 ? end : newline;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (pair === '/*') {
      let depth = 1;
      let j = i + 2;
      while (j < end && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') {
          depth += 1;
          j += 2;
        } else if (sql.slice(j, j + 2) === '*/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      blank(i, j);
      i = j;
      continue;
    }

    if (sql[i] === "'" || sql[i] === '"') {
      const stop = skipQuoted(i, sql[i]);
      blank(i, stop);
      i = stop;
      continue;
    }

    if (sql[i] === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag !== undefined) {
        const bodyStart = i + tag.length;
        const closing = sql.indexOf(tag, bodyStart);
        const bodyEnd = closing === -1 ? end : closing;
        blocks.push({ body: sql.slice(bodyStart, bodyEnd), offset: bodyStart });
        const stop = closing === -1 ? end : closing + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }

    i += 1;
  }

  return { masked: out.join(''), blocks };
};

/** One-based line number of `index` within `source`. */
export const lineAt = (source: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
};

/**
 * Split into statements on semicolons that are actually statement terminators.
 *
 * `lineOffset` shifts the reported line numbers when the source is a
 * dollar-quoted body being analysed in its own right, so a finding inside a
 * `DO` block still points at the right line of the file.
 */
export const splitStatements = (
  sql: string,
  options: { readonly inBlock?: boolean; readonly lineOffset?: number; readonly depth?: number } = {},
): Statement[] => {
  const inBlock = options.inBlock ?? false;
  const lineOffset = options.lineOffset ?? 0;
  const depth = options.depth ?? 0;

  const { masked, blocks } = lex(sql);
  const statements: Statement[] = [];

  let start = 0;
  const push = (from: number, to: number): void => {
    const code = masked.slice(from, to);
    if (code.trim() === '') return;
    const leading = code.length - code.trimStart().length;
    statements.push({
      text: sql.slice(from, to).trim(),
      code,
      line: lineAt(sql, from + leading) + lineOffset,
      inBlock,
    });
  };

  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ';') {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, masked.length);

  // PL/pgSQL bodies hide real statements. One level of recursion covers a DO
  // block and a function body; anything deeper is a nested function definition,
  // which is not something a migration should be doing unreviewed.
  if (depth < 2) {
    for (const block of blocks) {
      statements.push(
        ...splitStatements(block.body, {
          inBlock: true,
          lineOffset: lineAt(sql, block.offset) - 1 + lineOffset,
          depth: depth + 1,
        }),
      );
    }
  }

  return statements;
};

/* ───────────────────────────── header parsing ──────────────────────────── */

const HEADER_KEY = /^--\s*([a-z][a-z0-9-]*)\s*:\s*(.*)$/i;

/**
 * Read the `-- key: value` block at the top of a migration.
 *
 * Only the leading comment block counts. A key further down the file is a
 * comment about a statement, not a declaration about the migration, and
 * treating it as one would let a header be smuggled in below a `DROP TABLE`.
 */
export const parseHeader = (
  sql: string,
): { header: Map<string, string>; headerLines: Map<string, number> } => {
  const header = new Map<string, string>();
  const headerLines = new Map<string, number>();

  const lines = sql.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (!line.startsWith('--')) break;

    const match = HEADER_KEY.exec(line);
    if (match === null) continue;

    const key = match[1].toLowerCase();
    if (header.has(key)) continue;
    header.set(key, match[2].trim());
    headerLines.set(key, i + 1);
  }

  return { header, headerLines };
};

const FILENAME = /^(\d+)_([a-z0-9_]+)\.sql$/;

export const parseMigration = (file: string, source: string): Migration => {
  const base = path.posix.basename(file);
  const match = FILENAME.exec(base);
  const { header, headerLines } = parseHeader(source);

  return {
    file,
    sequence: match === null ? Number.NaN : Number.parseInt(match[1], 10),
    name: base.replace(/\.sql$/, ''),
    header,
    headerLines,
    statements: splitStatements(source),
  };
};

/* ─────────────────────────── statement matching ────────────────────────── */

/** Collapse whitespace and uppercase, so patterns can be written one way. */
const normalise = (code: string): string => code.replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * PL/pgSQL structure that sits between a semicolon and the statement after it.
 *
 * Splitting a function body on semicolons does not yield statements that start
 * with a verb: `BEGIN LOOP UPDATE users ...` is one chunk, and so is
 * `IF found THEN DROP TABLE staging`. Every rule below is written against the
 * verb, so the control flow in front of it is stripped rather than anchoring
 * abandoned — anchoring is what keeps `INSERT INTO audit SELECT ... FROM
 * dropped_table` from reading as a DROP.
 *
 * Longer forms come first: alternation takes the first match at a position, so
 * `END LOOP` has to be offered before `END`.
 */
const PLPGSQL_NOISE =
  /^(?:BEGIN|DECLARE|END LOOP|END IF|END|LOOP|ELSE|THEN|EXCEPTION|(?:ELS)?IF .*? THEN|WHEN .*? THEN)\s+/;

const stripPlpgsqlNoise = (code: string): string => {
  let stripped = code;
  for (;;) {
    const next = stripped.replace(PLPGSQL_NOISE, '');
    if (next === stripped) return stripped;
    stripped = next;
  }
};

/** A statement's code, normalised, with PL/pgSQL control flow taken off the front. */
const codeOf = (statement: Statement): string => {
  const normalised = normalise(statement.code);
  return statement.inBlock ? stripPlpgsqlNoise(normalised) : normalised;
};

/**
 * Statements that make the schema strictly bigger. Old code cannot notice a
 * column, index, or table it never mentions.
 */
const ADDITIVE = /^(CREATE (TABLE|INDEX|UNIQUE INDEX|SEQUENCE|TYPE|FUNCTION|TRIGGER|OR REPLACE FUNCTION|SCHEMA|EXTENSION)|ALTER TABLE .* ADD (COLUMN|CONSTRAINT))/;

/**
 * Statements that remove something a running process may still be using. The
 * set is deliberately narrower than "everything that says DROP": dropping a
 * constraint or an index relaxes what the database will accept, and no writer
 * has ever broken because a restriction was lifted or a lookup got slower.
 */
const DESTRUCTIVE =
  /^(DROP (TABLE|COLUMN|SEQUENCE|TYPE|TRIGGER|FUNCTION|SCHEMA)|TRUNCATE|ALTER TABLE .* (DROP COLUMN|RENAME))/;

export const isAdditive = (statement: Statement): boolean => ADDITIVE.test(codeOf(statement));

export const isDestructive = (statement: Statement): boolean => DESTRUCTIVE.test(codeOf(statement));

/**
 * An UPDATE or DELETE that rewrites existing rows.
 *
 * Unanchored on purpose. A backfill is written as a loop inside a `DO` block, so
 * the statement this rule cares about is never the first token of its chunk —
 * it sits behind `BEGIN LOOP`. Anchoring the match would mean the one shape a
 * backfill actually takes is the one shape the rule cannot see.
 *
 * Three things say `UPDATE` without updating anything, and all three are
 * excluded rather than tolerated as false positives: `FOR UPDATE` locks rows on
 * a SELECT, `BEFORE INSERT OR UPDATE ON` names a trigger event, and `UPDATE OF
 * col` names a trigger's column list.
 */
const ROW_WRITE = /(?<!FOR )\b(?:UPDATE|DELETE FROM)\s+(?:ONLY\s+)?(?!ON\b|OR\b|OF\b)[A-Z0-9_."]+\s/;

/** Statements whose grammar contains event names that read like row writes. */
const EVENT_DEFINITION = /^CREATE (?:OR REPLACE )?(?:TRIGGER|RULE) /;

const isRowWrite = (normalisedCode: string): boolean =>
  !EVENT_DEFINITION.test(normalisedCode) && ROW_WRITE.test(normalisedCode);

/** Names of tables this migration creates itself — they carry no traffic yet. */
const tablesCreatedHere = (migration: Migration): Set<string> => {
  const created = new Set<string>();
  for (const statement of migration.statements) {
    const match = /^CREATE TABLE (?:IF NOT EXISTS )?([A-Z0-9_."]+)/.exec(codeOf(statement));
    if (match !== null) created.add(match[1].replace(/"/g, ''));
  }
  return created;
};

/** The table an `ALTER TABLE` / `CREATE INDEX` statement targets, uppercased. */
const targetTable = (code: string): string | undefined => {
  const normalised = normalise(code);
  const alter = /^ALTER TABLE (?:ONLY )?(?:IF EXISTS )?([A-Z0-9_."]+)/.exec(normalised);
  if (alter !== null) return alter[1].replace(/"/g, '');

  const index =
    /^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?[A-Z0-9_."]+ ON (?:ONLY )?([A-Z0-9_."]+)/.exec(
      normalised,
    );
  if (index !== null) return index[1].replace(/"/g, '');

  return undefined;
};

/** Read a balanced parenthesised group starting at `open`, exclusive of parens. */
export const readParenGroup = (code: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
};

interface CheckConstraint {
  readonly name: string;
  /** The CHECK expression, normalised. */
  readonly expression: string;
  readonly sequence: number;
}

/** Every `ADD CONSTRAINT <name> CHECK (...)` in the directory. */
const checkConstraints = (migrations: readonly Migration[]): CheckConstraint[] => {
  const constraints: CheckConstraint[] = [];

  for (const migration of migrations) {
    for (const statement of migration.statements) {
      const normalised = normalise(statement.code);
      const match = /ADD CONSTRAINT ([A-Z0-9_."]+) CHECK\s*\(/.exec(normalised);
      if (match === null) continue;

      const open = normalised.indexOf('(', match.index + match[0].length - 1);
      constraints.push({
        name: match[1].replace(/"/g, ''),
        expression: readParenGroup(normalised, open),
        sequence: migration.sequence,
      });
    }
  }

  return constraints;
};

/** Constraint names any migration validates, and the ordinal it happened at. */
const validatedConstraints = (migrations: readonly Migration[]): Map<string, number> => {
  const validated = new Map<string, number>();

  for (const migration of migrations) {
    for (const statement of migration.statements) {
      const match = /VALIDATE CONSTRAINT ([A-Z0-9_."]+)/.exec(normalise(statement.code));
      if (match === null) continue;

      const name = match[1].replace(/"/g, '');
      const existing = validated.get(name);
      if (existing === undefined || migration.sequence < existing) {
        validated.set(name, migration.sequence);
      }
    }
  }

  return validated;
};

/* ──────────────────────────────── rules ────────────────────────────────── */

/** Cross-file facts a single migration cannot know about itself. */
export interface AuditContext {
  readonly checks: readonly CheckConstraint[];
  readonly validated: ReadonlyMap<string, number>;
}

export const buildContext = (migrations: readonly Migration[]): AuditContext => ({
  checks: checkConstraints(migrations),
  validated: validatedConstraints(migrations),
});

const headerFindings = (migration: Migration): Finding[] => {
  const findings: Finding[] = [];
  const { file, header, headerLines } = migration;

  if (header.size === 0) {
    return [
      {
        rule: 'missing-header',
        file,
        line: 1,
        message:
          'no header block. Every migration declares `-- migration:`, `-- phase:`, and ' +
          '`-- release:` in the leading comment so a reviewer can tell, without reading the ' +
          'SQL, which deployment it belongs to.',
      },
    ];
  }

  for (const key of ['migration', 'phase', 'release'] as const) {
    if (!header.has(key)) {
      findings.push({
        rule: 'missing-header',
        file,
        line: 1,
        message: `header is missing \`-- ${key}:\`.`,
      });
    }
  }

  const declaredName = header.get('migration');
  if (declaredName !== undefined && declaredName !== migration.name) {
    findings.push({
      rule: 'header-name-mismatch',
      file,
      line: headerLines.get('migration') ?? 1,
      message:
        `header declares \`${declaredName}\` but the file is \`${migration.name}\`. ` +
        'A header describing another migration is a copied header, and whatever else it ' +
        'says about this one cannot be trusted.',
    });
  }

  const phase = header.get('phase');
  if (phase !== undefined && !(PHASES as readonly string[]).includes(phase)) {
    findings.push({
      rule: 'unknown-phase',
      file,
      line: headerLines.get('phase') ?? 1,
      message: `unknown phase \`${phase}\`. Expected one of: ${PHASES.join(', ')}.`,
    });
  }

  if (phase === 'contract' && !header.has('safe-after')) {
    findings.push({
      rule: 'contract-without-safe-after',
      file,
      line: headerLines.get('phase') ?? 1,
      message:
        'a contract migration must declare `-- safe-after: <release>` — the release after ' +
        'which no running process reads or writes the object being removed. Without it there ' +
        'is nothing to check before merging except the author’s memory, and the cost of ' +
        'being wrong is an outage that a rollback cannot undo.',
    });
  }

  return findings;
};

const phaseFindings = (migration: Migration): Finding[] => {
  const findings: Finding[] = [];
  const phase = migration.header.get('phase');

  const additive = migration.statements.filter(isAdditive);
  const destructive = migration.statements.filter(isDestructive);

  if (additive.length > 0 && destructive.length > 0) {
    findings.push({
      rule: 'mixed-phase',
      file: migration.file,
      line: destructive[0].line,
      message:
        'this migration both adds and removes schema. Expand and contract must be separate ' +
        'deployments: while they are one, there is no release you can roll back to that both ' +
        'the old code and the migrated database agree on.',
    });
  }

  if (phase === 'expand' || phase === 'baseline' || phase === 'backfill') {
    for (const statement of destructive) {
      findings.push({
        rule: 'phase-mismatch',
        file: migration.file,
        line: statement.line,
        message:
          `declared \`phase: ${phase}\` but removes schema: ${summarise(statement)}. ` +
          'Move it to a contract migration that ships after the last reader is gone.',
      });
    }
  }

  if (phase === 'contract') {
    for (const statement of additive) {
      findings.push({
        rule: 'phase-mismatch',
        file: migration.file,
        line: statement.line,
        message:
          `declared \`phase: contract\` but adds schema: ${summarise(statement)}. ` +
          'Contract migrations only remove; anything new belongs in the expand migration ' +
          'of a release that ships before this one.',
      });
    }
  }

  return findings;
};

const statementFindings = (migration: Migration, context: AuditContext): Finding[] => {
  const findings: Finding[] = [];
  const created = tablesCreatedHere(migration);
  const declaresNoTransaction = migration.header.get('transaction') === 'none';
  const phase = migration.header.get('phase');

  for (const statement of migration.statements) {
    const code = codeOf(statement);
    const at = (rule: FindingRule, message: string): void => {
      findings.push({ rule, file: migration.file, line: statement.line, message });
    };

    if (/^ALTER TABLE .* RENAME/.test(code)) {
      at(
        'irreversible-rename',
        'renaming a table or column cannot be made zero-downtime. There is no instant at which ' +
          'both the old name and the new one exist, so whichever code is not yet deployed is ' +
          'broken for the length of the rollout. Add the new name, backfill, migrate readers, ' +
          'then drop the old one — four releases, not one statement.',
      );
    }

    if (/ALTER COLUMN [A-Z0-9_."]+ (?:SET DATA )?TYPE /.test(code)) {
      at(
        'in-place-type-change',
        'changing a column type rewrites the table under an ACCESS EXCLUSIVE lock, which ' +
          'blocks reads as well as writes for the length of the rewrite, and hands the old ' +
          'code a type it was not compiled against. Add a new column of the target type and ' +
          'contract onto it.',
      );
    }

    if (/ADD COLUMN /.test(code) && / NOT NULL/.test(code) && !/ DEFAULT /.test(code)) {
      at(
        'not-null-without-default',
        'adding a NOT NULL column without a DEFAULT fails outright on a non-empty table, and ' +
          'succeeds into a worse problem on an empty one: every INSERT from the old code, ' +
          'which does not know the column exists, starts failing the moment the migration ' +
          'commits. Add it nullable, backfill, then constrain it.',
      );
    }

    const setNotNull = /^ALTER TABLE (?:ONLY )?([A-Z0-9_."]+) ALTER COLUMN ([A-Z0-9_."]+) SET NOT NULL/.exec(
      code,
    );
    if (setNotNull !== null) {
      const column = setNotNull[2].replace(/"/g, '');
      const table = setNotNull[1].replace(/"/g, '');
      const proven = context.checks.some((check) => {
        const validatedAt = context.validated.get(check.name);
        return (
          check.expression.includes(`${column} IS NOT NULL`) &&
          validatedAt !== undefined &&
          validatedAt <= migration.sequence
        );
      });

      if (!proven && !created.has(table)) {
        at(
          'set-not-null-full-scan',
          `SET NOT NULL on \`${column}\` scans every row under an ACCESS EXCLUSIVE lock. ` +
            'Postgres 12 and later will skip that scan if a validated CHECK ' +
            `(${column.toLowerCase()} IS NOT NULL) already proves the column holds — add the ` +
            'constraint NOT VALID, VALIDATE it in a later migration, and this becomes a ' +
            'catalogue update.',
        );
      }
    }

    if (/^CREATE (?:UNIQUE )?INDEX /.test(code) && !/ CONCURRENTLY /.test(code)) {
      const table = targetTable(statement.code);
      if (table === undefined || !created.has(table)) {
        at(
          'index-without-concurrently',
          'building an index without CONCURRENTLY holds a SHARE lock, which blocks every ' +
            'write to the table until the build finishes — minutes on a table large enough ' +
            'to need the index. Use CREATE INDEX CONCURRENTLY, and declare ' +
            '`-- transaction: none`, since it cannot run inside a transaction block.',
        );
      }
    }

    if (/ CONCURRENTLY /.test(code) && !declaresNoTransaction) {
      at(
        'concurrent-index-in-transaction',
        'CONCURRENTLY cannot run inside a transaction block; Postgres aborts the statement. ' +
          'Most migration runners wrap each file in BEGIN/COMMIT by default, so this file must ' +
          'declare `-- transaction: none` and the runner must be configured to honour it.',
      );
    }

    const addConstraint = /ADD CONSTRAINT [A-Z0-9_."]+ (CHECK|FOREIGN KEY)/.exec(code);
    if (addConstraint !== null && !/ NOT VALID/.test(code)) {
      const table = targetTable(statement.code);
      if (table === undefined || !created.has(table)) {
        at(
          'unvalidated-constraint',
          `adding a ${addConstraint[1]} constraint without NOT VALID scans the whole table ` +
            'under an ACCESS EXCLUSIVE lock before it will commit. Add it NOT VALID — which ' +
            'takes the lock only long enough to write the catalogue row, and still enforces the ' +
            'constraint on every new row — then VALIDATE it in a separate migration, which ' +
            'takes only SHARE UPDATE EXCLUSIVE and lets writes continue.',
        );
      }
    }

    if (isRowWrite(code) && !/ WHERE /.test(code)) {
      at(
        'unbounded-backfill',
        'an UPDATE or DELETE with no WHERE clause rewrites every row in one transaction. It ' +
          'holds row locks for the duration, doubles the table on disk, and cannot be ' +
          'interrupted without losing all of the work. Bound it and run it in batches.',
      );
    }
  }

  if (phase === 'backfill') {
    const writes = migration.statements.filter((s) => isRowWrite(codeOf(s)));
    const bounded = migration.statements.some((s) => / LIMIT /.test(codeOf(s)));

    if (writes.length > 0 && !bounded) {
      findings.push({
        rule: 'unbatched-backfill',
        file: migration.file,
        line: writes[0].line,
        message:
          'a backfill with no LIMIT anywhere is a single transaction over the whole table. On ' +
          'a table small enough for that to be safe the backfill was not needed; on one large ' +
          'enough to need it, this is the statement that fills the disk with dead tuples and ' +
          'blocks autovacuum from reclaiming them. Loop over bounded batches and commit each.',
      });
    }
  }

  return findings;
};

/** First few words of a statement — enough to recognise it, short enough to read. */
const summarise = (statement: Statement): string => {
  const words = codeOf(statement).split(' ').slice(0, 6).join(' ');
  return `\`${words}\`${statement.inBlock ? ' (inside a dollar-quoted block)' : ''}`;
};

/** Every rule that looks at one migration in the light of all the others. */
export const auditMigrations = (migrations: readonly Migration[]): Finding[] => {
  const context = buildContext(migrations);
  const findings: Finding[] = [];

  const bySequence = new Map<number, Migration[]>();
  for (const migration of migrations) {
    const existing = bySequence.get(migration.sequence);
    if (existing === undefined) bySequence.set(migration.sequence, [migration]);
    else existing.push(migration);
  }

  for (const [sequence, group] of bySequence) {
    if (group.length < 2 || Number.isNaN(sequence)) continue;
    for (const migration of group.slice(1)) {
      findings.push({
        rule: 'duplicate-sequence',
        file: migration.file,
        line: 1,
        message:
          `sequence ${String(sequence).padStart(3, '0')} is claimed by ${group.length} ` +
          `migrations (${group.map((m) => m.name).join(', ')}). Two branches renumbered onto ` +
          'each other; the order they apply in is now whatever the runner happens to sort by.',
      });
    }
  }

  for (const check of context.checks) {
    if (context.validated.has(check.name)) continue;

    const owner = migrations.find((m) =>
      m.statements.some((s) => normalise(s.code).includes(`ADD CONSTRAINT ${check.name} `)),
    );
    if (owner === undefined) continue;

    findings.push({
      rule: 'constraint-never-validated',
      file: owner.file,
      line:
        owner.statements.find((s) => normalise(s.code).includes(`ADD CONSTRAINT ${check.name} `))
          ?.line ?? 1,
      message:
        `\`${check.name}\` is added NOT VALID and never validated. Rows written before it ` +
        'existed are still unchecked, so the constraint describes the future of the table and ' +
        'not the table. Add `ALTER TABLE ... VALIDATE CONSTRAINT` in a later migration.',
    });
  }

  for (const migration of migrations) {
    findings.push(...headerFindings(migration));
    findings.push(...phaseFindings(migration));
    findings.push(...statementFindings(migration, context));
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
};

export const formatFindings = (findings: readonly Finding[]): string =>
  findings.map((f) => `${f.file}:${f.line}  [${f.rule}]\n    ${f.message}`).join('\n\n');

/** Read every `.sql` file in `directory`, ordered the way a runner would apply them. */
export const readMigrations = (root: string, directory: string): Migration[] => {
  const absolute = path.join(root, directory);
  if (!fs.existsSync(absolute)) return [];

  return fs
    .readdirSync(absolute)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const relative = path.posix.join(directory.split(path.sep).join('/'), name);
      return parseMigration(relative, fs.readFileSync(path.join(absolute, name), 'utf8'));
    });
};

/* istanbul ignore next — CLI wiring, exercised by the CI job rather than jest. */
if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..', '..');
  const directory = process.argv[2] ?? DEFAULT_MIGRATIONS_DIR;
  const migrations = readMigrations(root, directory);

  if (migrations.length === 0) {
    console.error(`No .sql migrations found under ${path.join(root, directory)}.`);
    process.exit(1);
  }

  const findings = auditMigrations(migrations);

  if (findings.length > 0) {
    console.error(`\n${findings.length} migration safety violation(s):\n`);
    console.error(formatFindings(findings));
    console.error('\nSee docs/expand-contract-migrations.md.\n');
    process.exit(1);
  }

  console.log(`${migrations.length} migration(s) in ${directory} are expand/contract safe.`);
}
