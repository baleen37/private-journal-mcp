import { SECTION_KEYS, SECTION_TITLES } from '../src/types';

describe('types', () => {
  it('has 6 section keys in fixed order', () => {
    expect(SECTION_KEYS).toEqual([
      'reflections', 'observations', 'project_notes',
      'user_context', 'technical_insights', 'world_knowledge',
    ]);
  });

  it('maps each key to a heading title', () => {
    expect(SECTION_TITLES.reflections).toBe('Reflections');
    expect(SECTION_TITLES.project_notes).toBe('Project Notes');
    expect(SECTION_TITLES.world_knowledge).toBe('World Knowledge');
    expect(Object.keys(SECTION_TITLES)).toHaveLength(6);
  });
});
