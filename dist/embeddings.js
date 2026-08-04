"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmbeddingService = void 0;
exports.extractSearchableText = extractSearchableText;
const embedding_broker_1 = require("./embedding-broker");
function extractSearchableText(md) {
    const withoutFm = md.replace(/^---\n[\s\S]*?\n---\n?/, '');
    return withoutFm.replace(/^##\s+/gm, '').trim();
}
class EmbeddingService {
    broker;
    static instance;
    constructor(broker = new embedding_broker_1.EmbeddingBroker()) {
        this.broker = broker;
    }
    static getInstance() {
        if (!EmbeddingService.instance)
            EmbeddingService.instance = new EmbeddingService();
        return EmbeddingService.instance;
    }
    cosineSimilarity(a, b) {
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if (na === 0 || nb === 0)
            return 0;
        return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }
    extractSearchableText(md) {
        return extractSearchableText(md);
    }
    async generateEmbedding(text, kind) {
        return this.broker.embedText(text, kind);
    }
}
exports.EmbeddingService = EmbeddingService;
