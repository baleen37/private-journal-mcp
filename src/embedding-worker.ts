import * as fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { EmbeddingEngine } from './embedding-engine';
import { FrameDecoder, encodeFrame } from './embedding-protocol';
import { EmbeddingRuntimePaths } from './embedding-runtime';
import { embeddingMetadata, hasValidEmbedding, writeEmbeddingAtomically } from './embedding-sidecar';

type Priority = 'interactive' | 'background';

export interface EnsurePassageRequest {
  id: string;
  type: 'ensurePassage';
  dataPath: string;
  mdPath: string;
  priority: Priority;
}

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

export type WorkerRequest = EnsurePassageRequest | EmbedTextRequest | StatusRequest;

export interface WorkerResponse {
  id: string;
  created?: boolean;
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
  private readonly interactive: QueuedJob<unknown>[] = [];
  private readonly background: QueuedJob<unknown>[] = [];
  private readonly pendingPassages = new Map<string, Promise<WorkerResponse>>();
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
    if (request.type === 'embedText') {
      const embedding = await this.enqueue('interactive', () => this.engine.embed(request.text, request.kind));
      return { id: request.id, embedding };
    }

    let mdPath: string;
    try {
      mdPath = await this.resolveMarkdownPath(request.dataPath, request.mdPath);
    } catch (error) {
      return { id: request.id, created: false, error: error instanceof Error ? error.message : String(error) };
    }

    const pending = this.pendingPassages.get(mdPath);
    if (pending) {
      const result = await pending;
      return { ...result, id: request.id, created: false };
    }

    const job = this.enqueue(request.priority, () => this.ensurePassage(request.id, mdPath));
    this.pendingPassages.set(mdPath, job);
    try {
      return await job;
    } finally {
      this.pendingPassages.delete(mdPath);
    }
  }

  private accept(socket: net.Socket): void {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      let requests: unknown[];
      try {
        requests = decoder.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const value of requests) {
        void this.reply(socket, value);
      }
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
    if (request.type === 'ensurePassage'
      && typeof request.dataPath === 'string'
      && typeof request.mdPath === 'string'
      && (request.priority === 'interactive' || request.priority === 'background')) {
      return { id: request.id, type: 'ensurePassage', dataPath: request.dataPath, mdPath: request.mdPath, priority: request.priority };
    }
    return null;
  }

  private enqueue<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = priority === 'interactive' ? this.interactive : this.background;
      queue.push({ run, resolve: resolve as (value: unknown) => void, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const job = this.interactive.shift() ?? this.background.shift();
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
      if (this.interactive.length || this.background.length) void this.drain();
    }
  }

  private async resolveMarkdownPath(dataPath: string, mdPath: string): Promise<string> {
    const [dataRealPath, markdownRealPath] = await Promise.all([fs.realpath(dataPath), fs.realpath(mdPath)]);
    const relative = path.relative(dataRealPath, markdownRealPath);
    if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('markdown path is outside data path');
    }
    if (path.extname(markdownRealPath) !== '.md' || !(await fs.stat(markdownRealPath)).isFile()) {
      throw new Error('markdown path must be a regular .md file');
    }
    return markdownRealPath;
  }

  private async ensurePassage(id: string, mdPath: string): Promise<WorkerResponse> {
    let text: string;
    try {
      text = await fs.readFile(mdPath, 'utf8');
    } catch {
      return { id, created: false };
    }
    const metadata = embeddingMetadata(mdPath, text);
    if (await hasValidEmbedding(mdPath, metadata)) return { id, created: false };
    const embedding = await this.engine.embed(metadata.text, 'passage');
    const data = { ...metadata, embedding };
    try {
      await writeEmbeddingAtomically(mdPath, data, async () => {
        try {
          return await fs.readFile(mdPath, 'utf8') === text;
        } catch {
          return false;
        }
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'markdown changed before sidecar rename') return { id, created: false };
      throw error;
    }
    return { id, created: true };
  }
}
