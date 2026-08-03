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
    await work.catch((error) => {
        console.error('[private-journal] backfill failed (best-effort):', error);
    });
    if (git.enabled) {
        await git.commitAndPush(`journal sync: ${new Date().toISOString()}`, migrations_1.CURRENT_DATA_VERSION, { remoteAlreadyPulled: git.lastPullCompleted });
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
    await new server_1.PrivateJournalServer().run();
}
if (require.main === module) {
    main(process.argv).catch((error) => {
        console.error('[private-journal] fatal:', error);
        process.exit(1);
    });
}
