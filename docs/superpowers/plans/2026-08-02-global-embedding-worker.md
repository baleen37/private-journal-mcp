# Global Embedding Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Run exactly one warm embedding model worker per OS user while every private-journal MCP and sync process safely shares it.

**Architecture:** A local EmbeddingBroker connects to a user-private Unix socket and starts one detached EmbeddingWorker only when no healthy worker exists. The worker owns model loading, serial inference, Markdown-to-sidecar generation, and atomic sidecar replacement; clients retain journal traversal and search scoring.

**Tech Stack:** TypeScript 5, Node.js 22, Unix domain sockets (node:net), node:child_process, Jest 29, @huggingface/transformers.

## Global Constraints

- Scope the worker to one OS user, never to all users on a physical host.
- Share one worker across every PRIVATE_JOURNAL_PATH for that OS user.
- Keep Markdown as the source of truth and .embedding as regenerable, untracked derived data.
- Preserve local-only mode, Git sync, data-migration ordering, and the public MCP tool contract.
- Use only Unix sockets; do not add TCP, launchd, systemd, a database, or an npm dependency.
- Keep model loading in the worker process. Unit tests inject a fake engine; only process-race tests spawn Node workers.

---

## File Structure

| File | Responsibility |
| --- | --- |
| src/embedding-protocol.ts | Versioned framed request and response types plus frame encoding. |
| src/embedding-runtime.ts | User-private socket, startup-lock, and PID runtime paths. |
| src/embedding-sidecar.ts | Parse, validate, and atomically replace sidecars. |
| src/embedding-engine.ts | Worker-only lazy transformers model wrapper. |
| src/embedding-worker.ts | Unix socket server, serial priority queue, request coalescing, and sidecar ownership. |
| src/embedding-broker.ts | Client connection, one-worker startup, and RPC retries. |
| src/embeddings.ts | Existing public facade, delegated to EmbeddingBroker. |
| src/journal.ts, src/search.ts, src/index.ts | Use the facade without loading a local model. |
| test/embedding-*.test.ts | Protocol, runtime, worker, broker, and multi-process race coverage. |

## Shared Interfaces

~~~ts
export type EmbeddingKind = 'passage' | 'query';

export interface EmbeddingBrokerClient {
  embedText(text: string, kind: EmbeddingKind): Promise<number[]>;
  ensurePassage(dataPath: string, mdPath: string, priority: 'interactive' | 'background'): Promise<boolean>;
  close(): Promise<void>;
}

export interface EmbeddingEngine {
  embed(text: string, kind: EmbeddingKind): Promise<number[]>;
}

export type WorkerRequest =
  | { id: string; type: 'embedText'; text: string; kind: EmbeddingKind }
  | { id: string; type: 'ensurePassage'; dataPath: string; mdPath: string; priority: 'interactive' | 'background' }
  | { id: string; type: 'status' };
~~~

ensurePassage returns true only when it creates a sidecar. It returns false for an already valid sidecar or a Markdown file that changed or disappeared before it could be saved.

### Task 1: Versioned protocol and user runtime paths

**Files:**

- Create: src/embedding-protocol.ts
- Create: src/embedding-runtime.ts
- Create: test/embedding-protocol.test.ts
- Create: test/embedding-runtime.test.ts

**Interfaces:**

- Produces: encodeFrame(value: unknown): Buffer, FrameDecoder, WORKER_WIRE_VERSION, and resolveEmbeddingRuntimePaths(env, platform, uid).
- Produces: { directory, socketPath, startupLockPath, pidPath } with a short, user-private path.

- [ ] **Step 1: Write the failing tests**

~~~ts
it('decodes a request split across arbitrary socket chunks', () => {
  const decoder = new FrameDecoder();
  const frame = encodeFrame({ id: 'a', type: 'status' });
  expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
  expect(decoder.push(frame.subarray(3))).toEqual([{ id: 'a', type: 'status' }]);
});

it('uses XDG runtime directory and keeps the socket path short', () => {
  const paths = resolveEmbeddingRuntimePaths(
    { XDG_RUNTIME_DIR: '/tmp/runtime-jito' }, 'linux', 501,
  );
  expect(paths.directory).toBe('/tmp/runtime-jito/private-journal');
  expect(paths.socketPath.length).toBeLessThan(100);
});
~~~

- [ ] **Step 2: Run the tests and confirm RED**

Run: npm test -- --runInBand test/embedding-protocol.test.ts test/embedding-runtime.test.ts

Expected: FAIL because the protocol and runtime modules do not exist.

- [ ] **Step 3: Implement the protocol and path resolver**

~~~ts
export const WORKER_WIRE_VERSION = 1;

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}
~~~

Use XDG_RUNTIME_DIR on Linux. Otherwise use path.join(os.tmpdir(), 'private-journal-' + uid, 'private-journal'). Create the directory with mode 0o700. The worker will create the socket with mode 0o600.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: npm test -- --runInBand test/embedding-protocol.test.ts test/embedding-runtime.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add src/embedding-protocol.ts src/embedding-runtime.ts test/embedding-protocol.test.ts test/embedding-runtime.test.ts
git commit -m "feat: add embedding worker protocol"
~~~

### Task 2: Worker-owned sidecar generation and serial queue

**Files:**

- Create: src/embedding-sidecar.ts
- Create: src/embedding-engine.ts
- Create: src/embedding-worker.ts
- Create: test/embedding-worker.test.ts

**Interfaces:**

- Consumes: EmbeddingEngine, WorkerRequest, encodeFrame, and resolveEmbeddingRuntimePaths.
- Produces: EmbeddingWorker.listen(), EmbeddingWorker.close(), and EmbeddingWorker.handle(request).
- Produces: writeEmbeddingAtomically(mdPath, data): Promise<void>.

- [ ] **Step 1: Write the failing worker tests**

~~~ts
it('coalesces simultaneous passage requests for one markdown file', async () => {
  const engine = { embed: jest.fn(async () => [0.1, 0.2]) };
  const worker = new EmbeddingWorker({ engine, runtimePaths, idleMs: 0 });
  await worker.listen();
  const [first, second] = await Promise.all([
    worker.handle({ id: '1', type: 'ensurePassage', dataPath: dir, mdPath, priority: 'interactive' }),
    worker.handle({ id: '2', type: 'ensurePassage', dataPath: dir, mdPath, priority: 'interactive' }),
  ]);
  expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
  expect(engine.embed).toHaveBeenCalledTimes(1);
});

it('replaces sidecars without exposing invalid JSON to readers', async () => {
  await writeEmbeddingAtomically(mdPath, data);
  const raw = await fs.readFile(mdPath.replace(/\.md$/, '.embedding'), 'utf8');
  expect(JSON.parse(raw)).toEqual(data);
});
~~~

- [ ] **Step 2: Run the tests and confirm RED**

Run: npm test -- --runInBand test/embedding-worker.test.ts

Expected: FAIL because worker and sidecar modules do not exist.

- [ ] **Step 3: Implement worker ownership**

~~~ts
export async function writeEmbeddingAtomically(mdPath: string, data: EmbeddingData): Promise<void> {
  const target = mdPath.replace(/\.md$/, '.embedding');
  const temporary = target + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}
~~~

Use one active job. Put embedText and write-triggered ensurePassage jobs in the interactive queue. Put backfill ensurePassage jobs in the background queue. After each background job, process any waiting interactive job. Store one promise per canonical Markdown path so duplicate ensurePassage requests await one inference.

The worker validates mdPath with realpath containment under dataPath. It reads Markdown, creates EmbeddingData, then rereads Markdown before rename. If the file changed or vanished, return created: false without saving. EmbeddingEngine imports @huggingface/transformers only in its lazy embed method.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: npm test -- --runInBand test/embedding-worker.test.ts

Expected: PASS, including one engine call for two same-file requests and valid JSON sidecars.

- [ ] **Step 5: Commit**

~~~bash
git add src/embedding-sidecar.ts src/embedding-engine.ts src/embedding-worker.ts test/embedding-worker.test.ts
git commit -m "feat: add single embedding worker"
~~~

### Task 3: Broker startup, recovery, and CLI worker mode

**Files:**

- Create: src/embedding-broker.ts
- Modify: src/index.ts:1-60
- Create: test/embedding-broker.test.ts
- Modify: test/index.test.ts

**Interfaces:**

- Consumes: EmbeddingBrokerClient, protocol frames, runtime paths, and embedding-worker CLI mode.
- Produces: EmbeddingBroker.embedText, EmbeddingBroker.ensurePassage, and EmbeddingBroker.close.

- [ ] **Step 1: Write the failing broker lifecycle tests**

~~~ts
it('starts one worker when two brokers race to connect', async () => {
  const spawnWorker = jest.fn(async () => startFakeWorker(runtimePaths));
  const [a, b] = await Promise.all([
    new EmbeddingBroker({ runtimePaths, spawnWorker }).connect(),
    new EmbeddingBroker({ runtimePaths, spawnWorker }).connect(),
  ]);
  expect(spawnWorker).toHaveBeenCalledTimes(1);
  await Promise.all([a.close(), b.close()]);
});

it('removes only a stale startup lock after a failed connection', async () => {
  await fs.writeFile(runtimePaths.startupLockPath, JSON.stringify({ pid: 999999 }));
  await expect(new EmbeddingBroker({ runtimePaths }).connect()).resolves.toBeDefined();
});
~~~

- [ ] **Step 2: Run the tests and confirm RED**

Run: npm test -- --runInBand test/embedding-broker.test.ts test/index.test.ts

Expected: FAIL because the broker and embedding-worker CLI branch do not exist.

- [ ] **Step 3: Implement broker startup and retry**

~~~ts
async connect(): Promise<void> {
  if (await this.tryConnect()) return;
  if (await this.acquireStartupLock()) await this.spawnWorker();
  await this.waitForSocket();
}
~~~

Acquire the startup lock with fs.open(lockPath, 'wx'). Remove it only when both socket health and PID liveness prove it stale. Spawn node dist/index.js embedding-worker detached with stdio ignore, then unref it. Add argv[2] === 'embedding-worker' before the existing sync branch. The worker deletes its startup lock only after socket bind succeeds.

On ECONNRESET or ECONNREFUSED, reconnect and retry the RPC once. Do not retry after a response has started.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: npm test -- --runInBand test/embedding-broker.test.ts test/index.test.ts

Expected: PASS, including a single start under a two-client race and unchanged sync dispatch.

- [ ] **Step 5: Commit**

~~~bash
git add src/embedding-broker.ts src/index.ts test/embedding-broker.test.ts test/index.test.ts
git commit -m "feat: broker embedding worker requests"
~~~

### Task 4: Route journal, search, and sync through the broker

**Files:**

- Modify: src/embeddings.ts:1-81
- Modify: src/journal.ts:68-102
- Modify: src/search.ts:74-195
- Modify: src/server.ts:100-165
- Modify: test/embeddings.test.ts
- Modify: test/journal.write.test.ts
- Modify: test/search.test.ts
- Modify: test/server.test.ts

**Interfaces:**

- Consumes: EmbeddingBrokerClient from Task 3.
- Produces: EmbeddingService.generateEmbedding(text, kind) backed by embedText and EmbeddingService.ensurePassage(dataPath, mdPath, priority).

- [ ] **Step 1: Write the failing application-path tests**

~~~ts
it('asks the broker to create the sidecar after markdown is written', async () => {
  const broker = { embedText: jest.fn(), ensurePassage: jest.fn().mockResolvedValue(true), close: jest.fn() };
  const journal = new JournalManager(dir, new EmbeddingService(broker));
  const mdPath = await journal.write({ observations: 'entry' });
  expect(broker.ensurePassage).toHaveBeenCalledWith(dir, mdPath, 'interactive');
});

it('uses the broker for query vectors and background backfill', async () => {
  const broker = { embedText: jest.fn().mockResolvedValue([1, 0]), ensurePassage: jest.fn().mockResolvedValue(true), close: jest.fn() };
  const search = new SearchService(dir, new EmbeddingService(broker));
  await search.search('query');
  await search.backfill();
  expect(broker.embedText).toHaveBeenCalledWith('query', 'query');
  expect(broker.ensurePassage).toHaveBeenCalledWith(dir, expect.any(String), 'background');
});
~~~

- [ ] **Step 2: Run the tests and confirm RED**

Run: npm test -- --runInBand test/embeddings.test.ts test/journal.write.test.ts test/search.test.ts test/server.test.ts

Expected: FAIL because the application still calls the per-process model and writes sidecars directly.

- [ ] **Step 3: Implement broker-backed application paths**

Keep cosineSimilarity, extractSearchableText, embeddingPathFor, and loadEmbedding as local EmbeddingService helpers. Make the constructor accept EmbeddingBrokerClient, with getInstance creating the default EmbeddingBroker. Replace direct passage generation and saveEmbedding in JournalManager.write with ensurePassage(dataPath, mdPath, 'interactive'). Replace SearchService.embedIfMissing with ensurePassage(dataPath, mdPath, 'background'). Keep SearchService.search local except for generateEmbedding(query, 'query').

The worker builds EmbeddingData from Markdown. If an embedding RPC fails after Markdown write, log the error and return the Markdown path, preserving current best-effort behavior.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: npm test -- --runInBand test/embeddings.test.ts test/journal.write.test.ts test/search.test.ts test/server.test.ts test/index.test.ts

Expected: PASS with no test loading the real Hugging Face model.

- [ ] **Step 5: Commit**

~~~bash
git add src/embeddings.ts src/journal.ts src/search.ts src/server.ts test/embeddings.test.ts test/journal.write.test.ts test/search.test.ts test/server.test.ts
git commit -m "feat: share embeddings through worker"
~~~

### Task 5: Process-race verification and user documentation

**Files:**

- Create: test/embedding-worker.integration.test.ts
- Modify: README.md:1-153

**Interfaces:**

- Consumes: installed embedding-worker CLI, status RPC, and environment-scoped temporary journal paths.
- Produces: a regression test proving one worker serves multiple Node clients.

- [ ] **Step 1: Write the failing cross-process regression test**

~~~ts
it('shares one worker across two journal paths and serializes passage generation', async () => {
  const [first, second] = await Promise.all([
    runFixture({ dataPath: firstPath, text: 'first' }),
    runFixture({ dataPath: secondPath, text: 'second' }),
  ]);
  expect(first.workerPid).toBe(second.workerPid);
  expect(first.maxConcurrentEmbeds).toBe(1);
  expect(second.maxConcurrentEmbeds).toBe(1);
});
~~~

- [ ] **Step 2: Run the test and confirm RED**

Run: npm test -- --runInBand test/embedding-worker.integration.test.ts

Expected: FAIL before fixture support, fake engine hook, and cross-process status support exist.

- [ ] **Step 3: Implement fixture support and documentation**

Use a test-only fake engine selected by PRIVATE_JOURNAL_TEST_EMBEDDING_ENGINE=1. It writes a shared counter file around each embed call. Guard this path with process.env.NODE_ENV === 'test'; production always constructs EmbeddingEngine.

Document one OS-user worker, warm-model lifetime while MCP connections exist, and automatic sidecar recovery after worker loss. Document that no new configuration variable or network listener exists.

- [ ] **Step 4: Run focused and full verification**

Run: npm test -- --runInBand test/embedding-worker.integration.test.ts && npm test -- --runInBand && npm run build && git diff --check

Expected: all Jest tests pass, TypeScript compiles, and the diff has no whitespace errors.

- [ ] **Step 5: Perform a local smoke test and commit**

Run: PRIVATE_JOURNAL_PATH="$(mktemp -d)" node dist/index.js sync

Expected: exits successfully in local-only mode; the command may start and stop the local worker but must not make network calls.

~~~bash
git add test/embedding-worker.integration.test.ts README.md
git commit -m "test: verify shared embedding worker"
~~~

## Plan Self-Review

- **Spec coverage:** Tasks 1-3 implement global socket ownership, secure startup, serial inference, and recovery. Task 4 keeps MCP, sync, local-only, Git, and migration call paths intact. Task 5 verifies multi-process behavior, build health, and user documentation.
- **No placeholder scan:** Every task has files, interface names, test code, commands, and success criteria.
- **Type consistency:** All callers use EmbeddingBrokerClient.embedText and EmbeddingBrokerClient.ensurePassage with the signatures declared above.

