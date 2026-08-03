import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { FrameDecoder, encodeFrame } from './embedding-protocol';
import { EmbeddingRuntimePaths, resolveEmbeddingRuntimePaths } from './embedding-runtime';

type EmbeddingKind = 'passage' | 'query';

interface BrokerOptions {
  runtimePaths?: EmbeddingRuntimePaths;
  spawnWorker?: () => void | Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  pollIntervalMs?: number;
  startupTimeoutMs?: number;
}

interface WorkerResponse {
  id?: string;
  embedding?: number[];
  active?: boolean;
  error?: string;
}

interface PendingRequest {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
}

interface StartupLock {
  pid: number;
  acquiredAt: number;
  nonce: string;
}

interface HeldStartupLock {
  owner: StartupLock;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

export class EmbeddingBroker {
  private readonly runtimePaths: EmbeddingRuntimePaths;
  private readonly spawnWorker: () => void | Promise<void>;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly pollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextRequestId = 1;
  private closed = false;

  constructor(options: BrokerOptions = {}) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    this.runtimePaths = options.runtimePaths
      ?? resolveEmbeddingRuntimePaths(process.env, process.platform, uid);
    this.spawnWorker = options.spawnWorker ?? (() => {
      const workerEntry = path.join(__dirname, '..', 'dist', 'index.js');
      const env = process.versions.bun ? { ...process.env, BUN_BE_BUN: '1' } : undefined;
      const child = spawn(process.execPath, [workerEntry, 'embedding-worker'], {
        detached: true,
        ...(env ? { env } : {}),
        stdio: 'ignore',
      });
      child.unref();
    });
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
  }

  async embedText(text: string, kind: EmbeddingKind): Promise<number[]> {
    const response = await this.rpc({ type: 'embedText', text, kind });
    if (!Array.isArray(response.embedding)) throw new Error('worker returned no embedding');
    return response.embedding;
  }

  async status(): Promise<boolean> {
    const response = await this.rpc({ type: 'status' });
    if (typeof response.active !== 'boolean') throw new Error('worker returned no status');
    return response.active;
  }

  async close(): Promise<void> {
    this.closed = true;
    const error = new Error('embedding broker closed');
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  private async rpc(request: Record<string, unknown>): Promise<WorkerResponse> {
    const id = String(this.nextRequestId++);
    const framedRequest = { id, ...request };
    try {
      return await this.sendOnce(framedRequest);
    } catch (error) {
      if (!this.isRetryable(error)) throw error;
      return this.sendOnce(framedRequest);
    }
  }

  private async sendOnce(request: Record<string, unknown>): Promise<WorkerResponse> {
    await this.ensureConnected();
    if (this.closed) throw new Error('embedding broker closed');
    const socket = this.socket;
    if (!socket) throw new Error('embedding worker connection unavailable');
    const id = String(request.id);
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      socket.write(encodeFrame(request), (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
        this.failSocket(socket, error);
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.closed) throw new Error('embedding broker closed');
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.connectOrStart().finally(() => {
        this.connecting = null;
      });
    }
    await this.connecting;
    if (this.closed) throw new Error('embedding broker closed');
  }

  private async connectOrStart(): Promise<void> {
    try {
      await this.openSocket();
      return;
    } catch (error) {
      if (!this.isUnavailable(error)) throw error;
    }

    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      const lock = await this.tryAcquireLock();
      if (lock) {
        try {
          if (await this.tryOpenSocket()) return;
          await this.unlinkIfExists(this.runtimePaths.socketPath);
          await this.spawnWorker();
          await this.waitForSocket(deadline);
          return;
        } finally {
          await this.releaseLock(lock);
        }
      }

      if (await this.tryOpenSocket()) return;
      const owner = await this.readStartupLock();
      if ((!owner || !this.isProcessAlive(owner.pid)) && !await this.socketIsHealthy()) {
        await this.reclaimStaleLock();
        continue;
      }
      await this.delay();
    }
    throw new Error('timed out waiting for embedding worker');
  }

  private async tryAcquireLock(): Promise<HeldStartupLock | null> {
    try {
      await fs.mkdir(this.runtimePaths.startupLockPath, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return null;
      throw error;
    }
    const owner: StartupLock = {
      pid: process.pid,
      acquiredAt: Date.now(),
      nonce: crypto.randomUUID(),
    };
    try {
      await fs.writeFile(path.join(this.runtimePaths.startupLockPath, 'owner.json'), JSON.stringify(owner), {
        encoding: 'utf8', mode: 0o600,
      });
      return { owner };
    } catch (error) {
      await fs.rm(this.runtimePaths.startupLockPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async releaseLock(lock: HeldStartupLock): Promise<void> {
    const owner = await this.readStartupLock();
    if (owner?.nonce === lock.owner.nonce) {
      await fs.rm(this.runtimePaths.startupLockPath, { recursive: true, force: true });
    }
  }

  private async readStartupLock(): Promise<StartupLock | null> {
    try {
      const value = JSON.parse(await fs.readFile(path.join(this.runtimePaths.startupLockPath, 'owner.json'), 'utf8')) as Partial<StartupLock>;
      return typeof value.pid === 'number' && typeof value.acquiredAt === 'number' && typeof value.nonce === 'string'
        ? { pid: value.pid, acquiredAt: value.acquiredAt, nonce: value.nonce }
        : null;
    } catch {
      return null;
    }
  }

  private async reclaimStaleLock(): Promise<void> {
    const guardPath = `${this.runtimePaths.startupLockPath}.reclaim`;
    try {
      await fs.mkdir(guardPath, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return;
      throw error;
    }
    try {
      if (await this.socketIsHealthy()) return;
      const owner = await this.readStartupLock();
      if (owner && this.isProcessAlive(owner.pid)) return;
      const claimedPath = `${guardPath}/claimed`;
      try {
        await fs.rename(this.runtimePaths.startupLockPath, claimedPath);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
      await fs.rm(claimedPath, { recursive: true, force: true });
    } finally {
      await fs.rm(guardPath, { recursive: true, force: true });
    }
  }

  private async waitForSocket(deadline: number): Promise<void> {
    while (Date.now() < deadline) {
      if (await this.tryOpenSocket()) return;
      await this.delay();
    }
    throw new Error('timed out waiting for embedding worker socket');
  }

  private async socketIsHealthy(): Promise<boolean> {
    if (this.socket && !this.socket.destroyed) return true;
    return this.tryOpenSocket();
  }

  private async tryOpenSocket(): Promise<boolean> {
    try {
      await this.openSocket();
      return true;
    } catch (error) {
      if (this.isUnavailable(error)) return false;
      throw error;
    }
  }

  private openSocket(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(this.runtimePaths.socketPath);
      const onError = (error: Error) => {
        socket.removeListener('connect', onConnect);
        socket.destroy();
        reject(error);
      };
      const onConnect = () => {
        socket.removeListener('error', onError);
        if (this.closed) {
          socket.destroy();
          reject(new Error('embedding broker closed'));
          return;
        }
        this.attachSocket(socket);
        resolve();
      };
      socket.once('error', onError);
      socket.once('connect', onConnect);
    });
  }

  private attachSocket(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    const decoder = new FrameDecoder();
    this.socket = socket;
    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        this.failSocket(socket, error instanceof Error ? error : new Error(String(error)));
        return;
      }
      for (const frame of frames) this.handleResponse(frame);
    });
    socket.on('error', (error) => this.failSocket(socket, error));
    socket.on('close', () => {
      const error = Object.assign(new Error('embedding worker connection reset'), { code: 'ECONNRESET' });
      this.failSocket(socket, error);
    });
  }

  private handleResponse(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const response = value as WorkerResponse;
    if (typeof response.id !== 'string') return;
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    if (typeof response.error === 'string') request.reject(new Error(response.error));
    else request.resolve(response);
  }

  private failSocket(socket: net.Socket, error: Error): void {
    if (this.socket !== socket) return;
    this.socket = null;
    socket.destroy();
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private isUnavailable(error: unknown): boolean {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK';
  }

  private isRetryable(error: unknown): boolean {
    const code = errorCode(error);
    return code === 'ECONNRESET' || code === 'ECONNREFUSED';
  }

  private async unlinkIfExists(targetPath: string): Promise<void> {
    try {
      await fs.unlink(targetPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
  }
}
