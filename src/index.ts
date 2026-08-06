#!/usr/bin/env node

import { spawn } from 'child_process';
import { EmbeddingWorker } from './embedding-worker';
import { resolveEmbeddingRuntimePaths } from './embedding-runtime';
import { EmbeddingService } from './embeddings';
import { GitSync } from './git-sync';
import { CURRENT_DATA_VERSION, MigrationManager } from './migrations';
import { resolveDataPath, resolveGitRemote } from './paths';
import { SearchService } from './search';
import { PrivateJournalServer } from './server';
import { migrateLegacyIndex } from './index-migration';

export async function runSync(opts: { dataPath?: string; remote?: string } = {}): Promise<void> {
  const dataPath = opts.dataPath ?? resolveDataPath();
  const remote = resolveGitRemote(opts.remote);
  const git = new GitSync(dataPath, remote);
  const migrations = new MigrationManager(dataPath);
  let pulled: string[] = [];

  if (git.enabled) {
    await git.ensureRepo();
    pulled = await git.pull(CURRENT_DATA_VERSION);
  }

  const migrated = await migrations.run();

  const search = new SearchService(dataPath, EmbeddingService.getInstance());

  // 인덱스가 아직 전체 원본과 동기화되지 않은 경우에만 초기 전체 walk를 실행한다.
  // 완전한 인덱스는 Git이 알려준 변경 경로만 처리한다.
  const work = search.needsInitialBackfill() || migrated
    ? search.backfill()
    : pulled.length > 0 ? search.backfillPaths(pulled) : Promise.resolve(0);

  await work.catch((error: unknown) => {
    console.error('[private-journal] backfill failed (best-effort):', error);
  });

  if (git.enabled) {
    const synced = await git.commitAndPush(
      `journal sync: ${new Date().toISOString()}`,
      CURRENT_DATA_VERSION,
      { remoteAlreadyPulled: git.lastPullCompleted },
    );
    if (synced.length > 0) {
      await search.backfillPaths(synced).catch((error: unknown) => {
        console.error('[private-journal] committed index update failed (best-effort):', error);
      });
    }
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv[2] === 'embedding-worker') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const worker = new EmbeddingWorker({
      runtimePaths: resolveEmbeddingRuntimePaths(process.env, process.platform, uid),
      idleMs: 0,
    });
    await worker.listen();
    return;
  }

  if (argv[2] === 'sync' && argv[3] === '--background') {
    const child = spawn(process.execPath, [argv[1], 'sync'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }

  if (argv[2] === 'sync') {
    await runSync();
    return;
  }

  if (argv[2] === 'migrate-index') {
    const result = await migrateLegacyIndex({ dataPath: resolveDataPath() });
    console.error(
      `[private-journal] index migration ${result.fromRevision} -> ${result.toRevision}: `
      + `${result.indexed} indexed, ${result.recomputed} recomputed, ${result.removedSidecars} sidecar(s) removed`,
    );
    return;
  }

  await new PrivateJournalServer().run();
}

if (require.main === module) {
  main(process.argv).catch((error: unknown) => {
    console.error('[private-journal] fatal:', error);
    process.exit(1);
  });
}
