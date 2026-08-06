import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const pluginPath = path.join(process.cwd(), 'opencode-plugin.mjs');

function runNodeModule(source: string, dataPath: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PRIVATE_JOURNAL_PATH: dataPath,
        PRIVATE_JOURNAL_GIT_REMOTE: '',
        CLAUDE_PLUGIN_OPTION_GIT_REMOTE: '',
        ...env,
      },
      encoding: 'utf8',
    },
  );
}

describe('OpenCode plugin', () => {
  it('exports a v1 server plugin with the four journal tools', () => {
    const dataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-'));
    try {
      const output = runNodeModule(
        [
          "import pluginModule from 'private-journal-mcp/server';",
          'const hooks = await pluginModule.server({});',
          'console.log(JSON.stringify(Object.keys(hooks.tool).sort()));',
        ].join('\n'),
        dataPath,
      );

      expect(JSON.parse(output.trim())).toEqual([
        'list_journal',
        'read_journal',
        'search_journal',
        'write_journal',
      ]);
    } finally {
      fs.rmSync(dataPath, { recursive: true, force: true });
    }
  });

  it('executes all native tools through real journal handlers with deterministic embeddings', () => {
    const rootPath = fs.mkdtempSync(path.join('/tmp', 'opencode-plugin-execution-'));
    const dataPath = path.join(rootPath, 'journal');
    const tmpPath = path.join(rootPath, 'tmp');
    fs.mkdirSync(tmpPath);
    try {
      const output = runNodeModule(
        [
          "import { existsSync } from 'fs';",
          "import brokerModule from './dist/embedding-broker.js';",
          "import pluginModule from 'private-journal-mcp/server';",
          'const kinds = [];',
          'brokerModule.EmbeddingBroker.prototype.embedText = async (_text, kind) => {',
          '  kinds.push(kind);',
          '  return [1, 0, ...Array(382).fill(0)];',
          '};',
          'const hooks = await pluginModule.server({});',
          "const write = JSON.parse(await hooks.tool.write_journal.execute({ title: 'Native plugin execution', content: 'native plugin execution', section: 'technical_insights' }));",
          "const search = await hooks.tool.search_journal.execute({ query: 'native plugin', limit: 1, section: 'technical_insights' });",
          'const read = JSON.parse(await hooks.tool.read_journal.execute({ path: write.path }));',
          'const list = JSON.parse(await hooks.tool.list_journal.execute({ limit: 1, days: 1 }));',
          "console.log(JSON.stringify({ sidecarExists: existsSync(write.path.replace(/\\.md$/, '.embedding')), indexExists: existsSync(process.env.PRIVATE_JOURNAL_PATH + '/.private-journal-index.sqlite'), kinds, list, read, search, write }));",
        ].join('\n'),
        dataPath,
        { TMPDIR: tmpPath },
      );

      const result = JSON.parse(output.trim());
      expect(result.sidecarExists).toBe(false);
      expect(result.indexExists).toBe(true);
      expect(result.kinds).toEqual(['passage', 'query']);
      expect(result.read.content).toContain('native plugin execution');
      expect(result.list).toHaveLength(1);
      expect(result.search).toContain('### Journal Search Results');
      expect(result.search).toContain('native plugin execution');
      expect(result.write.path).toMatch(/\.md$/);
    } finally {
      fs.rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it('delegates each OpenCode tool to the supplied journal handler', () => {
    const moduleUrl = pathToFileURL(pluginPath).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          'import { createTools } from ' + JSON.stringify(moduleUrl) + ';',
          'const received = [];',
          'const tools = createTools({',
          "  handleWrite: async (args) => { received.push(['write', args]); return { path: '/tmp/' + args.section + '.md' }; },",
          "  handleSearch: async (args) => { received.push(['search', args]); return [{ path: '/tmp/entry.md', score: 0.8634, excerpt: 'plugin result', sections: ['technical_insights'], timestamp: Date.parse('2026-08-03T00:00:00Z') }]; },",
          "  handleRead: async (args) => { received.push(['read', args]); return { content: 'full entry' }; },",
          "  handleList: async (args) => { received.push(['list', args]); return [{ path: '/tmp/entry.md', title: 'Entry', date: '2026-08-03', timestamp: Date.parse('2026-08-03T00:00:00Z'), sections: ['technical_insights'] }]; },",
          '});',
          "const write = await tools.write_journal.execute({ title: 'Plugin note', content: 'note', section: 'technical_insights' });",
          "const search = await tools.search_journal.execute({ query: 'plugin', limit: 3, section: 'technical_insights', minScore: 0.8 });",
          "const read = await tools.read_journal.execute({ path: '/tmp/entry.md' });",
          'const list = await tools.list_journal.execute({ limit: 2, days: 7 });',
          'console.log(JSON.stringify({ received, write: JSON.parse(write), search, read: JSON.parse(read), list: JSON.parse(list) }));',
        ].join('\n'),
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const result = JSON.parse(output.trim());
    expect(result.write).toEqual({ path: '/tmp/technical_insights.md' });
    expect(result.search).toContain('### Journal Search Results');
    expect(result.read).toEqual({ content: 'full entry' });
    expect(result.list).toHaveLength(1);
    expect(result.received).toEqual([
      ['write', { title: 'Plugin note', content: 'note', section: 'technical_insights' }],
      ['search', { query: 'plugin', limit: 3, section: 'technical_insights', minScore: 0.8 }],
      ['read', { path: '/tmp/entry.md' }],
      ['list', { limit: 2, days: 7 }],
    ]);
  });
});
