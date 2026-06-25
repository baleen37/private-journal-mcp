import * as fs from 'fs/promises';
import * as path from 'path';
import { SECTION_KEYS, SECTION_TITLES, SectionKey, JournalSections, EmbeddingData } from './types';
import { EmbeddingService } from './embeddings';

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

const MONTHS = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

export function renderEntry(sections: JournalSections, when: Date): string {
  const hh = pad(when.getHours());
  const mm = pad(when.getMinutes());
  const ss = pad(when.getSeconds());
  const title = `${hh}:${mm}:${ss} - ${MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()}`;
  const lines: string[] = [
    '---',
    `title: "${title}"`,
    `date: ${when.toISOString()}`,
    `timestamp: ${when.getTime()}`,
    '---',
    '',
  ];
  for (const key of SECTION_KEYS) {
    const val = sections[key as SectionKey];
    if (val && val.trim().length > 0) {
      lines.push(`## ${SECTION_TITLES[key as SectionKey]}`, '', val.trim(), '');
    }
  }
  return lines.join('\n');
}

export function parseFrontmatter(md: string): { title: string; date: string; timestamp: number } {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const body = m ? m[1] : '';
  const title = (body.match(/title:\s*"(.*?)"\s*$/m) || [])[1] || '';
  const date = (body.match(/date:\s*(.*?)\s*$/m) || [])[1] || '';
  const ts = parseInt((body.match(/timestamp:\s*(\d+)/) || [])[1] || '0', 10);
  return { title, date, timestamp: ts };
}

export function parseSections(md: string): string[] {
  const present: string[] = [];
  for (const key of SECTION_KEYS) {
    if (md.includes(`## ${SECTION_TITLES[key as SectionKey]}`)) present.push(key);
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
  constructor(private dataPath: string, private embeddings: EmbeddingService) {}

  hasContent(sections: JournalSections): boolean {
    return SECTION_KEYS.some((k) => {
      const v = sections[k as SectionKey];
      return !!v && v.trim().length > 0;
    });
  }

  async write(sections: JournalSections, when: Date = new Date()): Promise<string> {
    const rel = buildEntryRelPath(when);
    const mdPath = path.join(this.dataPath, rel);
    await fs.mkdir(path.dirname(mdPath), { recursive: true });
    const md = renderEntry(sections, when);
    await fs.writeFile(mdPath, md, 'utf8');

    try {
      const presentSections = parseSections(md);
      const text = this.embeddings.extractSearchableText(md);
      const vector = await this.embeddings.generateEmbedding(text, 'passage');
      const data: EmbeddingData = {
        embedding: vector,
        text,
        sections: presentSections,
        timestamp: when.getTime(),
        path: mdPath,
      };
      await this.embeddings.saveEmbedding(mdPath, data);
    } catch (err) {
      console.error('[private-journal] embedding generation failed:', err);
    }

    return mdPath;
  }
}
