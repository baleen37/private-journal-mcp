import { EmbeddingService } from '../src/embeddings';

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

describe('generateEmbedding', () => {
  it('delegates text and kind to the global embedding broker', async () => {
    const embedText = jest.fn().mockResolvedValue([0.1, 0.2]);
    const service = new EmbeddingService({ embedText } as any);

    await expect(service.generateEmbedding('hello', 'query')).resolves.toEqual([0.1, 0.2]);
    expect(embedText).toHaveBeenCalledWith('hello', 'query');
  });
});
