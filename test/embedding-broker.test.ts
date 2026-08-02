import * as fs from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { EmbeddingBroker } from '../src/embedding-broker';
import { FrameDecoder, encodeFrame } from '../src/embedding-protocol';
import { EmbeddingRuntimePaths } from '../src/embedding-runtime';
import { EmbeddingWorker } from '../src/embedding-worker';

async function makeRuntimePaths(): Promise<EmbeddingRuntimePaths> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'embedding-broker-test-'));
  return {
    directory,
    socketPath: path.join(directory, 'embedding.sock'),
    startupLockPath: path.join(directory, 'embedding.startup.lock'),
    pidPath: path.join(directory, 'embedding.pid'),
  };
}

async function listen(server: net.Server, socketPath: string): Promise<void> {
  server.listen(socketPath);
  await once(server, 'listening');
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('EmbeddingBroker', () => {
  const brokers: EmbeddingBroker[] = [];
  const workers: EmbeddingWorker[] = [];
  const servers: net.Server[] = [];
  const runtimeDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await Promise.all(runtimeDirectories.splice(0).map((directory) => (
      fs.rm(directory, { recursive: true, force: true })
    )));
  });

  it('starts one worker when two brokers race on their first RPC', async () => {
    const runtimePaths = await makeRuntimePaths();
    runtimeDirectories.push(runtimePaths.directory);
    const spawnWorker = jest.fn(async () => {
      const worker = new EmbeddingWorker({
        engine: { embed: async (text) => [text.length] },
        runtimePaths,
        idleMs: 0,
      });
      workers.push(worker);
      await worker.listen();
    });
    const first = new EmbeddingBroker({ runtimePaths, spawnWorker, pollIntervalMs: 5 });
    const second = new EmbeddingBroker({ runtimePaths, spawnWorker, pollIntervalMs: 5 });
    brokers.push(first, second);

    await expect(Promise.all([
      first.embedText('first journal', 'passage'),
      second.embedText('find', 'query'),
    ])).resolves.toEqual([[13], [4]]);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('uses the same runtime socket for brokers serving different journal paths', async () => {
    const runtimePaths = await makeRuntimePaths();
    runtimeDirectories.push(runtimePaths.directory);
    let connectionCount = 0;
    const server = net.createServer((socket) => {
      connectionCount++;
      const decoder = new FrameDecoder();
      socket.on('data', (chunk) => {
        for (const value of decoder.push(chunk) as Array<{ id: string }>) {
          socket.write(encodeFrame({ id: value.id, active: false }));
        }
      });
    });
    await listen(server, runtimePaths.socketPath);
    servers.push(server);
    const firstJournal = path.join(runtimePaths.directory, 'journal-a');
    const secondJournal = path.join(runtimePaths.directory, 'journal-b');
    await fs.mkdir(firstJournal);
    await fs.mkdir(secondJournal);
    const first = new EmbeddingBroker({ runtimePaths });
    const second = new EmbeddingBroker({ runtimePaths });
    brokers.push(first, second);

    await Promise.all([first.status(), second.status()]);

    expect(firstJournal).not.toBe(secondJournal);
    expect(connectionCount).toBe(2);
    await Promise.all(brokers.splice(0).map((broker) => broker.close()));
    servers.splice(servers.indexOf(server), 1);
    await closeServer(server);
  });

  it('connects to a live socket without unlinking or spawning', async () => {
    const runtimePaths = await makeRuntimePaths();
    runtimeDirectories.push(runtimePaths.directory);
    const worker = new EmbeddingWorker({
      engine: { embed: async () => [0.25] },
      runtimePaths,
      idleMs: 0,
    });
    workers.push(worker);
    await worker.listen();
    const spawnWorker = jest.fn();
    const broker = new EmbeddingBroker({ runtimePaths, spawnWorker });
    brokers.push(broker);

    await expect(broker.embedText('live', 'query')).resolves.toEqual([0.25]);

    expect(spawnWorker).not.toHaveBeenCalled();
    await expect(fs.stat(runtimePaths.socketPath)).resolves.toBeDefined();
  });

  it('recovers a stale lock and socket before spawning', async () => {
    const runtimePaths = await makeRuntimePaths();
    runtimeDirectories.push(runtimePaths.directory);
    await fs.writeFile(runtimePaths.socketPath, 'stale socket', 'utf8');
    await fs.writeFile(runtimePaths.startupLockPath, JSON.stringify({
      pid: 999999,
      acquiredAt: Date.now() - 60_000,
    }), 'utf8');
    const spawnWorker = jest.fn(async () => {
      await expect(fs.access(runtimePaths.socketPath)).rejects.toThrow();
      const worker = new EmbeddingWorker({
        engine: { embed: async () => [0.5] },
        runtimePaths,
        idleMs: 0,
      });
      workers.push(worker);
      await worker.listen();
    });
    const broker = new EmbeddingBroker({
      runtimePaths,
      spawnWorker,
      isProcessAlive: () => false,
      pollIntervalMs: 5,
    });
    brokers.push(broker);

    await expect(broker.embedText('recovered', 'passage')).resolves.toEqual([0.5]);

    expect(spawnWorker).toHaveBeenCalledTimes(1);
    await expect(fs.access(runtimePaths.startupLockPath)).rejects.toThrow();
  });

  it('maps out-of-order vector responses to their request ids', async () => {
    const runtimePaths = await makeRuntimePaths();
    runtimeDirectories.push(runtimePaths.directory);
    const requests: Array<{ socket: net.Socket; id: string; text: string }> = [];
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk) => {
        for (const value of decoder.push(chunk) as Array<{ id: string; text: string }>) {
          requests.push({ socket, id: value.id, text: value.text });
        }
        if (requests.length === 2) {
          for (const request of [...requests].reverse()) {
            request.socket.write(encodeFrame({
              id: request.id,
              embedding: request.text === 'first' ? [1] : [2],
            }));
          }
        }
      });
    });
    await listen(server, runtimePaths.socketPath);
    servers.push(server);
    const broker = new EmbeddingBroker({ runtimePaths });
    brokers.push(broker);

    await expect(Promise.all([
      broker.embedText('first', 'query'),
      broker.embedText('second', 'passage'),
    ])).resolves.toEqual([[1], [2]]);

    await Promise.all(brokers.splice(0).map((item) => item.close()));
    servers.splice(servers.indexOf(server), 1);
    await closeServer(server);
  });

  it('reconnects and retries once when the socket resets before a response', async () => {
    const runtimePaths = await makeRuntimePaths();
    runtimeDirectories.push(runtimePaths.directory);
    let attempts = 0;
    const server = net.createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.on('data', (chunk) => {
        for (const value of decoder.push(chunk) as Array<{ id: string }>) {
          attempts++;
          if (attempts === 1) {
            socket.destroy();
          } else {
            socket.write(encodeFrame({ id: value.id, embedding: [0.75] }));
          }
        }
      });
    });
    await listen(server, runtimePaths.socketPath);
    servers.push(server);
    const broker = new EmbeddingBroker({ runtimePaths });
    brokers.push(broker);

    await expect(broker.embedText('retry', 'query')).resolves.toEqual([0.75]);
    expect(attempts).toBe(2);

    await Promise.all(brokers.splice(0).map((item) => item.close()));
    servers.splice(servers.indexOf(server), 1);
    await closeServer(server);
  });
});
