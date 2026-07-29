#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSync = runSync;
exports.main = main;
const embeddings_1 = require("./embeddings");
const git_sync_1 = require("./git-sync");
const paths_1 = require("./paths");
const search_1 = require("./search");
const server_1 = require("./server");
async function runSync(opts = {}) {
    const dataPath = opts.dataPath ?? (0, paths_1.resolveDataPath)();
    const remote = (0, paths_1.resolveGitRemote)(opts.remote);
    const git = new git_sync_1.GitSync(dataPath, remote);
    if (!git.enabled) {
        return;
    }
    await git.ensureRepo();
    const pulled = await git.commitAndPush(`journal sync: ${new Date().toISOString()}`);
    // 받은 엔트리만 임베딩한다. 전체 스캔은 서버 기동 시 backfill()이 담당하므로
    // 여기서 반복하면 매 hook 호출마다 코퍼스 전체를 읽게 된다.
    if (pulled.length === 0)
        return;
    const search = new search_1.SearchService(dataPath, embeddings_1.EmbeddingService.getInstance());
    await search.backfillPaths(pulled).catch((error) => {
        console.error('[private-journal] backfill failed (best-effort):', error);
    });
}
async function main(argv) {
    if (argv[2] === 'sync') {
        await runSync();
        return;
    }
    await new server_1.PrivateJournalServer().run();
}
if (require.main === module) {
    main(process.argv).catch((error) => {
        console.error('[private-journal] fatal:', error);
        process.exit(1);
    });
}
