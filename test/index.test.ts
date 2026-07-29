import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/server', () => {
  const run = jest.fn().mockResolvedValue(undefined);
  return {
    PrivateJournalServer: jest.fn().mockImplementation(() => ({ run })),
  };
});

const ensureRepo = jest.fn().mockResolvedValue(undefined);
const pull = jest.fn().mockResolvedValue(undefined);
const commitAndPush = jest.fn().mockResolvedValue([]);

jest.mock('../src/git-sync', () => ({
  GitSync: jest.fn().mockImplementation((_dataPath: string, remote?: string) => ({
    enabled: !!remote,
    ensureRepo,
    pull,
    commitAndPush,
  })),
}));

const backfill = jest.fn().mockResolvedValue(0);
const backfillPaths = jest.fn().mockResolvedValue(0);

jest.mock('../src/search', () => ({
  SearchService: jest.fn().mockImplementation(() => ({ backfill, backfillPaths })),
}));

jest.mock('../src/embeddings', () => ({
  EmbeddingService: {
    getInstance: jest.fn(() => ({ mocked: true })),
  },
}));

const resolveDataPath = jest.fn(() => '/resolved/data/path');
const resolveGitRemote = jest.fn((remote?: string) => remote);

jest.mock('../src/paths', () => ({
  resolveDataPath,
  resolveGitRemote,
}));

import { GitSync } from '../src/git-sync';
import { PrivateJournalServer } from '../src/server';
import { runSync, main } from '../src/index';

// runSync falls back to process.env.PRIVATE_JOURNAL_GIT_REMOTE when opts.remote
// is undefined, so a machine that has the var configured would otherwise see
// these "no remote" tests take the enabled path and fail.
const remoteEnvKeys = [
  'PRIVATE_JOURNAL_GIT_REMOTE',
  'CLAUDE_PLUGIN_OPTION_GIT_REMOTE',
] as const;
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

describe('runSync', () => {
  beforeEach(() => {
    ensureRepo.mockClear();
    pull.mockClear();
    commitAndPush.mockClear();
    backfill.mockClear();
    backfillPaths.mockClear();
    resolveDataPath.mockClear();
    resolveGitRemote.mockReset();
    resolveGitRemote.mockImplementation((remote?: string) => remote);
    (GitSync as jest.Mock).mockClear();
  });

  it('is a no-op when remote is undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idx-'));

    await runSync({ dataPath: dir, remote: undefined });

    const hasGit = await fs.access(path.join(dir, '.git')).then(() => true).catch(() => false);
    expect(hasGit).toBe(false);
    expect(ensureRepo).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
    expect(backfillPaths).not.toHaveBeenCalled();
  });

  it('uses the shared resolver result as the GitSync remote', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');

    await runSync({ dataPath: '/resolved/data/path' });

    expect(resolveGitRemote).toHaveBeenCalledWith(undefined);
    expect(GitSync).toHaveBeenCalledWith('/resolved/data/path', 'resolved.git');
    expect(ensureRepo).toHaveBeenCalledTimes(1);
  });

  it('embeds only the pulled entries instead of scanning the whole corpus', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');
    commitAndPush.mockResolvedValueOnce(['/data/2026-07-30/a.md', '/data/2026-07-30/b.md']);

    await runSync({ dataPath: '/resolved/data/path' });

    expect(backfillPaths).toHaveBeenCalledWith(['/data/2026-07-30/a.md', '/data/2026-07-30/b.md']);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('skips embedding work entirely when the sync pulled nothing', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');
    commitAndPush.mockResolvedValueOnce([]);

    await runSync({ dataPath: '/resolved/data/path' });

    expect(backfillPaths).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  beforeEach(() => {
    ensureRepo.mockClear();
    pull.mockClear();
    commitAndPush.mockClear();
    backfill.mockClear();
    backfillPaths.mockClear();
    resolveDataPath.mockClear();
    resolveGitRemote.mockReset();
    resolveGitRemote.mockImplementation((remote?: string) => remote);
    (GitSync as jest.Mock).mockClear();
    (PrivateJournalServer as jest.Mock).mockClear();
  });

  it('dispatches sync subcommand to runSync', async () => {
    await main(['node', 'index.js', 'sync']);

    expect(resolveDataPath).toHaveBeenCalledTimes(1);
    expect(ensureRepo).not.toHaveBeenCalled();
    expect(PrivateJournalServer).not.toHaveBeenCalled();
  });

  it('runs the server by default', async () => {
    await main(['node', 'index.js']);

    expect(PrivateJournalServer).toHaveBeenCalledTimes(1);
  });
});
