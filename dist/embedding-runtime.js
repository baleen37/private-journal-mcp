"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveEmbeddingRuntimePaths = resolveEmbeddingRuntimePaths;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
function resolveEmbeddingRuntimePaths(env, platform, uid) {
    const directory = platform === 'linux' && env.XDG_RUNTIME_DIR
        ? path_1.default.join(env.XDG_RUNTIME_DIR, 'private-journal')
        : path_1.default.join((0, os_1.tmpdir)(), `private-journal-${uid}`, 'private-journal');
    (0, fs_1.mkdirSync)(directory, { recursive: true, mode: 0o700 });
    (0, fs_1.chmodSync)(directory, 0o700);
    return {
        directory,
        socketPath: path_1.default.join(directory, 'embedding.sock'),
        startupLockPath: path_1.default.join(directory, 'embedding.startup.lock'),
        pidPath: path_1.default.join(directory, 'embedding.pid'),
    };
}
