import * as fs from 'fs/promises';
import { EmbeddingData } from './types';
import { resolveModelCachePath } from './paths';

const MODEL = 'Xenova/multilingual-e5-small';
const LOAD_TIMEOUT_MS = 30_000;

export class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: any | null = null;
  private loading: Promise<any> | null = null;

  static getInstance(): EmbeddingService {
    if (!EmbeddingService.instance) EmbeddingService.instance = new EmbeddingService();
    return EmbeddingService.instance;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  extractSearchableText(md: string): string {
    const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
    return withoutFm.replace(/^##\s+/gm, '').trim();
  }

  embeddingPathFor(mdPath: string): string {
    return mdPath.replace(/\.md$/, '.embedding');
  }

  async saveEmbedding(mdPath: string, data: EmbeddingData): Promise<void> {
    await fs.writeFile(this.embeddingPathFor(mdPath), JSON.stringify(data), 'utf8');
  }

  async loadEmbedding(mdPath: string): Promise<EmbeddingData | null> {
    try {
      const raw = await fs.readFile(this.embeddingPathFor(mdPath), 'utf8');
      return JSON.parse(raw) as EmbeddingData;
    } catch {
      return null;
    }
  }

  private async getExtractor(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const { pipeline, env } = await import('@xenova/transformers');
          env.cacheDir = resolveModelCachePath();
          const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error('embedding model load timed out')), LOAD_TIMEOUT_MS),
          );
          this.extractor = await Promise.race([
            pipeline('feature-extraction', MODEL),
            timeout,
          ]);
          return this.extractor;
        } catch (e) {
          this.loading = null;
          throw e;
        }
      })();
    }
    return this.loading;
  }

  async generateEmbedding(text: string, kind: 'passage' | 'query'): Promise<number[]> {
    const extractor = await this.getExtractor();
    const prefixed = `${kind}: ${text}`;
    const output = await extractor(prefixed, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }
}
