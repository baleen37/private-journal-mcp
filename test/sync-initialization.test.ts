import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { runSync } from '../src/index';

describe('runSync initialization', () => {
  const remoteEnvKeys = ['PRIVATE_JOURNAL_GIT_REMOTE', 'CLAUDE_PLUGIN_OPTION_GIT_REMOTE'] as const;
  const inheritedRemoteEnv = Object.fromEntries(
    remoteEnvKeys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof remoteEnvKeys)[number], string | undefined>;

  beforeAll(() => {
    for (const key of remoteEnvKeys) delete process.env[key];
  });

  afterAll(() => {
    for (const key of remoteEnvKeys) {
      const value = inheritedRemoteEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('creates a missing local-only data path before running migrations', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-init-'));
    const dir = path.join(parent, 'journal');

    await runSync({ dataPath: dir, remote: undefined });

    await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
      .resolves.toBe('{"version":2}\n');
  });
});
