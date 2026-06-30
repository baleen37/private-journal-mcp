export const JOURNAL_SECTIONS = [
  'reflections',
  'observations',
  'project_notes',
  'user_context',
  'technical_insights',
  'world_knowledge',
] as const;

export type JournalSection = (typeof JOURNAL_SECTIONS)[number];

export const SECTION_TITLES: Record<JournalSection, string> = {
  reflections: 'Reflections',
  observations: 'Observations',
  project_notes: 'Project Notes',
  user_context: 'User Context',
  technical_insights: 'Technical Insights',
  world_knowledge: 'World Knowledge',
};

export type JournalSections = Partial<Record<JournalSection, string>>;

export interface EmbeddingData {
  embedding: number[];
  text: string;
  sections: string[];
  timestamp: number;
  path: string;
}

export interface SearchResult {
  path: string;
  score: number;
  excerpt: string;
  sections: string[];
  timestamp: number;
}

export interface RecentEntry {
  path: string;
  title: string;
  date: string;
  timestamp: number;
  sections: string[];
}
