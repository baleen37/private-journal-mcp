import { resolveDataPath, resolveGitRemote, resolveModelCachePath } from '../src/paths';
import * as path from 'path';

describe('resolveDataPath', () => {
  it('honors PRIVATE_JOURNAL_PATH above all', () => {
    const env = { PRIVATE_JOURNAL_PATH: '/custom/journal', XDG_DATA_HOME: '/xdg', HOME: '/home/u' };
    expect(resolveDataPath(env)).toBe('/custom/journal');
  });

  it('uses XDG_DATA_HOME when PRIVATE_JOURNAL_PATH unset', () => {
    const env = { XDG_DATA_HOME: '/xdg/data', HOME: '/home/u' };
    expect(resolveDataPath(env)).toBe(path.join('/xdg/data', 'private-journal'));
  });

  it('falls back to ~/.local/share', () => {
    const env = { HOME: '/home/u' };
    expect(resolveDataPath(env)).toBe(path.join('/home/u', '.local', 'share', 'private-journal'));
  });
});

describe('resolveModelCachePath', () => {
  it('uses XDG_CACHE_HOME when set', () => {
    const env = { XDG_CACHE_HOME: '/xdg/cache', HOME: '/home/u' };
    expect(resolveModelCachePath(env)).toBe(path.join('/xdg/cache', 'private-journal', 'models'));
  });

  it('falls back to ~/.cache', () => {
    const env = { HOME: '/home/u' };
    expect(resolveModelCachePath(env)).toBe(path.join('/home/u', '.cache', 'private-journal', 'models'));
  });
});

describe('resolveGitRemote', () => {
  it('prefers an explicit remote and trims it', () => {
    expect(resolveGitRemote('  explicit.git  ', {
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: 'plugin.git',
      PRIVATE_JOURNAL_GIT_REMOTE: 'legacy.git',
    })).toBe('explicit.git');
  });

  it('prefers the Claude plugin option over the legacy env', () => {
    expect(resolveGitRemote(undefined, {
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: '  plugin.git  ',
      PRIVATE_JOURNAL_GIT_REMOTE: 'legacy.git',
    })).toBe('plugin.git');
  });

  it('treats an explicitly empty Claude plugin option as local-only', () => {
    expect(resolveGitRemote(undefined, {
      CLAUDE_PLUGIN_OPTION_GIT_REMOTE: '   ',
      PRIVATE_JOURNAL_GIT_REMOTE: 'legacy.git',
    })).toBeUndefined();
  });

  it('uses the legacy env when the Claude plugin option is absent', () => {
    expect(resolveGitRemote(undefined, {
      PRIVATE_JOURNAL_GIT_REMOTE: '  legacy.git  ',
    })).toBe('legacy.git');
  });

  it('returns undefined when no remote is configured', () => {
    expect(resolveGitRemote(undefined, {})).toBeUndefined();
  });
});
