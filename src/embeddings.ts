import * as fs from 'fs/promises';
import { EmbeddingData } from './types';
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

  embeddingPathFor(mdPath: string): string {
    return mdPath.replace(/\.md$/, '.embedding');
  }

  async saveEmbedding(mdPath: string, data: EmbeddingData): Promise<void> {
    const target = this.embeddingPathFor(mdPath);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  }

  async loadEmbedding(mdPath: string): Promise<EmbeddingData | null> {
    try {
      const raw = await fs.readFile(this.embeddingPathFor(mdPath), 'utf8');
      return JSON.parse(raw) as EmbeddingData;
    } catch {
      return null;
    }
  }

  async generateEmbedding(text: string, kind: 'passage' | 'query'): Promise<number[]> {
    return this.broker.embedText(text, kind);
  }
}
