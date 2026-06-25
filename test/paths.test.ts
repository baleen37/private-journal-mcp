import { resolveDataPath, resolveModelCachePath } from '../src/paths';
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
