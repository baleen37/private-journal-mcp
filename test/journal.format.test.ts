import { renderEntry, parseFrontmatter, parseSections, buildEntryRelPath } from '../src/journal';

const when = new Date('2026-06-25T12:34:56.789Z');

describe('renderEntry', () => {
  it('writes frontmatter and sections in fixed order', () => {
    const md = renderEntry(
      { observations: 'saw a bug', reflections: 'felt good' },
      when,
    );
    expect(md).toContain('timestamp: ' + when.getTime());
    expect(md).toContain('date: ' + when.toISOString());
    // reflections must appear before observations (fixed order)
    expect(md.indexOf('## Reflections')).toBeLessThan(md.indexOf('## Observations'));
    expect(md).toContain('felt good');
    expect(md).toContain('saw a bug');
  });

  it('omits sections not provided', () => {
    const md = renderEntry({ reflections: 'x' }, when);
    expect(md).not.toContain('## Observations');
  });
});

describe('parseFrontmatter', () => {
  it('round-trips with renderEntry', () => {
    const md = renderEntry({ reflections: 'x' }, when);
    const fm = parseFrontmatter(md);
    expect(fm.timestamp).toBe(when.getTime());
    expect(fm.date).toBe(when.toISOString());
    // Verify title round-trips without trailing quote or extra quotes
    const hh = String(when.getHours()).padStart(2, '0');
    const mm = String(when.getMinutes()).padStart(2, '0');
    const ss = String(when.getSeconds()).padStart(2, '0');
    const expectedTitle = `${hh}:${mm}:${ss} - June 25, 2026`;
    expect(fm.title).toBe(expectedTitle);
    expect(fm.title).not.toContain('"');
  });
});

describe('parseSections', () => {
  it('lists present section keys', () => {
    const md = renderEntry({ reflections: 'x', project_notes: 'y' }, when);
    expect(parseSections(md).sort()).toEqual(['project_notes', 'reflections']);
  });
});

describe('buildEntryRelPath', () => {
  it('produces YYYY-MM-DD/HH-MM-SS-<6digits>.md', () => {
    const rel = buildEntryRelPath(when);
    expect(rel).toMatch(/^\d{4}-\d{2}-\d{2}\/\d{2}-\d{2}-\d{2}-\d{6}\.md$/);
  });
});
