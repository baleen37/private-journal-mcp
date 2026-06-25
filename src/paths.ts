import * as path from 'path';
import * as os from 'os';

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function resolveDataPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PRIVATE_JOURNAL_PATH) return env.PRIVATE_JOURNAL_PATH;
  if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, 'private-journal');
  return path.join(homeDir(env), '.local', 'share', 'private-journal');
}

export function resolveModelCachePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'private-journal', 'models');
  return path.join(homeDir(env), '.cache', 'private-journal', 'models');
}
