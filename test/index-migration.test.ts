import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { EmbeddingService, extractSearchableText } from '../src/embeddings';
import { openJournalIndex, EMBEDDING_DIMENSION, INDEX_FILE_NAME } from '../src/index-db';
import { migrateLegacyIndex } from '../src/index-migration';
import { parseSections, renderEntry } from '../src/journal';
import { SearchService } from '../src/search';

function vector(first: number, second = 0): number[] {
  return [first, second, ...Array<number>(EMBEDDING_DIMENSION - 2).fill(0)];
}

function fakeEmbeddings(result: number[] = vector(0.5, 0.5)) {
  const embedText = jest.fn(async () => result);
  return { service: new EmbeddingService({ embedText }), embedText };
}

async function writeMarkdown(
  dataPath: string,
  name: string,
  content: string,
  when = new Date('2026-08-04T10:00:00.000Z'),
): Promise<string> {
  const mdPath = path.join(dataPath, name);
  await fs.mkdir(path.dirname(mdPath), { recursive: true });
  await fs.writeFile(mdPath, renderEntry({ reflections: content }, 'Legacy index entry', when), 'utf8');
  return mdPath;
}

describe('migrateLegacyIndex', () => {
  it('applies revision 0 -> 1, imports valid sidecars, recomputes invalid ones, and removes sidecars', async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-index-migration-'));
    await fs.mkdir(path.join(dataPath, '.git', 'info'), { recursive: true });
    const validPath = await writeMarkdown(dataPath, '2026-08-04/valid.md', 'valid entry');
    const invalidPath = await writeMarkdown(dataPath, '2026-08-04/invalid.md', 'invalid entry', new Date('2026-08-04T11:00:00.000Z'));
    const validMd = await fs.readFile(validPath, 'utf8');
    const validText = extractSearchableText(validMd);
    const validSections = parseSections(validMd);
    await fs.writeFile(validPath.replace(/\.md$/, '.embedding'), JSON.stringify({
      embedding: vector(1),
      text: validText,
      sections: validSections,
      timestamp: Date.parse('2026-08-04T10:00:00.000Z'),
      path: validPath,
    }), 'utf8');
    await fs.writeFile(invalidPath.replace(/\.md$/, '.embedding'), JSON.stringify({
      embedding: [1, 0],
      text: 'stale',
      sections: [],
      timestamp: 0,
      path: invalidPath,
    }), 'utf8');

    const { service, embedText } = fakeEmbeddings(vector(0, 1));
    const result = await migrateLegacyIndex({ dataPath, embeddings: service });

    expect(result.fromRevision).toBe(0);
    expect(result.toRevision).toBe(1);
    expect(result.indexed).toBe(2);
    expect(result.recomputed).toBe(1);
    expect(result.removedSidecars).toBe(2);
    expect(embedText).toHaveBeenCalledTimes(1);
    await expect(fs.access(path.join(dataPath, INDEX_FILE_NAME))).resolves.toBeUndefined();
    await expect(fs.access(validPath.replace(/\.md$/, '.embedding'))).rejects.toBeDefined();
    await expect(fs.access(invalidPath.replace(/\.md$/, '.embedding'))).rejects.toBeDefined();
    await expect(fs.readFile(path.join(dataPath, '.git', 'info', 'exclude'), 'utf8'))
      .resolves.toEqual(expect.stringContaining(INDEX_FILE_NAME));

    const index = openJournalIndex(dataPath);
    expect(index.search(vector(1), { limit: 2 })[0].path).toBe(validPath);
    index.close();

    const second = await migrateLegacyIndex({ dataPath, embeddings: service });
    expect(second.fromRevision).toBe(1);
    expect(second.toRevision).toBe(1);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it('leaves sidecars and the existing index untouched when migration fails', async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-index-migration-fail-'));
    const mdPath = await writeMarkdown(dataPath, '2026-08-04/failing.md', 'failing entry');
    const sidecar = mdPath.replace(/\.md$/, '.embedding');
    await fs.writeFile(sidecar, '{"not":"valid"}', 'utf8');
    const { service } = fakeEmbeddings();
    jest.spyOn(service, 'generateEmbedding').mockRejectedValue(new Error('embedding unavailable'));

    await expect(migrateLegacyIndex({ dataPath, embeddings: service })).rejects.toThrow('embedding unavailable');
    await expect(fs.readFile(sidecar, 'utf8')).resolves.toBe('{"not":"valid"}');
    await expect(fs.access(path.join(dataPath, INDEX_FILE_NAME))).rejects.toBeDefined();
  });

  it('imports legacy sidecars when a prior server start created an empty revision 1 database', async () => {
    const dataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'journal-index-migration-existing-db-'));
    const mdPath = await writeMarkdown(dataPath, '2026-08-04/existing.md', 'existing entry');
    const md = await fs.readFile(mdPath, 'utf8');
    const { service, embedText } = fakeEmbeddings(vector(0, 1));
    await fs.writeFile(mdPath.replace(/\.md$/, '.embedding'), JSON.stringify({
      embedding: vector(1),
      text: extractSearchableText(md),
      sections: parseSections(md),
      timestamp: Date.parse('2026-08-04T10:00:00.000Z'),
      path: mdPath,
    }), 'utf8');

    const priorServer = new SearchService(dataPath, service);
    priorServer.close();

    const result = await migrateLegacyIndex({ dataPath, embeddings: service });

    expect(result.fromRevision).toBe(0);
    expect(result.toRevision).toBe(1);
    expect(result.indexed).toBe(1);
    expect(result.recomputed).toBe(0);
    expect(embedText).not.toHaveBeenCalled();
    const index = openJournalIndex(dataPath);
    expect(index.getEntryCount()).toBe(1);
    index.close();
    await expect(fs.access(mdPath.replace(/\.md$/, '.embedding'))).rejects.toBeDefined();
  });
});
