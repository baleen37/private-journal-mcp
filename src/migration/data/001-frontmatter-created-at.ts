import * as fs from 'fs/promises';
import * as path from 'path';
import YAML from 'yaml';
import { DataVersionError, Migration } from '../../migrations';
import { renderFrontmatter } from '../../journal';

type FrontmatterValues = Record<string, unknown>;

function parseDocument(md: string, relativePath: string): { values: FrontmatterValues; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) throw new DataVersionError(`Cannot convert ${relativePath}: missing YAML front matter`);

  let parsed: unknown;
  try {
    parsed = YAML.parse(match[1]);
  } catch (error) {
    throw new DataVersionError(`Cannot convert ${relativePath}: invalid YAML (${String(error)})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DataVersionError(`Cannot convert ${relativePath}: front matter must be a YAML mapping`);
  }
  return { values: parsed as FrontmatterValues, body: md.slice(match[0].length) };
}

function normalizeCreatedAt(values: FrontmatterValues, relativePath: string): string {
  for (const value of [values.created_at, values.date]) {
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }

  const timestamp = typeof values.timestamp === 'number'
    ? values.timestamp
    : typeof values.timestamp === 'string' && /^\d+$/.test(values.timestamp)
      ? Number(values.timestamp)
      : Number.NaN;
  if (Number.isFinite(timestamp)) {
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }

  throw new DataVersionError(`Cannot convert ${relativePath}: no valid created_at/date/timestamp`);
}

async function listMarkdownFiles(directory: string, relativeDirectory = ''): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(entryPath, relativePath));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(relativePath);
    }
  }
  return files;
}

export const frontmatterCreatedAtMigration: Migration = {
  from: 1,
  to: 2,
  async apply(stagePath) {
    const invalidatedMarkdownPaths: string[] = [];
    for (const relativePath of await listMarkdownFiles(stagePath)) {
      const markdownPath = path.join(stagePath, relativePath);
      const markdown = await fs.readFile(markdownPath, 'utf8');
      const { values, body } = parseDocument(markdown, relativePath);
      if (typeof values.title !== 'string' || values.title.trim().length === 0) {
        throw new DataVersionError(`Cannot convert ${relativePath}: title is required`);
      }
      const createdAt = normalizeCreatedAt(values, relativePath);
      await fs.writeFile(markdownPath, renderFrontmatter(values.title, createdAt) + body, 'utf8');
      invalidatedMarkdownPaths.push(relativePath);
    }
    return { invalidatedMarkdownPaths };
  },
};
