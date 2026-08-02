import crypto from 'crypto';
import * as fs from 'fs/promises';
import { extractSearchableText } from './embeddings';
import { parseFrontmatter, parseSections } from './journal';
import { EmbeddingData } from './types';

export type EmbeddingMetadata = Omit<EmbeddingData, 'embedding'>;

export function embeddingMetadata(mdPath: string, markdown: string): EmbeddingMetadata {
  return {
    text: extractSearchableText(markdown),
    sections: parseSections(markdown),
    timestamp: parseFrontmatter(markdown).timestamp,
    path: mdPath,
  };
}

export async function writeEmbeddingAtomically(
  mdPath: string,
  data: EmbeddingData,
  verifyCurrent?: () => Promise<boolean>,
): Promise<void> {
  const target = mdPath.replace(/\.md$/, '.embedding');
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let renamed = false;
  try {
    await fs.writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    if (verifyCurrent && !await verifyCurrent()) throw new Error('markdown changed before sidecar rename');
    await fs.rename(temporary, target);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(temporary, { force: true });
  }
}

export async function hasValidEmbedding(mdPath: string, expected: EmbeddingMetadata): Promise<boolean> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(mdPath.replace(/\.md$/, '.embedding'), 'utf8'));
    if (!data || typeof data !== 'object') return false;
    const embedding = data as EmbeddingData;
    return Array.isArray(embedding.embedding)
      && embedding.embedding.every((value) => typeof value === 'number')
      && typeof embedding.text === 'string'
      && Array.isArray(embedding.sections)
      && embedding.sections.every((value) => typeof value === 'string')
      && embedding.text === expected.text
      && embedding.sections.length === expected.sections.length
      && embedding.sections.every((value, index) => value === expected.sections[index])
      && embedding.timestamp === expected.timestamp
      && embedding.path === expected.path;
  } catch {
    return false;
  }
}
