import * as fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { encodeFrame } from '../src/embedding-protocol';
import { EmbeddingWorker, WorkerRequest } from '../src/embedding-worker';
import { writeEmbeddingAtomically } from '../src/embedding-sidecar';
import { EmbeddingData } from '../src/types';

async function makeFixture(): Promise<{ dir: string; mdPath: string; socketPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-worker-test-'));
  const mdPath = path.join(dir, 'note.md');
  await fs.writeFile(mdPath, '# Note\nhello', 'utf8');
  return { dir, mdPath, socketPath: path.join(dir, 'embedding.sock') };
}

function passageRequest(id: string, dir: string, mdPath: string, priority: 'interactive' | 'background' = 'interactive'): WorkerRequest {
  return { id, type: 'ensurePassage', dataPath: dir, mdPath, priority };
}

describe('EmbeddingWorker', () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanup.map((fn) => fn()));
    cleanup = [];
  });

  it('coalesces simultaneous passage requests for one markdown file', async () => {
    const { dir, mdPath, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const engine = { embed: jest.fn(async () => [0.1, 0.2]) };
    const worker = new EmbeddingWorker({ engine, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => worker.close());
    await worker.listen();

    const [first, second] = await Promise.all([
      worker.handle(passageRequest('1', dir, mdPath)),
      worker.handle(passageRequest('2', dir, mdPath)),
    ]);

    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(engine.embed).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'note.embedding'), 'utf8'))).toMatchObject({ embedding: [0.1, 0.2], text: '# Note\nhello', path: await fs.realpath(mdPath) });
  });

  it('replaces sidecars without exposing invalid JSON to readers', async () => {
    const { dir, mdPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const data: EmbeddingData = { embedding: [0.1, 0.2], text: 'hello', sections: [], timestamp: 1, path: mdPath };

    await writeEmbeddingAtomically(mdPath, data);

    expect(JSON.parse(await fs.readFile(path.join(dir, 'note.embedding'), 'utf8'))).toEqual(data);
  });

  it('keeps an existing valid sidecar without running inference', async () => {
    const { dir, mdPath, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const existing: EmbeddingData = { embedding: [0.9], text: '# Note\nhello', sections: [], timestamp: 1, path: await fs.realpath(mdPath) };
    await writeEmbeddingAtomically(mdPath, existing);
    const engine = { embed: jest.fn(async () => [0.1]) };
    const worker = new EmbeddingWorker({ engine, runtimePaths: { socketPath }, idleMs: 0 });

    await expect(worker.handle(passageRequest('1', dir, mdPath))).resolves.toMatchObject({ created: false });
    expect(JSON.parse(await fs.readFile(path.join(dir, 'note.embedding'), 'utf8'))).toEqual(existing);
  });

  it('rejects a markdown path outside its data directory after resolving symlinks', async () => {
    const { dir, mdPath, socketPath } = await makeFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-worker-outside-'));
    const linkedPath = path.join(dir, 'linked.md');
    await fs.writeFile(path.join(outside, 'secret.md'), 'secret', 'utf8');
    await fs.symlink(path.join(outside, 'secret.md'), linkedPath);
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }), () => fs.rm(outside, { recursive: true, force: true }));
    const worker = new EmbeddingWorker({ engine: { embed: async () => [0.1] }, runtimePaths: { socketPath }, idleMs: 0 });

    await expect(worker.handle(passageRequest('1', dir, linkedPath))).resolves.toMatchObject({ created: false, error: 'markdown path is outside data path' });
  });

  it('does not save a sidecar when markdown changes during embedding', async () => {
    const { dir, mdPath, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const engine = {
      embed: async () => {
        await fs.writeFile(mdPath, '# Note\nchanged', 'utf8');
        return [0.1];
      },
    };
    const worker = new EmbeddingWorker({ engine, runtimePaths: { socketPath }, idleMs: 0 });

    await expect(worker.handle(passageRequest('1', dir, mdPath))).resolves.toMatchObject({ created: false });
    await expect(fs.stat(path.join(dir, 'note.embedding'))).rejects.toThrow();
  });

  it('runs waiting interactive work between background jobs', async () => {
    const { dir, mdPath, socketPath } = await makeFixture();
    const secondPath = path.join(dir, 'second.md');
    const interactivePath = path.join(dir, 'interactive.md');
    await fs.writeFile(secondPath, 'second', 'utf8');
    await fs.writeFile(interactivePath, 'interactive', 'utf8');
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const started: string[] = [];
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let unblockFirst!: () => void;
    const firstUnblocked = new Promise<void>((resolve) => { unblockFirst = resolve; });
    const engine = {
      embed: async (text: string) => {
        started.push(text);
        if (text === '# Note\nhello') {
          releaseFirst();
          await firstUnblocked;
        }
        return [0.1];
      },
    };
    const worker = new EmbeddingWorker({ engine, runtimePaths: { socketPath }, idleMs: 0 });
    const first = worker.handle(passageRequest('1', dir, mdPath, 'background'));
    const second = worker.handle(passageRequest('2', dir, secondPath, 'background'));
    await firstStarted;
    const interactive = worker.handle(passageRequest('3', dir, interactivePath));
    unblockFirst();
    await Promise.all([first, second, interactive]);

    expect(started).toEqual(['# Note\nhello', 'interactive', 'second']);
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

    expect(await worker.handle({ id: 'status', type: 'status' })).toMatchObject({ id: 'status' });
  });

  it('writes responses to valid socket frames', async () => {
    const { dir, socketPath } = await makeFixture();
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const worker = new EmbeddingWorker({ engine: { embed: async () => [0.1] }, runtimePaths: { socketPath }, idleMs: 0 });
    cleanup.push(() => worker.close());
    await worker.listen();
    const socket = net.createConnection(socketPath);
    await once(socket, 'connect');
    const response = once(socket, 'data');

    socket.write(encodeFrame({ id: 'status', type: 'status' }));

    const [frame] = await response;
    expect(frame.readUInt32BE(0)).toBeGreaterThan(0);
    expect(JSON.parse(frame.subarray(4).toString('utf8'))).toMatchObject({ id: 'status' });
    socket.destroy();
  });
});
