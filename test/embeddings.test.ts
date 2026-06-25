import { EmbeddingService } from '../src/embeddings';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const svc = EmbeddingService.getInstance();

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(svc.cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(svc.cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});

describe('extractSearchableText', () => {
  it('strips frontmatter and headings markers', () => {
    const md = '---\ntitle: "t"\ndate: d\ntimestamp: 1\n---\n\n## Reflections\n\nhello world\n';
    const text = svc.extractSearchableText(md);
    expect(text).toContain('hello world');
    expect(text).not.toContain('timestamp');
    expect(text).not.toContain('---');
  });
});

describe('embeddingPathFor', () => {
  it('swaps .md for .embedding', () => {
    expect(svc.embeddingPathFor('/a/b/c.md')).toBe('/a/b/c.embedding');
  });
});

describe('save/loadEmbedding', () => {
  it('round-trips embedding data', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emb-'));
    const mdPath = path.join(dir, 'x.md');
    const data = { embedding: [0.1, 0.2], text: 't', sections: ['reflections'], timestamp: 5, path: mdPath };
    await svc.saveEmbedding(mdPath, data);
    const loaded = await svc.loadEmbedding(mdPath);
    expect(loaded).toEqual(data);
  });
  it('returns null when embedding file missing', async () => {
    expect(await svc.loadEmbedding('/no/such/file.md')).toBeNull();
  });
  it('returns null when embedding file contains invalid JSON', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emb-'));
    const mdPath = path.join(dir, 'corrupt.md');
    const embPath = mdPath.replace(/\.md$/, '.embedding');
    await fs.writeFile(embPath, 'not valid json {]', 'utf8');
    const loaded = await svc.loadEmbedding(mdPath);
    expect(loaded).toBeNull();
  });
});
