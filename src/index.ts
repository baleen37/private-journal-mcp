#!/usr/bin/env node

import { EmbeddingWorker } from './embedding-worker';
import { resolveEmbeddingRuntimePaths } from './embedding-runtime';
import { EmbeddingService } from './embeddings';
import { GitSync } from './git-sync';
import { CURRENT_DATA_VERSION, MigrationManager } from './migrations';
import { resolveDataPath, resolveGitRemote } from './paths';
import { SearchService } from './search';
import { PrivateJournalServer } from './server';

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

  await migrations.run();

  const search = new SearchService(dataPath, EmbeddingService.getInstance());

  // 받은 것이 있으면 그 경로만 임베딩한다. 없을 때만 전체를 훑는다.
  //
  // 이 CLI는 MCP 서버와 별개 프로세스(SessionStart hook)로 돌기 때문에, 서버를
  // 안 쓰는 기기에서는 기동 시 backfill()이 아예 실행되지 않는다. 여기서 전체
  // 스캔을 완전히 없애면 그런 기기의 미임베딩 엔트리는 영구히 검색되지 않는다.
  // pull이 있을 때만 스캔을 건너뛰어, 매 동기화의 반복 비용은 피하면서
  // 최종적으로는 항상 수렴하게 한다.
  const work = pulled.length > 0
    ? search.backfillPaths(pulled)
    : search.backfill();

  await work.catch((error: unknown) => {
    console.error('[private-journal] backfill failed (best-effort):', error);
  });

  if (git.enabled) {
    await git.commitAndPush(`journal sync: ${new Date().toISOString()}`, CURRENT_DATA_VERSION);
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

  if (argv[2] === 'sync') {
    await runSync();
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
