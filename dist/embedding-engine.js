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
exports.EmbeddingEngine = void 0;
const paths_1 = require("./paths");
const MODEL = 'Xenova/multilingual-e5-small';
class EmbeddingEngine {
    extractor = null;
    loading = null;
    async embed(text, kind) {
        const extractor = await this.getExtractor();
        const output = await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
        return Array.from(output.data);
    }
    async getExtractor() {
        if (this.extractor)
            return this.extractor;
        if (!this.loading) {
            this.loading = (async () => {
                try {
                    const { pipeline, env } = await Promise.resolve().then(() => __importStar(require('@huggingface/transformers')));
                    env.cacheDir = (0, paths_1.resolveModelCachePath)();
                    this.extractor = await pipeline('feature-extraction', MODEL);
                    return this.extractor;
                }
                catch (error) {
                    this.loading = null;
                    throw error;
                }
            })();
        }
        return this.loading;
    }
}
exports.EmbeddingEngine = EmbeddingEngine;
