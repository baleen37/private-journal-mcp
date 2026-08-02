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
exports.EmbeddingBroker = void 0;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs/promises"));
const net_1 = __importDefault(require("net"));
const path_1 = __importDefault(require("path"));
const embedding_protocol_1 = require("./embedding-protocol");
const embedding_runtime_1 = require("./embedding-runtime");
function errorCode(error) {
    return error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : undefined;
}
function defaultProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return errorCode(error) === 'EPERM';
    }
}
class EmbeddingBroker {
    runtimePaths;
    spawnWorker;
    isProcessAlive;
    pollIntervalMs;
    startupTimeoutMs;
    pending = new Map();
    socket = null;
    connecting = null;
    nextRequestId = 1;
    closed = false;
    constructor(options = {}) {
        const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
        this.runtimePaths = options.runtimePaths
            ?? (0, embedding_runtime_1.resolveEmbeddingRuntimePaths)(process.env, process.platform, uid);
        this.spawnWorker = options.spawnWorker ?? (() => {
            const workerEntry = path_1.default.join(__dirname, '..', 'dist', 'index.js');
            const child = (0, child_process_1.spawn)(process.execPath, [workerEntry, 'embedding-worker'], {
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
        });
        this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive;
        this.pollIntervalMs = options.pollIntervalMs ?? 25;
        this.startupTimeoutMs = options.startupTimeoutMs ?? 10_000;
    }
    async embedText(text, kind) {
        const response = await this.rpc({ type: 'embedText', text, kind });
        if (!Array.isArray(response.embedding))
            throw new Error('worker returned no embedding');
        return response.embedding;
    }
    async status() {
        const response = await this.rpc({ type: 'status' });
        if (typeof response.active !== 'boolean')
            throw new Error('worker returned no status');
        return response.active;
    }
    async close() {
        this.closed = true;
        const error = new Error('embedding broker closed');
        for (const request of this.pending.values())
            request.reject(error);
        this.pending.clear();
        const socket = this.socket;
        this.socket = null;
        socket?.destroy();
    }
    async rpc(request) {
        const id = String(this.nextRequestId++);
        const framedRequest = { id, ...request };
        try {
            return await this.sendOnce(framedRequest);
        }
        catch (error) {
            if (!this.isRetryable(error))
                throw error;
            return this.sendOnce(framedRequest);
        }
    }
    async sendOnce(request) {
        await this.ensureConnected();
        const socket = this.socket;
        if (!socket)
            throw new Error('embedding worker connection unavailable');
        const id = String(request.id);
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            socket.write((0, embedding_protocol_1.encodeFrame)(request), (error) => {
                if (!error)
                    return;
                this.pending.delete(id);
                reject(error);
                this.failSocket(socket, error);
            });
        });
    }
    async ensureConnected() {
        if (this.closed)
            throw new Error('embedding broker closed');
        if (this.socket && !this.socket.destroyed)
            return;
        if (!this.connecting) {
            this.connecting = this.connectOrStart().finally(() => {
                this.connecting = null;
            });
        }
        await this.connecting;
    }
    async connectOrStart() {
        try {
            await this.openSocket();
            return;
        }
        catch (error) {
            if (!this.isUnavailable(error))
                throw error;
        }
        const deadline = Date.now() + this.startupTimeoutMs;
        while (Date.now() < deadline) {
            const lock = await this.tryAcquireLock();
            if (lock) {
                try {
                    if (await this.tryOpenSocket())
                        return;
                    await this.unlinkIfExists(this.runtimePaths.socketPath);
                    await this.spawnWorker();
                    await this.waitForSocket(deadline);
                    return;
                }
                finally {
                    await this.releaseLock(lock);
                }
            }
            if (await this.tryOpenSocket())
                return;
            const owner = await this.readStartupLock();
            if ((!owner || !this.isProcessAlive(owner.pid)) && !await this.socketIsHealthy()) {
                await this.reclaimStaleLock();
                continue;
            }
            await this.delay();
        }
        throw new Error('timed out waiting for embedding worker');
    }
    async tryAcquireLock() {
        try {
            await fs.mkdir(this.runtimePaths.startupLockPath, { mode: 0o700 });
        }
        catch (error) {
            if (errorCode(error) === 'EEXIST')
                return null;
            throw error;
        }
        const owner = {
            pid: process.pid,
            acquiredAt: Date.now(),
            nonce: crypto.randomUUID(),
        };
        try {
            await fs.writeFile(path_1.default.join(this.runtimePaths.startupLockPath, 'owner.json'), JSON.stringify(owner), {
                encoding: 'utf8', mode: 0o600,
            });
            return { owner };
        }
        catch (error) {
            await fs.rm(this.runtimePaths.startupLockPath, { recursive: true, force: true });
            throw error;
        }
    }
    async releaseLock(lock) {
        const owner = await this.readStartupLock();
        if (owner?.nonce === lock.owner.nonce) {
            await fs.rm(this.runtimePaths.startupLockPath, { recursive: true, force: true });
        }
    }
    async readStartupLock() {
        try {
            const value = JSON.parse(await fs.readFile(path_1.default.join(this.runtimePaths.startupLockPath, 'owner.json'), 'utf8'));
            return typeof value.pid === 'number' && typeof value.acquiredAt === 'number' && typeof value.nonce === 'string'
                ? { pid: value.pid, acquiredAt: value.acquiredAt, nonce: value.nonce }
                : null;
        }
        catch {
            return null;
        }
    }
    async reclaimStaleLock() {
        const guardPath = `${this.runtimePaths.startupLockPath}.reclaim`;
        try {
            await fs.mkdir(guardPath, { mode: 0o700 });
        }
        catch (error) {
            if (errorCode(error) === 'EEXIST')
                return;
            throw error;
        }
        try {
            if (await this.socketIsHealthy())
                return;
            const owner = await this.readStartupLock();
            if (owner && this.isProcessAlive(owner.pid))
                return;
            const claimedPath = `${guardPath}/claimed`;
            try {
                await fs.rename(this.runtimePaths.startupLockPath, claimedPath);
            }
            catch (error) {
                if (errorCode(error) === 'ENOENT')
                    return;
                throw error;
            }
            await fs.rm(claimedPath, { recursive: true, force: true });
        }
        finally {
            await fs.rm(guardPath, { recursive: true, force: true });
        }
    }
    async waitForSocket(deadline) {
        while (Date.now() < deadline) {
            if (await this.tryOpenSocket())
                return;
            await this.delay();
        }
        throw new Error('timed out waiting for embedding worker socket');
    }
    async socketIsHealthy() {
        if (this.socket && !this.socket.destroyed)
            return true;
        return this.tryOpenSocket();
    }
    async tryOpenSocket() {
        try {
            await this.openSocket();
            return true;
        }
        catch (error) {
            if (this.isUnavailable(error))
                return false;
            throw error;
        }
    }
    openSocket() {
        if (this.socket && !this.socket.destroyed)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const socket = net_1.default.createConnection(this.runtimePaths.socketPath);
            const onError = (error) => {
                socket.removeListener('connect', onConnect);
                socket.destroy();
                reject(error);
            };
            const onConnect = () => {
                socket.removeListener('error', onError);
                this.attachSocket(socket);
                resolve();
            };
            socket.once('error', onError);
            socket.once('connect', onConnect);
        });
    }
    attachSocket(socket) {
        const decoder = new embedding_protocol_1.FrameDecoder();
        this.socket = socket;
        socket.on('data', (chunk) => {
            let frames;
            try {
                frames = decoder.push(chunk);
            }
            catch (error) {
                this.failSocket(socket, error instanceof Error ? error : new Error(String(error)));
                return;
            }
            for (const frame of frames)
                this.handleResponse(frame);
        });
        socket.on('error', (error) => this.failSocket(socket, error));
        socket.on('close', () => {
            const error = Object.assign(new Error('embedding worker connection reset'), { code: 'ECONNRESET' });
            this.failSocket(socket, error);
        });
    }
    handleResponse(value) {
        if (!value || typeof value !== 'object')
            return;
        const response = value;
        if (typeof response.id !== 'string')
            return;
        const request = this.pending.get(response.id);
        if (!request)
            return;
        this.pending.delete(response.id);
        if (typeof response.error === 'string')
            request.reject(new Error(response.error));
        else
            request.resolve(response);
    }
    failSocket(socket, error) {
        if (this.socket !== socket)
            return;
        this.socket = null;
        socket.destroy();
        for (const request of this.pending.values())
            request.reject(error);
        this.pending.clear();
    }
    isUnavailable(error) {
        const code = errorCode(error);
        return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK';
    }
    isRetryable(error) {
        const code = errorCode(error);
        return code === 'ECONNRESET' || code === 'ECONNREFUSED';
    }
    async unlinkIfExists(targetPath) {
        try {
            await fs.unlink(targetPath);
        }
        catch (error) {
            if (errorCode(error) !== 'ENOENT')
                throw error;
        }
    }
    delay() {
        return new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
}
exports.EmbeddingBroker = EmbeddingBroker;
