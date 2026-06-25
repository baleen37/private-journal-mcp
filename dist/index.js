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
    const remote = opts.remote ?? process.env.PRIVATE_JOURNAL_GIT_REMOTE;
    const git = new git_sync_1.GitSync(dataPath, remote);
    if (!git.enabled) {
        return;
    }
    await git.ensureRepo();
    await git.pull();
    await git.commitAndPush(`journal sync: ${new Date().toISOString()}`);
    const search = new search_1.SearchService(dataPath, embeddings_1.EmbeddingService.getInstance());
    await search.backfill().catch((error) => {
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
