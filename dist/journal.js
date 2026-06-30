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
exports.JournalManager = void 0;
exports.renderEntry = renderEntry;
exports.parseFrontmatter = parseFrontmatter;
exports.parseSections = parseSections;
exports.buildEntryRelPath = buildEntryRelPath;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const types_1 = require("./types");
function pad(n, len = 2) {
    return String(n).padStart(len, '0');
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
function renderEntry(sections, when) {
    const hh = pad(when.getHours());
    const mm = pad(when.getMinutes());
    const ss = pad(when.getSeconds());
    const title = `${hh}:${mm}:${ss} - ${MONTHS[when.getMonth()]} ${when.getDate()}, ${when.getFullYear()}`;
    const lines = [
        '---',
        `title: "${title}"`,
        `date: ${when.toISOString()}`,
        `timestamp: ${when.getTime()}`,
        '---',
        '',
    ];
    for (const section of types_1.JOURNAL_SECTIONS) {
        const val = sections[section];
        if (val && val.trim().length > 0) {
            lines.push(`## ${types_1.SECTION_TITLES[section]}`, '', val.trim(), '');
        }
    }
    return lines.join('\n');
}
function parseFrontmatter(md) {
    const m = md.match(/^---\n([\s\S]*?)\n---/);
    const body = m ? m[1] : '';
    const title = (body.match(/title:\s*"(.*?)"\s*$/m) || [])[1] || '';
    const date = (body.match(/date:\s*(.*?)\s*$/m) || [])[1] || '';
    const ts = parseInt((body.match(/timestamp:\s*(\d+)/) || [])[1] || '0', 10);
    return { title, date, timestamp: ts };
}
function parseSections(md) {
    const present = [];
    for (const section of types_1.JOURNAL_SECTIONS) {
        if (md.includes(`## ${types_1.SECTION_TITLES[section]}`))
            present.push(section);
    }
    return present;
}
function buildEntryRelPath(when) {
    const y = when.getFullYear();
    const mo = pad(when.getMonth() + 1);
    const d = pad(when.getDate());
    const hh = pad(when.getHours());
    const mm = pad(when.getMinutes());
    const ss = pad(when.getSeconds());
    const micro = pad(when.getMilliseconds() * 1000 + Math.floor(Math.random() * 1000), 6);
    return `${y}-${mo}-${d}/${hh}-${mm}-${ss}-${micro}.md`;
}
class JournalManager {
    dataPath;
    embeddings;
    constructor(dataPath, embeddings) {
        this.dataPath = dataPath;
        this.embeddings = embeddings;
    }
    hasContent(sections) {
        return types_1.JOURNAL_SECTIONS.some((section) => {
            const v = sections[section];
            return !!v && v.trim().length > 0;
        });
    }
    async write(sections, when = new Date()) {
        const rel = buildEntryRelPath(when);
        const mdPath = path.join(this.dataPath, rel);
        await fs.mkdir(path.dirname(mdPath), { recursive: true });
        const md = renderEntry(sections, when);
        await fs.writeFile(mdPath, md, 'utf8');
        try {
            const presentSections = parseSections(md);
            const text = this.embeddings.extractSearchableText(md);
            const vector = await this.embeddings.generateEmbedding(text, 'passage');
            const data = {
                embedding: vector,
                text,
                sections: presentSections,
                timestamp: when.getTime(),
                path: mdPath,
            };
            await this.embeddings.saveEmbedding(mdPath, data);
        }
        catch (err) {
            console.error('[private-journal] embedding generation failed:', err);
        }
        return mdPath;
    }
}
exports.JournalManager = JournalManager;
