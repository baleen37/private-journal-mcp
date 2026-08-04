import { EmbeddingBroker } from './embedding-broker';

interface EmbeddingClient {
  embedText(text: string, kind: 'passage' | 'query'): Promise<number[]>;
}

export function extractSearchableText(md: string): string {
  const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return withoutFm.replace(/^##\s+/gm, '').trim();
}

export class EmbeddingService {
  private static instance: EmbeddingService;

  constructor(private readonly broker: EmbeddingClient = new EmbeddingBroker()) {}

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
    return extractSearchableText(md);
  }

  async generateEmbedding(text: string, kind: 'passage' | 'query'): Promise<number[]> {
    return this.broker.embedText(text, kind);
  }
}
