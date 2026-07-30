import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  DataVersionError,
  MIGRATION_TRANSACTION_FILENAME,
  MigrationManager,
  type Migration,
} from '../src/migrations';

it('initializes a versionless existing data directory at version 1', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, 'entry.md'), '# existing\n', 'utf8');

  await new MigrationManager(dir).run();

  await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
    .resolves.toBe('{"version":1}\n');
});

it('does not rewrite an existing current version file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const versionPath = path.join(dir, '.private-journal-version.json');
  await fs.writeFile(versionPath, '{"version":1}\n', 'utf8');
  await fs.chmod(versionPath, 0o444);

  try {
    await expect(new MigrationManager(dir).run()).resolves.toBeUndefined();
  } finally {
    await fs.chmod(versionPath, 0o644);
  }
});

it('applies each consecutive migration in order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
  const calls: string[] = [];
  const migrations: Migration[] = [
    { from: 1, to: 2, apply: async () => { calls.push('1->2'); return { invalidatedMarkdownPaths: [] }; } },
    { from: 2, to: 3, apply: async () => { calls.push('2->3'); return { invalidatedMarkdownPaths: [] }; } },
  ];

  await new MigrationManager(dir, migrations, 3).run();

  expect(calls).toEqual(['1->2', '2->3']);
  await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
    .resolves.toBe('{"version":3}\n');
});

it.each(['not json', '{"version":0}', '{"version":1.5}', '{"version":"2"}'])
('rejects malformed version metadata: %s', async (raw) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), raw, 'utf8');

  await expect(new MigrationManager(dir).run()).rejects.toThrow(DataVersionError);
});

it('rejects future data without changing its version file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const versionPath = path.join(dir, '.private-journal-version.json');
  await fs.writeFile(versionPath, '{"version":2}\n', 'utf8');

  await expect(new MigrationManager(dir).run()).rejects.toThrow('newer than this app');
  await expect(fs.readFile(versionPath, 'utf8')).resolves.toBe('{"version":2}\n');
});

it('rejects a missing consecutive migration without changing data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const versionPath = path.join(dir, '.private-journal-version.json');
  await fs.writeFile(versionPath, '{"version":1}\n', 'utf8');

  await expect(new MigrationManager(dir, [], 2).run()).rejects.toThrow(DataVersionError);
  await expect(fs.readFile(versionPath, 'utf8')).resolves.toBe('{"version":1}\n');
});

it('rejects a non-positive registry from version even when no migration runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const migrations: Migration[] = [
    { from: 0, to: 1, apply: async () => ({ invalidatedMarkdownPaths: [] }) },
  ];

  await expect(new MigrationManager(dir, migrations).run()).rejects.toThrow(DataVersionError);
});

it('rejects a non-consecutive registry transition even when no migration runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const migrations: Migration[] = [
    { from: 2, to: 4, apply: async () => ({ invalidatedMarkdownPaths: [] }) },
  ];

  await expect(new MigrationManager(dir, migrations).run()).rejects.toThrow(DataVersionError);
});

it('rejects duplicate registry from versions even when no migration runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const migrations: Migration[] = [
    { from: 2, to: 3, apply: async () => ({ invalidatedMarkdownPaths: [] }) },
    { from: 2, to: 3, apply: async () => ({ invalidatedMarkdownPaths: [] }) },
  ];

  await expect(new MigrationManager(dir, migrations).run()).rejects.toThrow(DataVersionError);
});

it('preserves the original data when a migration fails in its stage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const entryPath = path.join(dir, 'entry.md');
  const versionPath = path.join(dir, '.private-journal-version.json');
  await fs.writeFile(entryPath, '# original\n', 'utf8');
  await fs.writeFile(versionPath, '{"version":1}\n', 'utf8');
  const failingMigration: Migration = {
    from: 1,
    to: 2,
    apply: async (stagePath) => {
      await fs.writeFile(path.join(stagePath, 'entry.md'), '# changed\n', 'utf8');
      throw new Error('conversion failed');
    },
  };

  await expect(new MigrationManager(dir, [failingMigration], 2).run()).rejects.toThrow('conversion failed');
  await expect(fs.readFile(entryPath, 'utf8')).resolves.toBe('# original\n');
  await expect(fs.readFile(versionPath, 'utf8')).resolves.toBe('{"version":1}\n');
});

it('leaves the original markdown, metadata, and embedding intact when stage migration fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const mdPath = path.join(dir, 'entry.md');
  await fs.writeFile(mdPath, 'old format', 'utf8');
  await fs.writeFile(path.join(dir, 'entry.embedding'), 'old embedding', 'utf8');
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n', 'utf8');
  const failing: Migration = {
    from: 1,
    to: 2,
    apply: async (stage) => {
      await fs.writeFile(path.join(stage, 'entry.md'), 'partially changed', 'utf8');
      throw new Error('cannot convert entry.md');
    },
  };

  await expect(new MigrationManager(dir, [failing], 2).run()).rejects.toThrow('cannot convert entry.md');
  await expect(fs.readFile(mdPath, 'utf8')).resolves.toBe('old format');
  await expect(fs.readFile(path.join(dir, 'entry.embedding'), 'utf8')).resolves.toBe('old embedding');
});

it('removes only the sidecar for markdown changed by a successful migration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
  await fs.writeFile(path.join(dir, 'changed.md'), 'old', 'utf8');
  await fs.writeFile(path.join(dir, 'changed.embedding'), 'old sidecar', 'utf8');
  await fs.writeFile(path.join(dir, 'unchanged.md'), 'steady', 'utf8');
  await fs.writeFile(path.join(dir, 'unchanged.embedding'), 'steady sidecar', 'utf8');
  const change: Migration = {
    from: 1,
    to: 2,
    apply: async (stage) => {
      await fs.writeFile(path.join(stage, 'changed.md'), 'new', 'utf8');
      return { invalidatedMarkdownPaths: ['changed.md'] };
    },
  };

  await new MigrationManager(dir, [change], 2).run();

  await expect(fs.access(path.join(dir, 'changed.embedding'))).rejects.toBeDefined();
  await expect(fs.readFile(path.join(dir, 'unchanged.embedding'), 'utf8')).resolves.toBe('steady sidecar');
});

it('restores the backup after an interrupted backed-up activation', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-parent-'));
  const dataPath = path.join(parent, 'data');
  const backupPath = path.join(parent, 'backup');
  const stagePath = path.join(parent, 'stage');
  const transactionPath = path.join(parent, MIGRATION_TRANSACTION_FILENAME);
  await Promise.all([fs.mkdir(dataPath), fs.mkdir(backupPath), fs.mkdir(stagePath)]);
  await fs.writeFile(path.join(backupPath, 'entry.md'), 'original', 'utf8');
  await fs.writeFile(path.join(backupPath, '.private-journal-version.json'), '{"version":1}\n');
  await fs.writeFile(path.join(stagePath, 'entry.md'), 'migrated', 'utf8');
  await fs.writeFile(transactionPath, JSON.stringify({
    state: 'backed-up', dataPath, backupPath, stagePath,
  }), 'utf8');

  await new MigrationManager(dataPath).run();

  await expect(fs.readFile(path.join(dataPath, 'entry.md'), 'utf8')).resolves.toBe('original');
  await expect(fs.access(transactionPath)).rejects.toBeDefined();
});

it('does not copy git metadata or the sync lock into a migration stage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await Promise.all([
    fs.mkdir(path.join(dir, '.git')),
    fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n'),
    fs.writeFile(path.join(dir, '.private-journal-sync.lock'), '{}\n'),
  ]);
  const migration: Migration = {
    from: 1,
    to: 2,
    apply: async (stage) => {
      await expect(fs.access(path.join(stage, '.git'))).rejects.toBeDefined();
      await expect(fs.access(path.join(stage, '.private-journal-sync.lock'))).rejects.toBeDefined();
      return { invalidatedMarkdownPaths: [] };
    },
  };

  await new MigrationManager(dir, [migration], 2).run();

  await expect(fs.access(path.join(dir, '.git'))).resolves.toBeUndefined();
  await expect(fs.access(path.join(dir, '.private-journal-sync.lock'))).resolves.toBeUndefined();
});

it.each(['/outside.md', '../outside.md', 'entry.txt'])
('rejects invalidated markdown paths outside the staged relative markdown namespace: %s', async (invalidatedPath) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
  const migration: Migration = {
    from: 1,
    to: 2,
    apply: async () => ({ invalidatedMarkdownPaths: [invalidatedPath] }),
  };

  await expect(new MigrationManager(dir, [migration], 2).run()).rejects.toThrow(DataVersionError);
});

it('removes every staged embedding when a migration invalidates all embeddings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.mkdir(path.join(dir, 'nested'));
  await Promise.all([
    fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n'),
    fs.writeFile(path.join(dir, 'entry.embedding'), 'root', 'utf8'),
    fs.writeFile(path.join(dir, 'nested', 'entry.embedding'), 'nested', 'utf8'),
  ]);
  const migration: Migration = {
    from: 1,
    to: 2,
    apply: async () => ({ invalidatedMarkdownPaths: [], invalidateAllEmbeddings: true }),
  };

  await new MigrationManager(dir, [migration], 2).run();

  await expect(fs.access(path.join(dir, 'entry.embedding'))).rejects.toBeDefined();
  await expect(fs.access(path.join(dir, 'nested', 'entry.embedding'))).rejects.toBeDefined();
});

it('rejects an interrupted transaction with paths outside the data parent', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-parent-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-outside-'));
  const dataPath = path.join(parent, 'data');
  const transactionPath = path.join(parent, MIGRATION_TRANSACTION_FILENAME);
  await Promise.all([fs.mkdir(dataPath), fs.mkdir(path.join(outside, 'backup')), fs.mkdir(path.join(outside, 'stage'))]);
  await fs.writeFile(transactionPath, JSON.stringify({
    state: 'backed-up',
    dataPath,
    backupPath: path.join(outside, 'backup'),
    stagePath: path.join(outside, 'stage'),
  }), 'utf8');

  await expect(new MigrationManager(dataPath).run()).rejects.toThrow(DataVersionError);
  await expect(fs.access(transactionPath)).resolves.toBeUndefined();
});

it('restores original data when activation cannot move a staged file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const entryPath = path.join(dir, 'entry.md');
  const versionPath = path.join(dir, '.private-journal-version.json');
  await fs.writeFile(entryPath, '# original\n', 'utf8');
  await fs.writeFile(versionPath, '{"version":1}\n', 'utf8');
  await fs.mkdir(path.join(dir, '.git'));
  const migration: Migration = {
    from: 1,
    to: 2,
    apply: async (stage) => {
      await fs.writeFile(path.join(stage, 'entry.md'), '# changed\n', 'utf8');
      await fs.writeFile(path.join(stage, '.git'), 'conflict', 'utf8');
      return { invalidatedMarkdownPaths: ['entry.md'] };
    },
  };

  await expect(new MigrationManager(dir, [migration], 2).run()).rejects.toThrow();

  await expect(fs.readFile(entryPath, 'utf8')).resolves.toBe('# original\n');
  await expect(fs.readFile(versionPath, 'utf8')).resolves.toBe('{"version":1}\n');
});
