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
const commitAndPush = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/git-sync', () => ({
  GitSync: jest.fn().mockImplementation((_dataPath: string, remote?: string) => ({
    enabled: !!remote,
    ensureRepo,
    pull,
    commitAndPush,
  })),
}));

const backfill = jest.fn().mockResolvedValue(0);

jest.mock('../src/search', () => ({
  SearchService: jest.fn().mockImplementation(() => ({ backfill })),
}));

jest.mock('../src/embeddings', () => ({
  EmbeddingService: {
    getInstance: jest.fn(() => ({ mocked: true })),
  },
}));

const resolveDataPath = jest.fn(() => '/resolved/data/path');

jest.mock('../src/paths', () => ({
  resolveDataPath,
}));

import { PrivateJournalServer } from '../src/server';
import { runSync, main } from '../src/index';

describe('runSync', () => {
  beforeEach(() => {
    ensureRepo.mockClear();
    pull.mockClear();
    commitAndPush.mockClear();
    backfill.mockClear();
    resolveDataPath.mockClear();
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
  });
});

describe('main', () => {
  beforeEach(() => {
    ensureRepo.mockClear();
    pull.mockClear();
    commitAndPush.mockClear();
    backfill.mockClear();
    resolveDataPath.mockClear();
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
