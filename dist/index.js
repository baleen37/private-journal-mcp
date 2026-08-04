#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSync = runSync;
exports.main = main;
const child_process_1 = require("child_process");
const embedding_worker_1 = require("./embedding-worker");
const embedding_runtime_1 = require("./embedding-runtime");
const embeddings_1 = require("./embeddings");
const git_sync_1 = require("./git-sync");
const migrations_1 = require("./migrations");
const paths_1 = require("./paths");
const search_1 = require("./search");
const server_1 = require("./server");
const index_migration_1 = require("./index-migration");
async function runSync(opts = {}) {
    const dataPath = opts.dataPath ?? (0, paths_1.resolveDataPath)();
    const remote = (0, paths_1.resolveGitRemote)(opts.remote);
    const git = new git_sync_1.GitSync(dataPath, remote);
    const migrations = new migrations_1.MigrationManager(dataPath);
    let pulled = [];
    if (git.enabled) {
        await git.ensureRepo();
        pulled = await git.pull(migrations_1.CURRENT_DATA_VERSION);
    }
    await migrations.run();
    const search = new search_1.SearchService(dataPath, embeddings_1.EmbeddingService.getInstance());
    // 인덱스가 아직 전체 원본과 동기화되지 않은 경우에만 초기 전체 walk를 실행한다.
    // 완전한 인덱스는 Git이 알려준 변경 경로만 처리한다.
    const work = search.needsInitialBackfill()
        ? search.backfill()
        : pulled.length > 0 ? search.backfillPaths(pulled) : Promise.resolve(0);
    await work.catch((error) => {
        console.error('[private-journal] backfill failed (best-effort):', error);
    });
    if (git.enabled) {
        const synced = await git.commitAndPush(`journal sync: ${new Date().toISOString()}`, migrations_1.CURRENT_DATA_VERSION, { remoteAlreadyPulled: git.lastPullCompleted });
        if (synced.length > 0) {
            await search.backfillPaths(synced).catch((error) => {
                console.error('[private-journal] committed index update failed (best-effort):', error);
            });
        }
    }
}
async function main(argv) {
    if (argv[2] === 'embedding-worker') {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        const worker = new embedding_worker_1.EmbeddingWorker({
            runtimePaths: (0, embedding_runtime_1.resolveEmbeddingRuntimePaths)(process.env, process.platform, uid),
            idleMs: 0,
        });
        await worker.listen();
        return;
    }
    if (argv[2] === 'sync' && argv[3] === '--background') {
        const child = (0, child_process_1.spawn)(process.execPath, [argv[1], 'sync'], {
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
        const result = await (0, index_migration_1.migrateLegacyIndex)({ dataPath: (0, paths_1.resolveDataPath)() });
        console.error(`[private-journal] index migration ${result.fromRevision} -> ${result.toRevision}: `
            + `${result.indexed} indexed, ${result.recomputed} recomputed, ${result.removedSidecars} sidecar(s) removed`);
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
