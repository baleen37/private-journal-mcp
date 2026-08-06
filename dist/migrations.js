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
exports.MigrationManager = exports.DataVersionError = exports.MIGRATION_TRANSACTION_FILENAME = exports.DATA_VERSION_FILENAME = exports.CURRENT_DATA_VERSION = void 0;
exports.validateRevisionMigrations = validateRevisionMigrations;
exports.runRevisionMigrations = runRevisionMigrations;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const _001_frontmatter_created_at_1 = require("./migration/data/001-frontmatter-created-at");
exports.CURRENT_DATA_VERSION = 2;
exports.DATA_VERSION_FILENAME = '.private-journal-version.json';
exports.MIGRATION_TRANSACTION_FILENAME = '.private-journal-migration-transaction.json';
const SYNC_LOCK_FILENAME = '.private-journal-sync.lock';
const DATA_MIGRATIONS = [_001_frontmatter_created_at_1.frontmatterCreatedAtMigration];
class DataVersionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DataVersionError';
    }
}
exports.DataVersionError = DataVersionError;
function validateRevisionMigrations(migrations, minimumFrom = 0) {
    const seen = new Set();
    for (const migration of migrations) {
        if (!Number.isInteger(migration.from)
            || !Number.isInteger(migration.to)
            || migration.from < minimumFrom
            || migration.to !== migration.from + 1
            || seen.has(migration.from)) {
            throw new DataVersionError('Revision migrations must be unique consecutive transitions');
        }
        seen.add(migration.from);
    }
}
async function runRevisionMigrations(currentRevision, targetRevision, migrations, context) {
    validateRevisionMigrations(migrations);
    if (currentRevision > targetRevision) {
        throw new DataVersionError(`Revision ${currentRevision} is newer than this app supports (${targetRevision})`);
    }
    let revision = currentRevision;
    while (revision < targetRevision) {
        const migration = migrations.find((candidate) => candidate.from === revision);
        if (!migration || migration.to !== revision + 1) {
            throw new DataVersionError(`Missing consecutive migration for ${revision} -> ${revision + 1}`);
        }
        await migration.apply(context);
        revision = migration.to;
    }
    return revision;
}
class MigrationManager {
    dataPath;
    migrations;
    currentVersion;
    constructor(dataPath, migrations = DATA_MIGRATIONS, currentVersion = exports.CURRENT_DATA_VERSION) {
        this.dataPath = dataPath;
        this.migrations = migrations;
        this.currentVersion = currentVersion;
    }
    async readVersion() {
        const versionPath = path.join(this.dataRootPath(), exports.DATA_VERSION_FILENAME);
        let raw;
        try {
            raw = await fs.readFile(versionPath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return 1;
            throw error;
        }
        let metadata;
        try {
            metadata = JSON.parse(raw);
        }
        catch {
            throw new DataVersionError(`Invalid data version metadata at ${versionPath}`);
        }
        if (typeof metadata !== 'object'
            || metadata === null
            || Array.isArray(metadata)
            || !Object.prototype.hasOwnProperty.call(metadata, 'version')
            || !Number.isInteger(metadata.version)
            || metadata.version <= 0) {
            throw new DataVersionError(`Invalid data version metadata at ${versionPath}`);
        }
        return metadata.version;
    }
    async run() {
        await this.recoverInterruptedActivation();
        await fs.mkdir(this.dataRootPath(), { recursive: true });
        if (!Number.isInteger(this.currentVersion) || this.currentVersion <= 0) {
            throw new DataVersionError('Current data version must be a positive integer');
        }
        validateRevisionMigrations(this.migrations, 1);
        const hasVersionFile = await this.hasVersionFile();
        const version = await this.readVersion();
        if (version > this.currentVersion) {
            throw new DataVersionError(`Data version ${version} is newer than this app supports (${this.currentVersion}); update the app`);
        }
        if (version === this.currentVersion) {
            if (!hasVersionFile)
                await this.writeVersion(this.dataRootPath(), version);
            return false;
        }
        const stagePath = await this.createStage();
        try {
            const invalidatedMarkdownPaths = new Set();
            let invalidateAllEmbeddings = false;
            const revisionMigrations = this.migrations.map((migration) => ({
                from: migration.from,
                to: migration.to,
                apply: async ({ stagePath: migrationStagePath }) => {
                    const result = await migration.apply(migrationStagePath);
                    const paths = this.validateMigrationResult(result, migrationStagePath);
                    paths.forEach((markdownPath) => invalidatedMarkdownPaths.add(markdownPath));
                    invalidateAllEmbeddings ||= result.invalidateAllEmbeddings === true;
                },
            }));
            await runRevisionMigrations(version, this.currentVersion, revisionMigrations, { stagePath });
            for (const markdownPath of invalidatedMarkdownPaths) {
                await fs.rm(path.join(stagePath, markdownPath.replace(/\.md$/, '.embedding')), { force: true });
            }
            if (invalidateAllEmbeddings)
                await this.removeAllEmbeddings(stagePath);
            await this.writeVersion(stagePath, this.currentVersion);
        }
        catch (error) {
            await fs.rm(stagePath, { recursive: true, force: true });
            throw error;
        }
        await this.activateStage(stagePath);
        return true;
    }
    dataRootPath() {
        return path.resolve(this.dataPath);
    }
    transactionPath() {
        return path.join(path.dirname(this.dataRootPath()), exports.MIGRATION_TRANSACTION_FILENAME);
    }
    async createStage() {
        const dataPath = this.dataRootPath();
        const stagePath = await fs.mkdtemp(path.join(path.dirname(dataPath), '.private-journal-migrate-'));
        try {
            await fs.cp(dataPath, stagePath, {
                recursive: true,
                force: true,
                filter: (source) => !this.isPreservedRootEntry(dataPath, source),
            });
            return stagePath;
        }
        catch (error) {
            await fs.rm(stagePath, { recursive: true, force: true });
            throw error;
        }
    }
    isPreservedRootEntry(rootPath, entryPath) {
        return path.dirname(entryPath) === rootPath
            && (path.basename(entryPath) === '.git' || path.basename(entryPath) === SYNC_LOCK_FILENAME);
    }
    validateMigrationResult(result, stagePath) {
        if (!result || !Array.isArray(result.invalidatedMarkdownPaths)) {
            throw new DataVersionError('Migration result must provide invalidated markdown paths');
        }
        if (result.invalidateAllEmbeddings !== undefined && typeof result.invalidateAllEmbeddings !== 'boolean') {
            throw new DataVersionError('Migration result has an invalid embedding invalidation flag');
        }
        return result.invalidatedMarkdownPaths.map((markdownPath) => {
            if (typeof markdownPath !== 'string'
                || path.isAbsolute(markdownPath)
                || path.win32.isAbsolute(markdownPath)
                || !markdownPath.endsWith('.md')
                || markdownPath.split(/[\\/]/).some((segment) => segment === '..')) {
                throw new DataVersionError(`Invalid migration markdown path: ${String(markdownPath)}`);
            }
            const targetPath = path.resolve(stagePath, markdownPath);
            if (!this.isWithinDirectory(stagePath, targetPath)) {
                throw new DataVersionError(`Invalid migration markdown path: ${markdownPath}`);
            }
            return markdownPath;
        });
    }
    async removeAllEmbeddings(directory) {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await this.removeAllEmbeddings(entryPath);
            }
            else if (entry.name.endsWith('.embedding')) {
                await fs.rm(entryPath, { force: true });
            }
        }
    }
    async hasVersionFile() {
        try {
            await fs.access(path.join(this.dataRootPath(), exports.DATA_VERSION_FILENAME));
            return true;
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return false;
            throw error;
        }
    }
    async activateStage(stagePath) {
        const dataPath = this.dataRootPath();
        const backupPath = await fs.mkdtemp(path.join(path.dirname(dataPath), '.private-journal-backup-'));
        const transaction = {
            state: 'prepared',
            dataPath,
            stagePath,
            backupPath,
        };
        let transactionWritten = false;
        try {
            await this.writeTransaction(transaction);
            transactionWritten = true;
            await this.moveEntries(dataPath, backupPath, true);
            transaction.state = 'backed-up';
            await this.writeTransaction(transaction);
            await this.moveEntries(stagePath, dataPath, false);
            transaction.state = 'activated';
            await this.writeTransaction(transaction);
            await this.cleanupTransaction(transaction);
        }
        catch (error) {
            if (transactionWritten) {
                try {
                    await this.recoverInterruptedActivation();
                }
                catch (recoveryError) {
                    throw new DataVersionError(`Migration activation failed and original data could not be restored; preserve ${backupPath} and ${stagePath}: ${String(recoveryError)}`);
                }
            }
            else {
                await fs.rm(stagePath, { recursive: true, force: true });
                await fs.rm(backupPath, { recursive: true, force: true });
            }
            throw error;
        }
    }
    async moveEntries(sourcePath, targetPath, excludePreservedEntries) {
        const entries = await fs.readdir(sourcePath);
        for (const entry of entries) {
            const entryPath = path.join(sourcePath, entry);
            if (excludePreservedEntries && this.isPreservedRootEntry(sourcePath, entryPath))
                continue;
            await fs.rename(entryPath, path.join(targetPath, entry));
        }
    }
    async recoverInterruptedActivation() {
        const transactionPath = this.transactionPath();
        let raw;
        try {
            raw = await fs.readFile(transactionPath, 'utf8');
        }
        catch (error) {
            if (error.code === 'ENOENT')
                return;
            throw error;
        }
        const transaction = this.parseTransaction(raw, transactionPath);
        if (transaction.state === 'prepared') {
            await this.restoreBackup(transaction, false);
        }
        else if (transaction.state === 'backed-up') {
            await this.restoreBackup(transaction, true);
        }
        await this.cleanupTransaction(transaction);
    }
    parseTransaction(raw, transactionPath) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new DataVersionError(`Invalid migration transaction metadata at ${transactionPath}`);
        }
        if (typeof parsed !== 'object'
            || parsed === null
            || Array.isArray(parsed)
            || !['prepared', 'backed-up', 'activated'].includes(parsed.state)
            || typeof parsed.dataPath !== 'string'
            || typeof parsed.stagePath !== 'string'
            || typeof parsed.backupPath !== 'string') {
            throw new DataVersionError(`Invalid migration transaction metadata at ${transactionPath}`);
        }
        const transaction = parsed;
        const dataPath = this.dataRootPath();
        const parentPath = path.dirname(dataPath);
        if (path.resolve(transaction.dataPath) !== dataPath
            || !this.isDirectChildOf(parentPath, transaction.stagePath)
            || !this.isDirectChildOf(parentPath, transaction.backupPath)) {
            throw new DataVersionError(`Migration transaction paths must stay inside ${parentPath}`);
        }
        return {
            ...transaction,
            dataPath,
            stagePath: path.resolve(transaction.stagePath),
            backupPath: path.resolve(transaction.backupPath),
        };
    }
    isDirectChildOf(parentPath, childPath) {
        return path.dirname(path.resolve(childPath)) === parentPath;
    }
    isWithinDirectory(directory, candidate) {
        const relative = path.relative(path.resolve(directory), path.resolve(candidate));
        return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
    }
    async restoreBackup(transaction, clearDataFirst) {
        if (clearDataFirst)
            await this.removeMigratableEntries(transaction.dataPath);
        await fs.mkdir(transaction.dataPath, { recursive: true });
        await this.moveEntries(transaction.backupPath, transaction.dataPath, false);
    }
    async removeMigratableEntries(dataPath) {
        const entries = await fs.readdir(dataPath);
        for (const entry of entries) {
            const entryPath = path.join(dataPath, entry);
            if (this.isPreservedRootEntry(dataPath, entryPath))
                continue;
            await fs.rm(entryPath, { recursive: true, force: true });
        }
    }
    async writeTransaction(transaction) {
        await fs.writeFile(this.transactionPath(), JSON.stringify(transaction), 'utf8');
    }
    async cleanupTransaction(transaction) {
        await fs.rm(transaction.backupPath, { recursive: true, force: true });
        await fs.rm(transaction.stagePath, { recursive: true, force: true });
        await fs.rm(this.transactionPath(), { force: true });
    }
    async writeVersion(targetPath, version) {
        await fs.mkdir(targetPath, { recursive: true });
        await fs.writeFile(path.join(targetPath, exports.DATA_VERSION_FILENAME), `{"version":${version}}\n`, 'utf8');
    }
}
exports.MigrationManager = MigrationManager;
