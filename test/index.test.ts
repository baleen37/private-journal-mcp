import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const mockSpawn = jest.fn();

jest.mock('child_process', () => ({ spawn: mockSpawn }));

jest.mock('../src/server', () => {
  const run = jest.fn().mockResolvedValue(undefined);
  return {
    PrivateJournalServer: jest.fn().mockImplementation(() => ({ run })),
  };
});

const mockWorkerListen = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/embedding-worker', () => ({
  EmbeddingWorker: jest.fn().mockImplementation(() => ({ listen: mockWorkerListen })),
}));

const mockRuntimePaths = {
  directory: '/runtime/private-journal',
  socketPath: '/runtime/private-journal/embedding.sock',
  startupLockPath: '/runtime/private-journal/embedding.startup.lock',
  pidPath: '/runtime/private-journal/embedding.pid',
};

jest.mock('../src/embedding-runtime', () => ({
  resolveEmbeddingRuntimePaths: jest.fn(() => mockRuntimePaths),
}));

const ensureRepo = jest.fn().mockResolvedValue(undefined);
const pull = jest.fn().mockResolvedValue([]);
const commitAndPush = jest.fn().mockResolvedValue([]);
const lastPullCompleted = { value: true };

jest.mock('../src/git-sync', () => ({
  GitSync: jest.fn().mockImplementation((_dataPath: string, remote?: string) => ({
    enabled: !!remote,
    lastPullCompleted: lastPullCompleted.value,
    ensureRepo,
    pull,
    commitAndPush,
  })),
}));

const mockMigrationsRun = jest.fn().mockResolvedValue(false);

jest.mock('../src/migrations', () => ({
  CURRENT_DATA_VERSION: 2,
  MigrationManager: jest.fn().mockImplementation(() => ({ run: mockMigrationsRun })),
}));

const backfill = jest.fn().mockResolvedValue(0);
const backfillPaths = jest.fn().mockResolvedValue(0);
const needsInitialBackfill = jest.fn().mockReturnValue(false);

jest.mock('../src/search', () => ({
  SearchService: jest.fn().mockImplementation(() => ({ backfill, backfillPaths, needsInitialBackfill })),
}));

jest.mock('../src/index-migration', () => ({
  migrateLegacyIndex: jest.fn().mockResolvedValue({
    dbPath: '/resolved/data/path/.private-journal-index.sqlite',
    fromRevision: 0,
    toRevision: 1,
    indexed: 1,
    recomputed: 1,
    removedSidecars: 1,
  }),
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
import { EmbeddingWorker } from '../src/embedding-worker';
import { PrivateJournalServer } from '../src/server';
import { runSync, main } from '../src/index';
import { migrateLegacyIndex } from '../src/index-migration';

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
    mockMigrationsRun.mockClear();
    backfill.mockClear();
    backfillPaths.mockClear();
    needsInitialBackfill.mockReset();
    needsInitialBackfill.mockReturnValue(false);
    resolveDataPath.mockClear();
    resolveGitRemote.mockReset();
    resolveGitRemote.mockImplementation((remote?: string) => remote);
    (GitSync as jest.Mock).mockClear();
  });

  it('runs migration without scanning when remote is undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idx-'));

    await runSync({ dataPath: dir, remote: undefined });

    const hasGit = await fs.access(path.join(dir, '.git')).then(() => true).catch(() => false);
    expect(hasGit).toBe(false);
    expect(ensureRepo).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
    expect(commitAndPush).not.toHaveBeenCalled();
    expect(mockMigrationsRun).toHaveBeenCalledTimes(1);
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
    pull.mockResolvedValueOnce(['/data/2026-07-30/a.md', '/data/2026-07-30/b.md']);

    await runSync({ dataPath: '/resolved/data/path' });

    expect(backfillPaths).toHaveBeenCalledWith(['/data/2026-07-30/a.md', '/data/2026-07-30/b.md']);
    expect(backfill).not.toHaveBeenCalled();
  });

  it('does not scan the corpus when the sync pulled nothing', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');
    pull.mockResolvedValueOnce([]);

    await runSync({ dataPath: '/resolved/data/path' });

    expect(backfillPaths).not.toHaveBeenCalled();
    expect(backfill).not.toHaveBeenCalled();
  });

  it('backfills an incomplete index when the initial pull reports no paths', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');
    needsInitialBackfill.mockReturnValueOnce(true);
    pull.mockResolvedValueOnce([]);

    await runSync({ dataPath: '/resolved/data/path' });

    expect(backfill).toHaveBeenCalledTimes(1);
    expect(backfillPaths).not.toHaveBeenCalled();
  });

  it('runs migration after pull and before sync commit', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');

    await runSync({ dataPath: '/resolved/data/path' });

    expect(pull.mock.invocationCallOrder[0]).toBeLessThan(mockMigrationsRun.mock.invocationCallOrder[0]);
    expect(mockMigrationsRun.mock.invocationCallOrder[0]).toBeLessThan(commitAndPush.mock.invocationCallOrder[0]);
    expect(commitAndPush).toHaveBeenCalledWith(
      expect.any(String),
      2,
      { remoteAlreadyPulled: true },
    );
  });

  it('indexes Markdown paths returned by the local commit', async () => {
    resolveGitRemote.mockReturnValue('resolved.git');
    commitAndPush.mockResolvedValueOnce(['/resolved/data/path/2026-08-04/local.md']);

    await runSync({ dataPath: '/resolved/data/path' });

    expect(backfillPaths).toHaveBeenCalledWith(['/resolved/data/path/2026-08-04/local.md']);
  });
});

describe('main', () => {
  beforeEach(() => {
    ensureRepo.mockClear();
    pull.mockClear();
    commitAndPush.mockClear();
    mockMigrationsRun.mockClear();
    backfill.mockClear();
    backfillPaths.mockClear();
    needsInitialBackfill.mockReset();
    needsInitialBackfill.mockReturnValue(false);
    resolveDataPath.mockClear();
    resolveGitRemote.mockReset();
    resolveGitRemote.mockImplementation((remote?: string) => remote);
    (GitSync as jest.Mock).mockClear();
    (EmbeddingWorker as jest.Mock).mockClear();
    mockWorkerListen.mockClear();
    (PrivateJournalServer as jest.Mock).mockClear();
    mockSpawn.mockReset();
    jest.mocked(migrateLegacyIndex).mockClear();
  });

  it('dispatches embedding-worker before sync or MCP startup', async () => {
    await main(['node', 'index.js', 'embedding-worker']);

    expect(EmbeddingWorker).toHaveBeenCalledWith({
      runtimePaths: mockRuntimePaths,
      idleMs: 0,
    });
    expect(mockWorkerListen).toHaveBeenCalledTimes(1);
    expect(resolveDataPath).not.toHaveBeenCalled();
    expect(mockMigrationsRun).not.toHaveBeenCalled();
    expect(ensureRepo).not.toHaveBeenCalled();
    expect(PrivateJournalServer).not.toHaveBeenCalled();
  });

  it('dispatches sync subcommand to runSync', async () => {
    await main(['node', 'index.js', 'sync']);

    expect(resolveDataPath).toHaveBeenCalledTimes(1);
    expect(ensureRepo).not.toHaveBeenCalled();
    expect(PrivateJournalServer).not.toHaveBeenCalled();
  });

  it('dispatches migrate-index to the revision migration runner', async () => {
    await main(['node', 'index.js', 'migrate-index']);

    expect(migrateLegacyIndex).toHaveBeenCalledWith({ dataPath: '/resolved/data/path' });
    expect(PrivateJournalServer).not.toHaveBeenCalled();
  });

  it('detaches background sync without running it in the parent', async () => {
    const unref = jest.fn();
    mockSpawn.mockReturnValue({ unref });

    await main(['node', 'index.js', 'sync', '--background']);

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      ['index.js', 'sync'],
      { detached: true, stdio: 'ignore' },
    );
    expect(unref).toHaveBeenCalledTimes(1);
    expect(resolveDataPath).not.toHaveBeenCalled();
    expect(ensureRepo).not.toHaveBeenCalled();
  });

  it('runs the server by default', async () => {
    await main(['node', 'index.js']);

    expect(PrivateJournalServer).toHaveBeenCalledTimes(1);
  });
});
