import { resolveModelCachePath } from './paths';

const MODEL = 'Xenova/multilingual-e5-small';

export class EmbeddingEngine {
  private extractor: any | null = null;
  private loading: Promise<any> | null = null;

  async embed(text: string, kind: 'passage' | 'query'): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }

  private async getExtractor(): Promise<any> {
    if (this.extractor) return this.extractor;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const { pipeline, env } = await import('@huggingface/transformers');
          env.cacheDir = resolveModelCachePath();
          this.extractor = await pipeline('feature-extraction', MODEL);
          return this.extractor;
        } catch (error) {
          this.loading = null;
          throw error;
        }
      })();
    }
    return this.loading;
  }
}
