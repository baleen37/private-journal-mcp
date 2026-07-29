import * as fs from 'fs/promises';
import * as path from 'path';

export const CURRENT_DATA_VERSION = 1;
export const DATA_VERSION_FILENAME = '.private-journal-version.json';

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

export class MigrationManager {
  constructor(
    private readonly dataPath: string,
    private readonly migrations: Migration[] = [],
    private readonly currentVersion: number = CURRENT_DATA_VERSION,
  ) {}

  async readVersion(): Promise<number> {
    const versionPath = path.join(this.dataPath, DATA_VERSION_FILENAME);
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
    if (!Number.isInteger(this.currentVersion) || this.currentVersion <= 0) {
      throw new DataVersionError('Current data version must be a positive integer');
    }

    const hasVersionFile = await this.hasVersionFile();
    const version = await this.readVersion();
    if (version > this.currentVersion) {
      throw new DataVersionError(
        `Data version ${version} is newer than this app supports (${this.currentVersion}); update the app`,
      );
    }

    if (version === this.currentVersion) {
      if (!hasVersionFile) await this.writeVersion(this.dataPath, version);
      return;
    }

    const sequence = this.migrationSequence(version);
    const stagePath = await this.createStage();
    try {
      for (const migration of sequence) {
        await migration.apply(stagePath);
      }
      await this.writeVersion(stagePath, this.currentVersion);
      await this.activateStage(stagePath);
    } catch (error) {
      await fs.rm(stagePath, { recursive: true, force: true });
      throw error;
    }
  }

  private migrationSequence(version: number): Migration[] {
    const sequence: Migration[] = [];
    let nextVersion = version;

    while (nextVersion < this.currentVersion) {
      const matches = this.migrations.filter((migration) => migration.from === nextVersion);
      if (matches.length !== 1 || matches[0].to !== nextVersion + 1) {
        throw new DataVersionError(`Missing consecutive migration for ${nextVersion} -> ${nextVersion + 1}`);
      }
      sequence.push(matches[0]);
      nextVersion = matches[0].to;
    }

    return sequence;
  }

  private async createStage(): Promise<string> {
    const parentPath = path.dirname(this.dataPath);
    const stagePath = await fs.mkdtemp(path.join(parentPath, `.${path.basename(this.dataPath)}-migration-`));
    try {
      await fs.cp(this.dataPath, stagePath, {
        recursive: true,
        force: true,
        filter: (source) => path.basename(source) !== '.git',
      });
      return stagePath;
    } catch (error) {
      await fs.rm(stagePath, { recursive: true, force: true });
      throw error;
    }
  }

  private async hasVersionFile(): Promise<boolean> {
    try {
      await fs.access(path.join(this.dataPath, DATA_VERSION_FILENAME));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private async activateStage(stagePath: string): Promise<void> {
    const backupPath = await fs.mkdtemp(
      path.join(path.dirname(this.dataPath), `.${path.basename(this.dataPath)}-backup-`),
    );

    try {
      const existingEntries = await fs.readdir(this.dataPath);
      for (const entry of existingEntries) {
        if (entry !== '.git') await fs.rename(path.join(this.dataPath, entry), path.join(backupPath, entry));
      }

      const stagedEntries = await fs.readdir(stagePath);
      for (const entry of stagedEntries) {
        await fs.rename(path.join(stagePath, entry), path.join(this.dataPath, entry));
      }
    } finally {
      await fs.rm(stagePath, { recursive: true, force: true });
      await fs.rm(backupPath, { recursive: true, force: true });
    }
  }

  private async writeVersion(targetPath: string, version: number): Promise<void> {
    await fs.mkdir(targetPath, { recursive: true });
    await fs.writeFile(path.join(targetPath, DATA_VERSION_FILENAME), `{"version":${version}}\n`, 'utf8');
  }
}
