import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DataVersionError, MigrationManager, type Migration } from '../src/migrations';

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
