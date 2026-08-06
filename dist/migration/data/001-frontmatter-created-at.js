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
exports.frontmatterCreatedAtMigration = void 0;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const yaml_1 = __importDefault(require("yaml"));
const migrations_1 = require("../../migrations");
const journal_1 = require("../../journal");
function parseDocument(md, relativePath) {
    const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match)
        throw new migrations_1.DataVersionError(`Cannot convert ${relativePath}: missing YAML front matter`);
    let parsed;
    try {
        parsed = yaml_1.default.parse(match[1]);
    }
    catch (error) {
        throw new migrations_1.DataVersionError(`Cannot convert ${relativePath}: invalid YAML (${String(error)})`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new migrations_1.DataVersionError(`Cannot convert ${relativePath}: front matter must be a YAML mapping`);
    }
    return { values: parsed, body: md.slice(match[0].length) };
}
function normalizeCreatedAt(values, relativePath) {
    for (const value of [values.created_at, values.date]) {
        if (typeof value !== 'string')
            continue;
        const timestamp = Date.parse(value);
        if (Number.isFinite(timestamp))
            return new Date(timestamp).toISOString();
    }
    const timestamp = typeof values.timestamp === 'number'
        ? values.timestamp
        : typeof values.timestamp === 'string' && /^\d+$/.test(values.timestamp)
            ? Number(values.timestamp)
            : Number.NaN;
    if (Number.isFinite(timestamp)) {
        const date = new Date(timestamp);
        if (!Number.isNaN(date.getTime()))
            return date.toISOString();
    }
    throw new migrations_1.DataVersionError(`Cannot convert ${relativePath}: no valid created_at/date/timestamp`);
}
async function listMarkdownFiles(directory, relativeDirectory = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const relativePath = path.join(relativeDirectory, entry.name);
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listMarkdownFiles(entryPath, relativePath));
        }
        else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(relativePath);
        }
    }
    return files;
}
exports.frontmatterCreatedAtMigration = {
    from: 1,
    to: 2,
    async apply(stagePath) {
        const invalidatedMarkdownPaths = [];
        for (const relativePath of await listMarkdownFiles(stagePath)) {
            const markdownPath = path.join(stagePath, relativePath);
            const markdown = await fs.readFile(markdownPath, 'utf8');
            const { values, body } = parseDocument(markdown, relativePath);
            if (typeof values.title !== 'string' || values.title.trim().length === 0) {
                throw new migrations_1.DataVersionError(`Cannot convert ${relativePath}: title is required`);
            }
            const createdAt = normalizeCreatedAt(values, relativePath);
            await fs.writeFile(markdownPath, (0, journal_1.renderFrontmatter)(values.title, createdAt) + body, 'utf8');
            invalidatedMarkdownPaths.push(relativePath);
        }
        return { invalidatedMarkdownPaths };
    },
};
