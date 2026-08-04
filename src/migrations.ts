import * as fs from 'fs/promises';
import * as path from 'path';

export const CURRENT_DATA_VERSION = 1;
export const DATA_VERSION_FILENAME = '.private-journal-version.json';
export const MIGRATION_TRANSACTION_FILENAME = '.private-journal-migration-transaction.json';

const SYNC_LOCK_FILENAME = '.private-journal-sync.lock';

type MigrationTransaction = {
  state: 'prepared' | 'backed-up' | 'activated';
  dataPath: string;
  stagePath: string;
  backupPath: string;
};

export class DataVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataVersionError';
  }
}

export interface MigrationResult {
  invalidatedMarkdownPaths: string[];
  invalidateAllEmbeddings?: boolean;
}

export interface Migration {
  from: number;
  to: number;
  apply(stagePath: string): Promise<MigrationResult>;
}

/**
 * 공통 revision 실행 계약이다. 실제 atomic commit은 대상 저장소가 담당한다.
 * 폴더 migration은 stage 디렉터리, SQLite migration은 임시 DB를 사용한다.
 */
export interface RevisionMigration<TContext, TResult = void> {
  from: number;
  to: number;
  apply(context: TContext): Promise<TResult>;
}

export function validateRevisionMigrations<TContext, TResult>(
  migrations: RevisionMigration<TContext, TResult>[],
  minimumFrom = 0,
): void {
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (
      !Number.isInteger(migration.from)
      || !Number.isInteger(migration.to)
      || migration.from < minimumFrom
      || migration.to !== migration.from + 1
      || seen.has(migration.from)
    ) {
      throw new DataVersionError('Revision migrations must be unique consecutive transitions');
    }
    seen.add(migration.from);
  }
}

export async function runRevisionMigrations<TContext>(
  currentRevision: number,
  targetRevision: number,
  migrations: RevisionMigration<TContext, unknown>[],
  context: TContext,
): Promise<number> {
  validateRevisionMigrations(migrations);
  if (currentRevision > targetRevision) {
    throw new DataVersionError(
      `Revision ${currentRevision} is newer than this app supports (${targetRevision})`,
    );
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

export class MigrationManager {
  constructor(
    private readonly dataPath: string,
    private readonly migrations: Migration[] = [],
    private readonly currentVersion: number = CURRENT_DATA_VERSION,
  ) {}

  async readVersion(): Promise<number> {
    const versionPath = path.join(this.dataRootPath(), DATA_VERSION_FILENAME);
    let raw: string;

    try {
      raw = await fs.readFile(versionPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 1;
      throw error;
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(raw);
    } catch {
      throw new DataVersionError(`Invalid data version metadata at ${versionPath}`);
    }

    if (
      typeof metadata !== 'object'
      || metadata === null
      || Array.isArray(metadata)
      || !Object.prototype.hasOwnProperty.call(metadata, 'version')
      || !Number.isInteger((metadata as { version?: unknown }).version)
      || (metadata as { version: number }).version <= 0
    ) {
      throw new DataVersionError(`Invalid data version metadata at ${versionPath}`);
    }

    return (metadata as { version: number }).version;
  }

  async run(): Promise<void> {
    await this.recoverInterruptedActivation();

    if (!Number.isInteger(this.currentVersion) || this.currentVersion <= 0) {
      throw new DataVersionError('Current data version must be a positive integer');
    }
    validateRevisionMigrations(this.migrations, 1);

    const hasVersionFile = await this.hasVersionFile();
    const version = await this.readVersion();
    if (version > this.currentVersion) {
      throw new DataVersionError(
        `Data version ${version} is newer than this app supports (${this.currentVersion}); update the app`,
      );
    }

    if (version === this.currentVersion) {
      if (!hasVersionFile) await this.writeVersion(this.dataRootPath(), version);
      return;
    }

    const stagePath = await this.createStage();
    try {
      const invalidatedMarkdownPaths = new Set<string>();
      let invalidateAllEmbeddings = false;
      const revisionMigrations: RevisionMigration<{ stagePath: string }>[] = this.migrations.map((migration) => ({
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
      if (invalidateAllEmbeddings) await this.removeAllEmbeddings(stagePath);
      await this.writeVersion(stagePath, this.currentVersion);
    } catch (error) {
      await fs.rm(stagePath, { recursive: true, force: true });
      throw error;
    }

    await this.activateStage(stagePath);
  }

  private dataRootPath(): string {
    return path.resolve(this.dataPath);
  }

  private transactionPath(): string {
    return path.join(path.dirname(this.dataRootPath()), MIGRATION_TRANSACTION_FILENAME);
  }

  private async createStage(): Promise<string> {
    const dataPath = this.dataRootPath();
    const stagePath = await fs.mkdtemp(path.join(path.dirname(dataPath), '.private-journal-migrate-'));
    try {
      await fs.cp(dataPath, stagePath, {
        recursive: true,
        force: true,
        filter: (source) => !this.isPreservedRootEntry(dataPath, source),
      });
      return stagePath;
    } catch (error) {
      await fs.rm(stagePath, { recursive: true, force: true });
      throw error;
    }
  }

  private isPreservedRootEntry(rootPath: string, entryPath: string): boolean {
    return path.dirname(entryPath) === rootPath
      && (path.basename(entryPath) === '.git' || path.basename(entryPath) === SYNC_LOCK_FILENAME);
  }

  private validateMigrationResult(result: MigrationResult, stagePath: string): string[] {
    if (!result || !Array.isArray(result.invalidatedMarkdownPaths)) {
      throw new DataVersionError('Migration result must provide invalidated markdown paths');
    }
    if (result.invalidateAllEmbeddings !== undefined && typeof result.invalidateAllEmbeddings !== 'boolean') {
      throw new DataVersionError('Migration result has an invalid embedding invalidation flag');
    }

    return result.invalidatedMarkdownPaths.map((markdownPath) => {
      if (
        typeof markdownPath !== 'string'
        || path.isAbsolute(markdownPath)
        || path.win32.isAbsolute(markdownPath)
        || !markdownPath.endsWith('.md')
        || markdownPath.split(/[\\/]/).some((segment) => segment === '..')
      ) {
        throw new DataVersionError(`Invalid migration markdown path: ${String(markdownPath)}`);
      }

      const targetPath = path.resolve(stagePath, markdownPath);
      if (!this.isWithinDirectory(stagePath, targetPath)) {
        throw new DataVersionError(`Invalid migration markdown path: ${markdownPath}`);
      }
      return markdownPath;
    });
  }

  private async removeAllEmbeddings(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.removeAllEmbeddings(entryPath);
      } else if (entry.name.endsWith('.embedding')) {
        await fs.rm(entryPath, { force: true });
      }
    }
  }

  private async hasVersionFile(): Promise<boolean> {
    try {
      await fs.access(path.join(this.dataRootPath(), DATA_VERSION_FILENAME));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async activateStage(stagePath: string): Promise<void> {
    const dataPath = this.dataRootPath();
    const backupPath = await fs.mkdtemp(path.join(path.dirname(dataPath), '.private-journal-backup-'));
    const transaction: MigrationTransaction = {
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
    } catch (error) {
      if (transactionWritten) {
        try {
          await this.recoverInterruptedActivation();
        } catch (recoveryError) {
          throw new DataVersionError(
            `Migration activation failed and original data could not be restored; preserve ${backupPath} and ${stagePath}: ${String(recoveryError)}`,
          );
        }
      } else {
        await fs.rm(stagePath, { recursive: true, force: true });
        await fs.rm(backupPath, { recursive: true, force: true });
      }
      throw error;
    }
  }

  private async moveEntries(sourcePath: string, targetPath: string, excludePreservedEntries: boolean): Promise<void> {
    const entries = await fs.readdir(sourcePath);
    for (const entry of entries) {
      const entryPath = path.join(sourcePath, entry);
      if (excludePreservedEntries && this.isPreservedRootEntry(sourcePath, entryPath)) continue;
      await fs.rename(entryPath, path.join(targetPath, entry));
    }
  }

  private async recoverInterruptedActivation(): Promise<void> {
    const transactionPath = this.transactionPath();
    let raw: string;
    try {
      raw = await fs.readFile(transactionPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    const transaction = this.parseTransaction(raw, transactionPath);
    if (transaction.state === 'prepared') {
      await this.restoreBackup(transaction, false);
    } else if (transaction.state === 'backed-up') {
      await this.restoreBackup(transaction, true);
    }
    await this.cleanupTransaction(transaction);
  }

  private parseTransaction(raw: string, transactionPath: string): MigrationTransaction {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new DataVersionError(`Invalid migration transaction metadata at ${transactionPath}`);
    }

    if (
      typeof parsed !== 'object'
      || parsed === null
      || Array.isArray(parsed)
      || !['prepared', 'backed-up', 'activated'].includes((parsed as { state?: unknown }).state as string)
      || typeof (parsed as { dataPath?: unknown }).dataPath !== 'string'
      || typeof (parsed as { stagePath?: unknown }).stagePath !== 'string'
      || typeof (parsed as { backupPath?: unknown }).backupPath !== 'string'
    ) {
      throw new DataVersionError(`Invalid migration transaction metadata at ${transactionPath}`);
    }

    const transaction = parsed as MigrationTransaction;
    const dataPath = this.dataRootPath();
    const parentPath = path.dirname(dataPath);
    if (
      path.resolve(transaction.dataPath) !== dataPath
      || !this.isDirectChildOf(parentPath, transaction.stagePath)
      || !this.isDirectChildOf(parentPath, transaction.backupPath)
    ) {
      throw new DataVersionError(`Migration transaction paths must stay inside ${parentPath}`);
    }
    return {
      ...transaction,
      dataPath,
      stagePath: path.resolve(transaction.stagePath),
      backupPath: path.resolve(transaction.backupPath),
    };
  }

  private isDirectChildOf(parentPath: string, childPath: string): boolean {
    return path.dirname(path.resolve(childPath)) === parentPath;
  }

  private isWithinDirectory(directory: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(directory), path.resolve(candidate));
    return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
  }

  private async restoreBackup(transaction: MigrationTransaction, clearDataFirst: boolean): Promise<void> {
    if (clearDataFirst) await this.removeMigratableEntries(transaction.dataPath);
    await fs.mkdir(transaction.dataPath, { recursive: true });
    await this.moveEntries(transaction.backupPath, transaction.dataPath, false);
  }

  private async removeMigratableEntries(dataPath: string): Promise<void> {
    const entries = await fs.readdir(dataPath);
    for (const entry of entries) {
      const entryPath = path.join(dataPath, entry);
      if (this.isPreservedRootEntry(dataPath, entryPath)) continue;
      await fs.rm(entryPath, { recursive: true, force: true });
    }
  }

  private async writeTransaction(transaction: MigrationTransaction): Promise<void> {
    await fs.writeFile(this.transactionPath(), JSON.stringify(transaction), 'utf8');
  }

  private async cleanupTransaction(transaction: MigrationTransaction): Promise<void> {
    await fs.rm(transaction.backupPath, { recursive: true, force: true });
    await fs.rm(transaction.stagePath, { recursive: true, force: true });
    await fs.rm(this.transactionPath(), { force: true });
  }

  private async writeVersion(targetPath: string, version: number): Promise<void> {
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, DATA_VERSION_FILENAME), `{"version":${version}}\n`, 'utf8');
  }
}
