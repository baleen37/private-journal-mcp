"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingWorker = void 0;
const fs = __importStar(require("fs/promises"));
const net_1 = __importDefault(require("net"));
const embedding_engine_1 = require("./embedding-engine");
const embedding_protocol_1 = require("./embedding-protocol");
class EmbeddingWorker {
    engine;
    runtimePaths;
    queue = [];
    server = null;
    active = false;
    draining = false;
    constructor({ engine = new embedding_engine_1.EmbeddingEngine(), runtimePaths }) {
        this.engine = engine;
        this.runtimePaths = runtimePaths;
    }
    async listen() {
        if (this.server)
            return;
        const server = net_1.default.createServer((socket) => this.accept(socket));
        await new Promise((resolve, reject) => {
            const onError = (error) => {
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
    async close() {
        const server = this.server;
        this.server = null;
        if (server)
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    async handle(request) {
        if (request.type === 'status')
            return { id: request.id, active: this.active };
        const embedding = await this.enqueue(() => this.engine.embed(request.text, request.kind));
        return { id: request.id, embedding };
    }
    accept(socket) {
        const decoder = new embedding_protocol_1.FrameDecoder();
        socket.on('error', () => { });
        socket.on('data', (chunk) => {
            let requests;
            try {
                requests = decoder.push(chunk);
            }
            catch {
                socket.destroy();
                return;
            }
            for (const value of requests)
                void this.reply(socket, value);
        });
    }
    async reply(socket, value) {
        const request = this.parseRequest(value);
        if (!request) {
            socket.write((0, embedding_protocol_1.encodeFrame)({ error: 'invalid worker request' }));
            return;
        }
        try {
            socket.write((0, embedding_protocol_1.encodeFrame)(await this.handle(request)));
        }
        catch (error) {
            socket.write((0, embedding_protocol_1.encodeFrame)({ id: request.id, error: error instanceof Error ? error.message : String(error) }));
        }
    }
    parseRequest(value) {
        if (!value || typeof value !== 'object')
            return null;
        const request = value;
        if (typeof request.id !== 'string' || typeof request.type !== 'string')
            return null;
        if (request.type === 'status')
            return { id: request.id, type: 'status' };
        if (request.type === 'embedText'
            && typeof request.text === 'string'
            && (request.kind === 'passage' || request.kind === 'query')) {
            return { id: request.id, type: 'embedText', text: request.text, kind: request.kind };
        }
        return null;
    }
    enqueue(run) {
        return new Promise((resolve, reject) => {
            this.queue.push({ run, resolve: resolve, reject });
            void this.drain();
        });
    }
    async drain() {
        if (this.draining)
            return;
        this.draining = true;
        try {
            while (true) {
                const job = this.queue.shift();
                if (!job)
                    return;
                this.active = true;
                try {
                    job.resolve(await job.run());
                }
                catch (error) {
                    job.reject(error);
                }
                finally {
                    this.active = false;
                }
            }
        }
        finally {
            this.draining = false;
            if (this.queue.length)
                void this.drain();
        }
    }
}
exports.EmbeddingWorker = EmbeddingWorker;
