import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const pluginPath = path.join(process.cwd(), 'opencode-plugin.mjs');

function runNodeModule(source: string, dataPath: string): string {
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

  it('delegates each OpenCode tool to the supplied journal handler', () => {
    const moduleUrl = pathToFileURL(pluginPath).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        [
          'import { createTools } from ' + JSON.stringify(moduleUrl) + ';',
          'const tools = createTools({',
          "  handleWrite: async (args) => ({ path: '/tmp/' + args.section + '.md' }),",
          "  handleSearch: async () => [{ path: '/tmp/entry.md', score: 0.8634, excerpt: 'plugin result', sections: ['technical_insights'], timestamp: Date.parse('2026-08-03T00:00:00Z') }],",
          "  handleRead: async () => ({ content: 'full entry' }),",
          "  handleList: async () => [{ path: '/tmp/entry.md', title: 'Entry', date: '2026-08-03', timestamp: Date.parse('2026-08-03T00:00:00Z'), sections: ['technical_insights'] }],",
          '});',
          "const write = await tools.write_journal.execute({ content: 'note', section: 'technical_insights' });",
          "const search = await tools.search_journal.execute({ query: 'plugin' });",
          "const read = await tools.read_journal.execute({ path: '/tmp/entry.md' });",
          'const list = await tools.list_journal.execute({});',
          'console.log(JSON.stringify({ write: JSON.parse(write), search, read: JSON.parse(read), list: JSON.parse(list) }));',
        ].join('\n'),
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );

    const result = JSON.parse(output.trim());
    expect(result.write).toEqual({ path: '/tmp/technical_insights.md' });
    expect(result.search).toContain('### Journal Search Results');
    expect(result.read).toEqual({ content: 'full entry' });
    expect(result.list).toHaveLength(1);
  });
});
