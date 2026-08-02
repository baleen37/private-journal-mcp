import * as fs from 'fs/promises';
import net from 'net';
import { EmbeddingEngine } from './embedding-engine';
import { FrameDecoder, encodeFrame } from './embedding-protocol';
import { EmbeddingRuntimePaths } from './embedding-runtime';

export interface EmbedTextRequest {
  id: string;
  type: 'embedText';
  text: string;
  kind: 'passage' | 'query';
}

export interface StatusRequest {
  id: string;
  type: 'status';
}

export type WorkerRequest = EmbedTextRequest | StatusRequest;

export interface WorkerResponse {
  id?: string;
  embedding?: number[];
  error?: string;
  active?: boolean;
}

interface WorkerEngine {
  embed(text: string, kind: 'passage' | 'query'): Promise<number[]>;
}

interface WorkerOptions {
  engine?: WorkerEngine;
  runtimePaths: Pick<EmbeddingRuntimePaths, 'socketPath'>;
  idleMs: number;
}

interface QueuedJob<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class EmbeddingWorker {
  private readonly engine: WorkerEngine;
  private readonly runtimePaths: Pick<EmbeddingRuntimePaths, 'socketPath'>;
  private readonly queue: QueuedJob<unknown>[] = [];
  private server: net.Server | null = null;
  private active = false;
  private draining = false;

  constructor({ engine = new EmbeddingEngine(), runtimePaths }: WorkerOptions) {
    this.engine = engine;
    this.runtimePaths = runtimePaths;
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.runtimePaths.socketPath);
    });
    this.server = server;
    await fs.chmod(this.runtimePaths.socketPath, 0o600);
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async handle(request: WorkerRequest): Promise<WorkerResponse> {
    if (request.type === 'status') return { id: request.id, active: this.active };
    const embedding = await this.enqueue(() => this.engine.embed(request.text, request.kind));
    return { id: request.id, embedding };
  }

  private accept(socket: net.Socket): void {
    const decoder = new FrameDecoder();
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => {
      let requests: unknown[];
      try {
        requests = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const value of requests) void this.reply(socket, value);
    });
  }

  private async reply(socket: net.Socket, value: unknown): Promise<void> {
    const request = this.parseRequest(value);
    if (!request) {
      socket.write(encodeFrame({ error: 'invalid worker request' }));
      return;
    }
    try {
      socket.write(encodeFrame(await this.handle(request)));
    } catch (error) {
      socket.write(encodeFrame({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private parseRequest(value: unknown): WorkerRequest | null {
    if (!value || typeof value !== 'object') return null;
    const request = value as Record<string, unknown>;
    if (typeof request.id !== 'string' || typeof request.type !== 'string') return null;
    if (request.type === 'status') return { id: request.id, type: 'status' };
    if (request.type === 'embedText'
      && typeof request.text === 'string'
      && (request.kind === 'passage' || request.kind === 'query')) {
      return { id: request.id, type: 'embedText', text: request.text, kind: request.kind };
    }
    return null;
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ run, resolve: resolve as (value: unknown) => void, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const job = this.queue.shift();
        if (!job) return;
        this.active = true;
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        } finally {
          this.active = false;
        }
      }
    } finally {
      this.draining = false;
      if (this.queue.length) void this.drain();
    }
  }
}
