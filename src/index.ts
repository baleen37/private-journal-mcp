#!/usr/bin/env node

import { EmbeddingService } from './embeddings';
import { GitSync } from './git-sync';
import { resolveDataPath } from './paths';
import { SearchService } from './search';
import { PrivateJournalServer } from './server';

export async function runSync(opts: { dataPath?: string; remote?: string } = {}): Promise<void> {
  const dataPath = opts.dataPath ?? resolveDataPath();
  const remote = opts.remote ?? process.env.PRIVATE_JOURNAL_GIT_REMOTE;
  const git = new GitSync(dataPath, remote);

  if (!git.enabled) {
    return;
  }

  await git.ensureRepo();
  await git.pull();
  await git.commitAndPush(`journal sync: ${new Date().toISOString()}`);

  const search = new SearchService(dataPath, EmbeddingService.getInstance());
  await search.backfill().catch((error: unknown) => {
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
