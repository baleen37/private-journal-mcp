import * as fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { encodeFrame, FrameDecoder } from '../src/embedding-protocol';
import { EmbeddingWorker } from '../src/embedding-worker';

async function makeFixture(): Promise<{ dir: string; socketPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-worker-test-'));
  return { dir, socketPath: path.join(dir, 'embedding.sock') };
}

describe('EmbeddingWorker', () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup.reverse()) await fn();
    cleanup = [];
  });

  it('runs embedText inference one request at a time', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    let active = 0;
    let maximumActive = 0;
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const engine = {
      embed: async (text: string) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        if (text === 'first') {
          firstStarted();
          await firstCanFinish;
        }
        active--;
        return text === 'first' ? [0.1] : [0.2];
      },
    };
    const worker = new EmbeddingWorker({ engine, runtimePaths: { socketPath }, idleMs: 0 });

    const first = worker.handle({ id: '1', type: 'embedText', text: 'first', kind: 'query' });
    await started;
    const second = worker.handle({ id: '2', type: 'embedText', text: 'second', kind: 'passage' });
    await Promise.resolve();
    expect(maximumActive).toBe(1);
    releaseFirst();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { id: '1', embedding: [0.1] },
      { id: '2', embedding: [0.2] },
    ]);
  });

  it('serves queued query embeddings before queued passage backfill', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const worker = new EmbeddingWorker({
      engine: {
        embed: async (text: string) => {
          order.push(text);
          if (text === 'first passage') {
            firstStarted();
            await firstCanFinish;
          }
          return [order.length];
        },
      },
      runtimePaths: { socketPath },
      idleMs: 0,
    });

    const first = worker.handle({ id: '1', type: 'embedText', text: 'first passage', kind: 'passage' });
    await started;
    const second = worker.handle({ id: '2', type: 'embedText', text: 'second passage', kind: 'passage' });
    const query = worker.handle({ id: '3', type: 'embedText', text: 'interactive query', kind: 'query' });
    releaseFirst();

    await Promise.all([first, second, query]);
    expect(order).toEqual(['first passage', 'interactive query', 'second passage']);
    await worker.close();
  });

  it('returns a framed vector response with the matching request id', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const worker = new EmbeddingWorker({ engine: { embed: async () => [0.1, 0.2] }, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => worker.close());
    await worker.listen();
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    const response = once(socket, 'data');

    socket.write(encodeFrame({ id: 'request-1', type: 'embedText', text: 'find this', kind: 'query' }));

    const [chunk] = await response;
    const [frame] = new FrameDecoder().push(chunk);
    expect(frame).toEqual({ id: 'request-1', embedding: [0.1, 0.2] });
    socket.destroy();
  });

  it('stays available when a client disconnects during inference', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    let releaseEmbedding!: () => void;
    const embeddingCanFinish = new Promise<void>((resolve) => { releaseEmbedding = resolve; });
    let signalStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const worker = new EmbeddingWorker({
      engine: {
        embed: async () => {
          signalStarted();
          await embeddingCanFinish;
          return [0.1];
        },
      },
      runtimePaths: { socketPath },
      idleMs: 0,
    });
    cleanup.push(() => worker.close());
    await worker.listen();

    const disconnectedClient = net.createConnection(socketPath);
    disconnectedClient.on('error', () => {});
    await once(disconnectedClient, 'connect');
    disconnectedClient.write(encodeFrame({ id: 'lost-client', type: 'embedText', text: 'find this', kind: 'query' }));
    await embeddingStarted;
    disconnectedClient.destroy();
    releaseEmbedding();
    await new Promise((resolve) => setTimeout(resolve, 25));

    const healthyClient = net.createConnection(socketPath);
    await once(healthyClient, 'connect');
    const response = once(healthyClient, 'data');
    healthyClient.write(encodeFrame({ id: 'status', type: 'status' }));

    const [chunk] = await response;
    const [frame] = new FrameDecoder().push(chunk);
    expect(frame).toEqual({ id: 'status', active: false });
    healthyClient.destroy();
  });

  it('closes only the malformed socket connection', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const worker = new EmbeddingWorker({ engine: { embed: async () => [0.1] }, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => worker.close());
    await worker.listen();
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');

    socket.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('{')]));
    await once(socket, 'close');

    await expect(worker.handle({ id: 'status', type: 'status' })).resolves.toMatchObject({ id: 'status' });
  });

  it('closes a socket that advertises a frame larger than the protocol limit', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const worker = new EmbeddingWorker({ engine: { embed: async () => [0.1] }, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => worker.close());
    await worker.listen();
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(2 * 1024 * 1024, 0);

    try {
      socket.write(header);
      await Promise.race([
        once(socket, 'close'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('oversized frame socket remained open')), 250)),
      ]);
    } finally {
      socket.destroy();
    }
  });

  it('fails to bind an already-live socket without unlinking it', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const first = new EmbeddingWorker({ engine: { embed: async () => [0.1] }, runtimePaths: { socketPath }, idleMs: 0 });
    const second = new EmbeddingWorker({ engine: { embed: async () => [0.2] }, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => first.close(), () => second.close());
    await first.listen();

    await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.close();
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    socket.destroy();
  });

  it('rejects journal requests without creating a sidecar', async () => {
    const { dir, socketPath } = await makeFixture();
    const mdPath = path.join(dir, 'entry.md');
    await fs.writeFile(mdPath, '# Journal entry', 'utf8');
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const worker = new EmbeddingWorker({ engine: { embed: async () => [0.1] }, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => worker.close());
    await worker.listen();
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    const response = once(socket, 'data');

    try {
      socket.write(encodeFrame({ id: 'journal', type: 'ensurePassage', dataPath: dir, mdPath, priority: 'interactive' }));

      const [chunk] = await response;
      const [frame] = new FrameDecoder().push(chunk);
      expect(frame).toEqual({ error: 'invalid worker request' });
      await expect(fs.stat(path.join(dir, 'entry.embedding'))).rejects.toThrow();
    } finally {
      socket.destroy();
    }
  });
});
