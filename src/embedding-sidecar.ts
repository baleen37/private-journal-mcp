import crypto from 'crypto';
import * as fs from 'fs/promises';
import { EmbeddingData } from './types';

export async function writeEmbeddingAtomically(mdPath: string, data: EmbeddingData): Promise<void> {
  const target = mdPath.replace(/\.md$/, '.embedding');
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}

export async function hasValidEmbedding(mdPath: string): Promise<boolean> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(mdPath.replace(/\.md$/, '.embedding'), 'utf8'));
    if (!data || typeof data !== 'object') return false;
    const embedding = data as EmbeddingData;
    return Array.isArray(embedding.embedding)
      && embedding.embedding.every((value) => typeof value === 'number')
      && typeof embedding.text === 'string'
      && Array.isArray(embedding.sections)
      && embedding.sections.every((value) => typeof value === 'string')
      && typeof embedding.timestamp === 'number'
      && typeof embedding.path === 'string';
  } catch {
    return false;
  }
}
