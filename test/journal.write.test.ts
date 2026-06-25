import { JournalManager } from '../src/journal';
import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('JournalManager.write', () => {
  it('writes .md and .embedding under dated dir', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
    const emb = EmbeddingService.getInstance();
    jest.spyOn(emb, 'generateEmbedding').mockResolvedValue([0.1, 0.2, 0.3]);

    const jm = new JournalManager(dir, emb);
    const when = new Date('2026-06-25T01:02:03.000Z');
    const mdPath = await jm.write({ reflections: '오늘의 회고' }, when);

    expect(mdPath.endsWith('.md')).toBe(true);
    const md = await fs.readFile(mdPath, 'utf8');
    expect(md).toContain('오늘의 회고');

    const embPath = mdPath.replace(/\.md$/, '.embedding');
    const embData = JSON.parse(await fs.readFile(embPath, 'utf8'));
    expect(embData.sections).toContain('reflections');
    expect(embData.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('hasContent is false when all sections empty', () => {
    const jm = new JournalManager('/tmp', EmbeddingService.getInstance());
    expect(jm.hasContent({})).toBe(false);
    expect(jm.hasContent({ reflections: '   ' })).toBe(false);
    expect(jm.hasContent({ reflections: 'x' })).toBe(true);
  });

  it('still returns md path if embedding generation fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jm-'));
    const emb = EmbeddingService.getInstance();
    jest.spyOn(emb, 'generateEmbedding').mockRejectedValue(new Error('model fail'));
    const jm = new JournalManager(dir, emb);
    const mdPath = await jm.write({ reflections: 'x' });
    expect(mdPath.endsWith('.md')).toBe(true);
  });
});
