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
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveDataPath = resolveDataPath;
exports.resolveModelCachePath = resolveModelCachePath;
const path = __importStar(require("path"));
const os = __importStar(require("os"));
function homeDir(env) {
    return env.HOME || env.USERPROFILE || os.homedir();
}
function resolveDataPath(env = process.env) {
    if (env.PRIVATE_JOURNAL_PATH)
        return env.PRIVATE_JOURNAL_PATH;
    if (env.XDG_DATA_HOME)
        return path.join(env.XDG_DATA_HOME, 'private-journal');
    return path.join(homeDir(env), '.local', 'share', 'private-journal');
}
function resolveModelCachePath(env = process.env) {
    if (env.XDG_CACHE_HOME)
        return path.join(env.XDG_CACHE_HOME, 'private-journal', 'models');
    return path.join(homeDir(env), '.cache', 'private-journal', 'models');
}
