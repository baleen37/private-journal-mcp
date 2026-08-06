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
exports.JournalManager = void 0;
exports.renderFrontmatter = renderFrontmatter;
exports.renderEntry = renderEntry;
exports.parseFrontmatter = parseFrontmatter;
exports.parseSections = parseSections;
exports.buildEntryRelPath = buildEntryRelPath;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const yaml_1 = __importDefault(require("yaml"));
const types_1 = require("./types");
function pad(n, len = 2) {
    return String(n).padStart(len, '0');
}
function renderFrontmatter(title, createdAt) {
    return [
        '---',
        yaml_1.default.stringify({ title, created_at: createdAt }).trimEnd(),
        '---',
        '',
    ].join('\n');
}
function renderEntry(sections, title, when) {
    const lines = [renderFrontmatter(title, when.toISOString()).trimEnd(), ''];
    for (const section of types_1.JOURNAL_SECTIONS) {
        const val = sections[section];
        if (val && val.trim().length > 0) {
            lines.push(`## ${types_1.SECTION_TITLES[section]}`, '', val.trim(), '');
        }
    }
    return lines.join('\n');
}
function parseFrontmatter(md) {
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m)
        return { title: '', created_at: '', timestamp: 0 };
    let parsed;
    try {
        parsed = yaml_1.default.parse(m[1]);
    }
    catch {
        return { title: '', created_at: '', timestamp: 0 };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { title: '', created_at: '', timestamp: 0 };
    }
    const values = parsed;
    const title = typeof values.title === 'string' ? values.title : '';
    const candidates = [values.created_at, values.date];
    let createdAt = '';
    for (const candidate of candidates) {
        if (typeof candidate !== 'string')
            continue;
        const timestamp = Date.parse(candidate);
        if (Number.isFinite(timestamp)) {
            createdAt = new Date(timestamp).toISOString();
            break;
        }
    }
    if (!createdAt && typeof values.timestamp === 'number' && Number.isFinite(values.timestamp)) {
        const date = new Date(values.timestamp);
        if (!Number.isNaN(date.getTime()))
            createdAt = date.toISOString();
    }
    return {
        title,
        created_at: createdAt,
        timestamp: createdAt ? Date.parse(createdAt) : 0,
    };
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
    constructor(dataPath, _embeddings) {
        this.dataPath = dataPath;
    }
    hasContent(sections) {
        return types_1.JOURNAL_SECTIONS.some((section) => {
            const v = sections[section];
            return !!v && v.trim().length > 0;
        });
    }
    async write(sections, title, when = new Date()) {
        const rel = buildEntryRelPath(when);
        const mdPath = path.join(this.dataPath, rel);
        await fs.mkdir(path.dirname(mdPath), { recursive: true });
        const md = renderEntry(sections, title, when);
        await fs.writeFile(mdPath, md, 'utf8');
        return mdPath;
    }
}
exports.JournalManager = JournalManager;
