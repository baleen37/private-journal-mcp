import { spawn } from 'child_process';
import * as path from 'path';

export function launchBackgroundSync(dataPath: string, remote?: string): void {
  const entry = path.join(__dirname, 'index.js');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PRIVATE_JOURNAL_PATH: dataPath,
  };
  if (remote) env.PRIVATE_JOURNAL_GIT_REMOTE = remote;

  const child = spawn(process.execPath, [entry, 'sync'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
}
