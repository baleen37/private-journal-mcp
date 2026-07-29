#!/usr/bin/env node

import { EmbeddingService } from './embeddings';
import { GitSync } from './git-sync';
import { resolveDataPath, resolveGitRemote } from './paths';
import { SearchService } from './search';
import { PrivateJournalServer } from './server';

export async function runSync(opts: { dataPath?: string; remote?: string } = {}): Promise<void> {
  const dataPath = opts.dataPath ?? resolveDataPath();
  const remote = resolveGitRemote(opts.remote);
  const git = new GitSync(dataPath, remote);

  if (!git.enabled) {
    return;
  }

  await git.ensureRepo();
  const pulled = await git.commitAndPush(`journal sync: ${new Date().toISOString()}`);

  // 받은 엔트리만 임베딩한다. 전체 스캔은 서버 기동 시 backfill()이 담당하므로
  // 여기서 반복하면 매 hook 호출마다 코퍼스 전체를 읽게 된다.
  if (pulled.length === 0) return;
  const search = new SearchService(dataPath, EmbeddingService.getInstance());
  await search.backfillPaths(pulled).catch((error: unknown) => {
    console.error('[private-journal] backfill failed (best-effort):', error);
  });
}

export async function main(argv: string[]): Promise<void> {
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
