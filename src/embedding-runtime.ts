import { mkdirSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

export interface EmbeddingRuntimePaths {
  directory: string;
  socketPath: string;
  startupLockPath: string;
  pidPath: string;
}

export function resolveEmbeddingRuntimePaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  uid: number,
): EmbeddingRuntimePaths {
  const directory = platform === 'linux' && env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'private-journal')
    : path.join(tmpdir(), `private-journal-${uid}`, 'private-journal');

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  return {
    directory,
    socketPath: path.join(directory, 'embedding.sock'),
    startupLockPath: path.join(directory, 'embedding.startup.lock'),
    pidPath: path.join(directory, 'embedding.pid'),
  };
}
