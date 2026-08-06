import { renderEntry, parseFrontmatter, parseSections, buildEntryRelPath } from '../src/journal';
import YAML from 'yaml';

const when = new Date('2026-06-25T12:34:56.789Z');

describe('renderEntry', () => {
  it('writes YAML frontmatter with only title and created_at', () => {
    const md = renderEntry(
      { observations: 'saw a bug', reflections: 'felt good' },
      '검색 결과 캐시 오류',
      when,
    );
    const frontmatter = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    expect(YAML.parse(frontmatter)).toEqual({
      title: '검색 결과 캐시 오류',
      created_at: when.toISOString(),
    });
    expect(frontmatter).not.toContain('date:');
    expect(frontmatter).not.toContain('timestamp:');
    // reflections must appear before observations (fixed order)
    expect(md.indexOf('## Reflections')).toBeLessThan(md.indexOf('## Observations'));
    expect(md).toContain('felt good');
    expect(md).toContain('saw a bug');
  });

  it('omits sections not provided', () => {
    const md = renderEntry({ reflections: 'x' }, '회고', when);
    expect(md).not.toContain('## Observations');
  });
});

describe('parseFrontmatter', () => {
  it('round-trips with renderEntry', () => {
    const md = renderEntry({ reflections: 'x' }, '회고', when);
    const fm = parseFrontmatter(md);
    expect(fm.timestamp).toBe(when.getTime());
    expect(fm.created_at).toBe(when.toISOString());
    expect(fm.title).toBe('회고');
  });

  it('reads legacy date and timestamp frontmatter during migration', () => {
    const md = '---\ntitle: "Legacy"\ndate: 2026-06-25T12:34:56.789Z\ntimestamp: 1\n---\n\nbody\n';
    const fm = parseFrontmatter(md);
    expect(fm.created_at).toBe('2026-06-25T12:34:56.789Z');
    expect(fm.timestamp).toBe(Date.parse('2026-06-25T12:34:56.789Z'));
  });
});

describe('parseSections', () => {
  it('lists present section keys', () => {
    const md = renderEntry({ reflections: 'x', project_notes: 'y' }, '설계 결정', when);
    expect(parseSections(md).sort()).toEqual(['project_notes', 'reflections']);
  });
});

describe('buildEntryRelPath', () => {
  it('produces YYYY-MM-DD/HH-MM-SS-<6digits>.md', () => {
    const rel = buildEntryRelPath(when);
    expect(rel).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}-\d{6}\.md$/);
  });
});
