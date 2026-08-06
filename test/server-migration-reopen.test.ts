import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService } from '../src/embeddings';
import { PrivateJournalServer } from '../src/server';
import { SearchService } from '../src/search';

function vector(): number[] {
  return [1, ...Array<number>(383).fill(0)];
}

describe('PrivateJournalServer data migration', () => {
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

  it('reopens the SQLite index after replacing the migrated data directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-migration-reopen-'));
    const embedding = EmbeddingService.getInstance();
    jest.spyOn(embedding, 'generateEmbedding').mockResolvedValue(vector());
    await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
    await fs.writeFile(
      path.join(dir, 'legacy.md'),
      '---\ntitle: Legacy entry\ndate: 2026-08-01T00:00:00.000Z\n---\n\n## Observations\n\nlegacy\n',
    );

    const server = new PrivateJournalServer({ dataPath: dir });
    await server.initialize();
    const { path: newEntry } = await server.handleWrite({ title: 'New entry', content: 'new' });

    const restarted = new SearchService(dir, embedding);
    try {
      const entries = await restarted.listRecent({ limit: 10, days: 3650 });
      expect(entries.map((entry) => entry.path)).toContain(newEntry);
    } finally {
      restarted.close();
      (server as any).search.close();
    }
  });
});
