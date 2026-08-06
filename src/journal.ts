import * as fs from 'fs/promises';
import * as path from 'path';
import YAML from 'yaml';
import {
  JOURNAL_SECTIONS,
  SECTION_TITLES,
  JournalSections,
} from './types';
import { EmbeddingService } from './embeddings';

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

export function renderFrontmatter(title: string, createdAt: string): string {
  return [
    '---',
    YAML.stringify({ title, created_at: createdAt }).trimEnd(),
    '---',
    '',
  ].join('\n');
}

export function renderEntry(sections: JournalSections, title: string, when: Date): string {
  const lines: string[] = [renderFrontmatter(title, when.toISOString()).trimEnd(), ''];
  for (const section of JOURNAL_SECTIONS) {
    const val = sections[section];
    if (val && val.trim().length > 0) {
      lines.push(`## ${SECTION_TITLES[section]}`, '', val.trim(), '');
    }
  }
  return lines.join('\n');
}

export function parseFrontmatter(md: string): { title: string; created_at: string; timestamp: number } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { title: '', created_at: '', timestamp: 0 };

  let parsed: unknown;
  try {
    parsed = YAML.parse(m[1]);
  } catch {
    return { title: '', created_at: '', timestamp: 0 };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { title: '', created_at: '', timestamp: 0 };
  }

  const values = parsed as Record<string, unknown>;
  const title = typeof values.title === 'string' ? values.title : '';
  const candidates = [values.created_at, values.date];
  let createdAt = '';
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const timestamp = Date.parse(candidate);
    if (Number.isFinite(timestamp)) {
      createdAt = new Date(timestamp).toISOString();
      break;
    }
  }
  if (!createdAt && typeof values.timestamp === 'number' && Number.isFinite(values.timestamp)) {
    const date = new Date(values.timestamp);
    if (!Number.isNaN(date.getTime())) createdAt = date.toISOString();
  }

  return {
    title,
    created_at: createdAt,
    timestamp: createdAt ? Date.parse(createdAt) : 0,
  };
}

export function parseSections(md: string): string[] {
  const present: string[] = [];
  for (const section of JOURNAL_SECTIONS) {
    if (md.includes(`## ${SECTION_TITLES[section]}`)) present.push(section);
  }
  return present;
}

export function buildEntryRelPath(when: Date): string {
  const y = when.getFullYear();
  const mo = pad(when.getMonth() + 1);
  const d = pad(when.getDate());
  const hh = pad(when.getHours());
  const mm = pad(when.getMinutes());
  const ss = pad(when.getSeconds());
  const micro = pad(when.getMilliseconds() * 1000 + Math.floor(Math.random() * 1000), 6);
  return `${y}-${mo}-${d}/${hh}-${mm}-${ss}-${micro}.md`;
}

export class JournalManager {
  constructor(private dataPath: string, _embeddings?: EmbeddingService) {}

  hasContent(sections: JournalSections): boolean {
    return JOURNAL_SECTIONS.some((section) => {
      const v = sections[section];
      return !!v && v.trim().length > 0;
    });
  }

  async write(sections: JournalSections, title: string, when: Date = new Date()): Promise<string> {
    const rel = buildEntryRelPath(when);
    const mdPath = path.join(this.dataPath, rel);
    await fs.mkdir(path.dirname(mdPath), { recursive: true });
    const md = renderEntry(sections, title, when);
    await fs.writeFile(mdPath, md, 'utf8');
    return mdPath;
  }
}
