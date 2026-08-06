import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { MigrationManager } from '../src/migrations';

describe('data migration 1 -> 2', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-data-migration-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('converts legacy date to created_at and removes legacy keys', async () => {
    await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
    await fs.writeFile(
      path.join(dir, 'entry.md'),
      '---\ntitle: "Legacy title"\ndate: 2026-06-25T12:34:56.789Z\ntimestamp: 1\n---\n\nbody\n',
    );
    await fs.writeFile(path.join(dir, 'entry.embedding'), 'stale');

    await expect(new MigrationManager(dir).run()).resolves.toBe(true);

    const migrated = await fs.readFile(path.join(dir, 'entry.md'), 'utf8');
    expect(migrated).toContain('title: Legacy title');
    expect(migrated).toContain('created_at: 2026-06-25T12:34:56.789Z');
    expect(migrated).not.toContain('date:');
    expect(migrated).not.toContain('timestamp:');
    expect(migrated).toContain('body');
    await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
      .resolves.toBe('{"version":2}\n');
    await expect(fs.access(path.join(dir, 'entry.embedding'))).rejects.toBeDefined();
  });

  it('uses legacy timestamp when date is absent or invalid', async () => {
    const timestamp = 1782390896789;
    await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
    await fs.writeFile(
      path.join(dir, 'entry.md'),
      `---\ntitle: "Legacy"\ndate: invalid\ntimestamp: ${timestamp}\n---\n\nbody\n`,
    );

    await new MigrationManager(dir).run();

    await expect(fs.readFile(path.join(dir, 'entry.md'), 'utf8'))
      .resolves.toContain(`created_at: ${new Date(timestamp).toISOString()}`);
  });

  it('keeps the original data when conversion fails', async () => {
    const original = '---\ntitle: "Broken"\n---\n\nbody\n';
    await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
    await fs.writeFile(path.join(dir, 'entry.md'), original);

    await expect(new MigrationManager(dir).run()).rejects.toThrow('entry.md');
    await expect(fs.readFile(path.join(dir, 'entry.md'), 'utf8')).resolves.toBe(original);
    await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
      .resolves.toBe('{"version":1}\n');
  });
});
