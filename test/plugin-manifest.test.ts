import * as fs from 'fs';
import * as path from 'path';

describe('Claude plugin manifest', () => {
  it('offers an optional Git remote with local-only guidance', () => {
    const manifestPath = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    expect(manifest.userConfig?.git_remote).toEqual({
      type: 'string',
      title: 'Git remote',
      description: '동기화할 Git remote URL입니다. 비워두면 local-only로 사용합니다.',
    });
    expect(manifest.mcpServers?.['private-journal']?.env).toEqual({
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: '${user_config.git_remote}',
    });
  });

  it('declares package entrypoints used by OpenCode and the CLI', () => {
    const packagePath = path.join(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

    expect(packageJson.main).toBe('dist/index.js');
    expect(packageJson.bin['private-journal-mcp']).toBe('./bin/private-journal-mcp');
    expect(packageJson.exports['./server']).toBe('./opencode-plugin.mjs');
  });
});
