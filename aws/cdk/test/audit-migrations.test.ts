import * as path from 'path';
import {
  DEFAULT_MIGRATIONS_DIR,
  Finding,
  FindingRule,
  Migration,
  PHASES,
  auditMigrations,
  formatFindings,
  isAdditive,
  isDestructive,
  lex,
  lineAt,
  parseHeader,
  parseMigration,
  readMigrations,
  readParenGroup,
  splitStatements,
} from '../tools/audit-migrations';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const rules = (findings: readonly Finding[]): FindingRule[] => findings.map((f) => f.rule);

/**
 * A migration written the way one is written, then parsed the way the tool
 * parses one. Tests dislodge a single property so a failure names its cause.
 */
const migration = (name: string, sql: string): Migration =>
  parseMigration(`db/migrations/${name}`, sql);

interface HeaderOverrides {
  readonly name?: string;
  readonly phase?: string;
  readonly release?: string;
  readonly transaction?: string;
  readonly safeAfter?: string;
  readonly omit?: readonly string[];
}

/** A conforming header for `file`, with one line removed or changed per test. */
const header = (file: string, overrides: HeaderOverrides = {}): string => {
  const omit = overrides.omit ?? [];
  const lines: [string, string | undefined][] = [
    ['migration', overrides.name ?? file.replace(/\.sql$/, '')],
    ['phase', overrides.phase ?? 'expand'],
    ['release', overrides.release ?? '1.4.0'],
    ['transaction', overrides.transaction ?? 'implicit'],
    ['safe-after', overrides.safeAfter],
  ];

  return lines
    .filter(([key, value]) => value !== undefined && !omit.includes(key))
    .map(([key, value]) => `-- ${key}: ${value}`)
    .join('\n');
};

/** A single-statement migration carrying a conforming header. */
const withHeader = (file: string, sql: string, overrides: HeaderOverrides = {}): Migration =>
  migration(file, `${header(file, overrides)}\n\n${sql}\n`);

describe('lex', () => {
  it('blanks line comments, block comments, and string literals', () => {
    const { masked } = lex("SELECT 1; -- DROP TABLE users\n/* DROP TABLE t */ SELECT 'DROP TABLE x';");

    expect(masked).not.toMatch(/DROP TABLE/);
    expect(masked).toContain('SELECT 1;');
  });

  it('nests block comments the way Postgres does', () => {
    const { masked } = lex('/* outer /* inner */ still comment */ SELECT 1;');

    expect(masked.trim()).toBe('SELECT 1;');
  });

  it('treats a doubled quote as an escape rather than a terminator', () => {
    const { masked } = lex("SELECT 'it''s; not over' AS x;");

    // One statement, not two: the semicolon inside the literal is not a
    // terminator, and the literal is masked out entirely.
    expect(masked.split(';')).toHaveLength(2);
    expect(masked).toContain('AS x');
  });

  it('preserves line numbers so a finding can point at a line', () => {
    const source = 'SELECT 1;\n-- a comment\n/* two\n   lines */\nSELECT 2;';
    const { masked } = lex(source);

    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
    expect(lineAt(source, masked.indexOf('SELECT 2'))).toBe(5);
  });

  it('captures tagged and untagged dollar-quoted bodies', () => {
    const { masked, blocks } = lex('CREATE FUNCTION f() AS $body$ SELECT 1 $body$; SELECT $$two$$;');

    expect(blocks.map((b) => b.body.trim())).toEqual(['SELECT 1', 'two']);
    expect(masked).not.toContain('SELECT 1');
  });

  it('does not mistake a placeholder for a dollar quote', () => {
    const { blocks } = lex('SELECT * FROM users WHERE id = $1;');

    expect(blocks).toHaveLength(0);
  });
});

describe('splitStatements', () => {
  it('splits on terminators only', () => {
    const statements = splitStatements("SELECT 'a;b'; SELECT 2;");

    expect(statements).toHaveLength(2);
  });

  it('reports the line each statement starts on', () => {
    const statements = splitStatements('\n\nSELECT 1;\n\nSELECT 2;');

    expect(statements.map((s) => s.line)).toEqual([3, 5]);
  });

  it('reaches statements hidden inside a dollar-quoted body', () => {
    const statements = splitStatements('DO $$\nBEGIN\n  DROP TABLE users;\nEND\n$$;');
    const inner = statements.filter((s) => s.inBlock);

    expect(inner.some((s) => s.code.includes('DROP TABLE users'))).toBe(true);
    // Line 2, not 3: a semicolon-delimited chunk of PL/pgSQL starts after the
    // previous statement, so this one begins at `BEGIN` and the DROP is inside
    // it. The finding points at the top of the chunk that contains the problem.
    expect(inner.find((s) => s.code.includes('DROP TABLE users'))?.line).toBe(2);
  });
});

describe('parseHeader', () => {
  it('reads the leading comment block only', () => {
    const { header: parsed } = parseHeader(
      '-- migration: 001_x\n-- phase: expand\n\nDROP TABLE users;\n-- phase: contract\n',
    );

    expect(parsed.get('phase')).toBe('expand');
  });

  it('keeps the first value when a key is declared twice', () => {
    const { header: parsed } = parseHeader('-- phase: expand\n-- phase: contract\n');

    expect(parsed.get('phase')).toBe('expand');
  });

  it('records the line each key was declared on', () => {
    const { headerLines } = parseHeader('-- migration: 001_x\n-- phase: expand\n');

    expect(headerLines.get('phase')).toBe(2);
  });
});

describe('statement classification', () => {
  it('treats schema growth as additive', () => {
    const [statement] = splitStatements('ALTER TABLE users ADD COLUMN nickname text;');

    expect(isAdditive(statement)).toBe(true);
    expect(isDestructive(statement)).toBe(false);
  });

  it('treats removal of a thing code may hold a reference to as destructive', () => {
    for (const sql of [
      'ALTER TABLE users DROP COLUMN full_name;',
      'DROP TABLE sessions;',
      'DROP TRIGGER t ON users;',
      'TRUNCATE users;',
    ]) {
      const [statement] = splitStatements(sql);
      expect(isDestructive(statement)).toBe(true);
    }
  });

  it('does not treat relaxing a constraint or an index as destructive', () => {
    // Widening what the database accepts, or making a lookup slower, has never
    // broken a writer — so these do not have to wait for a contract release.
    for (const sql of [
      'ALTER TABLE users DROP CONSTRAINT users_first_name_not_null;',
      'DROP INDEX CONCURRENTLY users_last_name_idx;',
      'ALTER TABLE users ALTER COLUMN full_name DROP NOT NULL;',
    ]) {
      const [statement] = splitStatements(sql);
      expect(isDestructive(statement)).toBe(false);
    }
  });
});

describe('readParenGroup', () => {
  it('returns the balanced group, not everything up to the last paren', () => {
    expect(readParenGroup('CHECK (a IS NOT NULL) NOT VALID', 6)).toBe('a IS NOT NULL');
    expect(readParenGroup('CHECK ((a OR b) AND c) X', 6)).toBe('(a OR b) AND c');
  });
});

describe('header rules', () => {
  it('accepts a conforming migration', () => {
    const findings = auditMigrations([
      withHeader('001_add_nickname.sql', 'ALTER TABLE users ADD COLUMN nickname text;'),
    ]);

    expect(findings).toEqual([]);
  });

  it('reports a file with no header at all', () => {
    const findings = auditMigrations([
      migration('001_add_nickname.sql', 'ALTER TABLE users ADD COLUMN nickname text;'),
    ]);

    expect(rules(findings)).toContain('missing-header');
  });

  it('reports each missing required key separately', () => {
    const findings = auditMigrations([
      withHeader('001_add_nickname.sql', 'SELECT 1;', { omit: ['phase', 'release'] }),
    ]);

    expect(rules(findings).filter((r) => r === 'missing-header')).toHaveLength(2);
  });

  it('reports a header copied from another migration', () => {
    const findings = auditMigrations([
      withHeader('002_add_nickname.sql', 'SELECT 1;', { name: '001_something_else' }),
    ]);

    expect(rules(findings)).toContain('header-name-mismatch');
  });

  it('reports a phase outside the vocabulary', () => {
    const findings = auditMigrations([
      withHeader('001_add_nickname.sql', 'SELECT 1;', { phase: 'cleanup' }),
    ]);

    expect(rules(findings)).toContain('unknown-phase');
    expect(PHASES).not.toContain('cleanup');
  });

  it('requires a contract migration to say what stopped using the object', () => {
    const findings = auditMigrations([
      withHeader('009_drop_full_name.sql', 'ALTER TABLE users DROP COLUMN full_name;', {
        phase: 'contract',
      }),
    ]);

    expect(rules(findings)).toContain('contract-without-safe-after');
  });

  it('accepts a contract migration that declares safe-after', () => {
    const findings = auditMigrations([
      withHeader('009_drop_full_name.sql', 'ALTER TABLE users DROP COLUMN full_name;', {
        phase: 'contract',
        safeAfter: '1.6.0',
      }),
    ]);

    expect(findings).toEqual([]);
  });

  it('reports two migrations claiming the same ordinal', () => {
    const findings = auditMigrations([
      withHeader('004_from_one_branch.sql', 'SELECT 1;'),
      withHeader('004_from_another_branch.sql', 'SELECT 1;'),
    ]);

    expect(rules(findings)).toContain('duplicate-sequence');
  });
});

describe('phase rules', () => {
  it('refuses expand and contract in one deployment', () => {
    const findings = auditMigrations([
      withHeader(
        '005_swap_name.sql',
        'ALTER TABLE users ADD COLUMN nickname text;\nALTER TABLE users DROP COLUMN full_name;',
        { phase: 'contract', safeAfter: '1.6.0' },
      ),
    ]);

    expect(rules(findings)).toContain('mixed-phase');
  });

  it('reports removal declared as expand', () => {
    const findings = auditMigrations([
      withHeader('005_drop_it.sql', 'DROP TABLE sessions;', { phase: 'expand' }),
    ]);

    expect(rules(findings)).toContain('phase-mismatch');
  });

  it('reports addition declared as contract', () => {
    const findings = auditMigrations([
      withHeader('005_add_it.sql', 'ALTER TABLE users ADD COLUMN nickname text;', {
        phase: 'contract',
        safeAfter: '1.6.0',
      }),
    ]);

    expect(rules(findings)).toContain('phase-mismatch');
  });

  it('sees a destructive statement hidden inside a DO block', () => {
    const findings = auditMigrations([
      withHeader('005_sneaky.sql', 'DO $$\nBEGIN\n  DROP TABLE sessions;\nEND\n$$;', {
        phase: 'expand',
      }),
    ]);

    expect(rules(findings)).toContain('phase-mismatch');
    expect(findings.find((f) => f.rule === 'phase-mismatch')?.message).toContain(
      'dollar-quoted block',
    );
  });
});

describe('locking and compatibility rules', () => {
  it('rejects a rename outright', () => {
    for (const sql of [
      'ALTER TABLE users RENAME COLUMN full_name TO display_name;',
      'ALTER TABLE users RENAME TO app_users;',
    ]) {
      const findings = auditMigrations([
        withHeader('005_rename.sql', sql, { phase: 'contract', safeAfter: '1.6.0' }),
      ]);
      expect(rules(findings)).toContain('irreversible-rename');
    }
  });

  it('rejects an in-place type change', () => {
    const findings = auditMigrations([
      withHeader('005_widen.sql', 'ALTER TABLE users ALTER COLUMN id TYPE bigint;'),
    ]);

    expect(rules(findings)).toContain('in-place-type-change');
  });

  it('rejects a NOT NULL column added with no default', () => {
    const findings = auditMigrations([
      withHeader('005_add_flag.sql', 'ALTER TABLE users ADD COLUMN active boolean NOT NULL;'),
    ]);

    expect(rules(findings)).toContain('not-null-without-default');
  });

  it('accepts a NOT NULL column added with a default', () => {
    const findings = auditMigrations([
      withHeader(
        '005_add_flag.sql',
        'ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;',
      ),
    ]);

    expect(findings).toEqual([]);
  });

  it('rejects SET NOT NULL with nothing to prove the column holds', () => {
    const findings = auditMigrations([
      withHeader('005_constrain.sql', 'ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;'),
    ]);

    expect(rules(findings)).toContain('set-not-null-full-scan');
  });

  it('accepts SET NOT NULL behind a validated CHECK added earlier', () => {
    const findings = auditMigrations([
      withHeader(
        '003_check.sql',
        'ALTER TABLE users ADD CONSTRAINT users_first_name_not_null CHECK (first_name IS NOT NULL) NOT VALID;',
      ),
      withHeader('004_validate.sql', 'ALTER TABLE users VALIDATE CONSTRAINT users_first_name_not_null;'),
      withHeader('005_constrain.sql', 'ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;'),
    ]);

    expect(findings).toEqual([]);
  });

  it('does not accept a CHECK that is validated only afterwards', () => {
    const findings = auditMigrations([
      withHeader(
        '003_check.sql',
        'ALTER TABLE users ADD CONSTRAINT users_first_name_not_null CHECK (first_name IS NOT NULL) NOT VALID;',
      ),
      withHeader('005_constrain.sql', 'ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;'),
      withHeader('006_validate.sql', 'ALTER TABLE users VALIDATE CONSTRAINT users_first_name_not_null;'),
    ]);

    expect(rules(findings)).toContain('set-not-null-full-scan');
  });

  it('rejects a non-concurrent index on a table that already exists', () => {
    const findings = auditMigrations([
      withHeader('005_index.sql', 'CREATE INDEX users_last_name_idx ON users (last_name);'),
    ]);

    expect(rules(findings)).toContain('index-without-concurrently');
  });

  it('allows a non-concurrent index on a table created in the same migration', () => {
    const findings = auditMigrations([
      withHeader(
        '000_baseline.sql',
        'CREATE TABLE audit_log (id bigint, at timestamptz);\nCREATE INDEX audit_log_at_idx ON audit_log (at);',
        { phase: 'baseline' },
      ),
    ]);

    expect(findings).toEqual([]);
  });

  it('rejects CONCURRENTLY in a file the runner will wrap in a transaction', () => {
    const findings = auditMigrations([
      withHeader(
        '005_index.sql',
        'CREATE INDEX CONCURRENTLY users_last_name_idx ON users (last_name);',
      ),
    ]);

    expect(rules(findings)).toContain('concurrent-index-in-transaction');
  });

  it('accepts CONCURRENTLY when the file declares transaction: none', () => {
    const findings = auditMigrations([
      withHeader(
        '005_index.sql',
        'CREATE INDEX CONCURRENTLY users_last_name_idx ON users (last_name);',
        { transaction: 'none' },
      ),
    ]);

    expect(findings).toEqual([]);
  });

  it('rejects a constraint added without NOT VALID', () => {
    const findings = auditMigrations([
      withHeader(
        '005_check.sql',
        'ALTER TABLE users ADD CONSTRAINT users_email_shape CHECK (email LIKE \'%@%\');',
      ),
    ]);

    expect(rules(findings)).toContain('unvalidated-constraint');
  });

  it('rejects a foreign key added without NOT VALID', () => {
    const findings = auditMigrations([
      withHeader(
        '005_fk.sql',
        'ALTER TABLE orders ADD CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id);',
      ),
    ]);

    expect(rules(findings)).toContain('unvalidated-constraint');
  });

  it('reports a NOT VALID constraint that nothing ever validates', () => {
    const findings = auditMigrations([
      withHeader(
        '005_check.sql',
        'ALTER TABLE users ADD CONSTRAINT users_email_shape CHECK (email IS NOT NULL) NOT VALID;',
      ),
    ]);

    expect(rules(findings)).toContain('constraint-never-validated');
  });
});

describe('backfill rules', () => {
  it('rejects an unbounded rewrite', () => {
    const findings = auditMigrations([
      withHeader('005_backfill.sql', 'UPDATE users SET first_name = name_first_part(full_name);', {
        phase: 'backfill',
      }),
    ]);

    expect(rules(findings)).toContain('unbounded-backfill');
  });

  it('rejects a bounded backfill that is still one transaction', () => {
    const findings = auditMigrations([
      withHeader(
        '005_backfill.sql',
        'UPDATE users SET first_name = name_first_part(full_name) WHERE first_name IS NULL;',
        { phase: 'backfill' },
      ),
    ]);

    expect(rules(findings)).toContain('unbatched-backfill');
    expect(rules(findings)).not.toContain('unbounded-backfill');
  });

  it('accepts a batched loop', () => {
    const findings = auditMigrations([
      withHeader(
        '005_backfill.sql',
        [
          'DO $$',
          'BEGIN',
          '  LOOP',
          '    UPDATE users SET first_name = name_first_part(full_name)',
          '     WHERE id IN (SELECT id FROM users WHERE first_name IS NULL ORDER BY id LIMIT 1000);',
          '    EXIT WHEN NOT FOUND;',
          '    COMMIT;',
          '  END LOOP;',
          'END',
          '$$;',
        ].join('\n'),
        { phase: 'backfill', transaction: 'none' },
      ),
    ]);

    expect(findings).toEqual([]);
  });

  it('does not mistake a trigger event list for a row write', () => {
    const findings = auditMigrations([
      withHeader(
        '005_trigger.sql',
        'CREATE TRIGGER users_sync BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION users_sync_name();',
      ),
    ]);

    expect(findings).toEqual([]);
  });

  it('does not mistake SELECT ... FOR UPDATE for a row write', () => {
    const findings = auditMigrations([
      withHeader('005_lock.sql', 'SELECT id FROM users FOR UPDATE;', { phase: 'backfill' }),
    ]);

    expect(findings).toEqual([]);
  });
});

describe('formatFindings', () => {
  it('points at a file and line a reader can open', () => {
    const findings = auditMigrations([
      withHeader('005_drop_it.sql', 'DROP TABLE sessions;', { phase: 'expand' }),
    ]);

    expect(formatFindings(findings)).toMatch(/^db\/migrations\/005_drop_it\.sql:\d+ {2}\[phase-mismatch\]/);
  });
});

describe('the worked example in db/migrations', () => {
  const migrations = readMigrations(REPO_ROOT, DEFAULT_MIGRATIONS_DIR);

  it('is present and ordered', () => {
    expect(migrations.map((m) => m.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  // The example is the documentation. If it stops being safe, the playbook is
  // telling readers to do something this repository does not itself do.
  it('passes every rule', () => {
    expect(formatFindings(auditMigrations(migrations))).toBe('');
  });

  it('walks expand → backfill → contract, with the drop last', () => {
    expect(migrations.map((m) => m.header.get('phase'))).toEqual([
      'baseline',
      'expand',
      'expand',
      'backfill',
      'expand',
      'expand',
      'expand',
      'contract',
    ]);
  });

  it('leaves releases between the last reader and the drop', () => {
    const contract = migrations[migrations.length - 1];

    expect(contract.header.get('safe-after')).toBe('1.6.0');
    expect(contract.header.get('release')).toBe('1.7.0');
  });
});
