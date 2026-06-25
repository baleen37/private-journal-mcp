import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter } from './journal';

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_EDITOR: process.env.GIT_EDITOR ?? 'true' };

function gitErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const stderr = 'stderr' in error ? error.stderr : undefined;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
    const stdout = 'stdout' in error ? error.stdout : undefined;
    if (typeof stdout === 'string' && stdout.trim()) return stdout.trim();
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function isNothingToCommitError(error: unknown): boolean {
  return /nothing (added to commit|to commit)/i.test(gitErrorText(error));
}

function isRebaseConflictError(error: unknown): boolean {
  return /(conflict|could not apply|resolve all conflicts manually|fix conflicts)/i.test(
    gitErrorText(error),
  );
}

function logGitFailure(prefix: string, error: unknown): void {
  console.error(prefix, gitErrorText(error));
}

export function chooseConflictWinner(oursMd: string, theirsMd: string): 'ours' | 'theirs' {
  const ours = parseFrontmatter(oursMd).timestamp;
  const theirs = parseFrontmatter(theirsMd).timestamp;
  return theirs > ours ? 'theirs' : 'ours';
}

export class GitSync {
  constructor(private dataPath: string, private remote: string | undefined) {}

  get enabled(): boolean {
    return !!this.remote;
  }

  private async git(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, { cwd: this.dataPath, env: gitEnv });
  }

  private async gitAt(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, { cwd, env: gitEnv });
  }

  private async hasGitDir(): Promise<boolean> {
    return fs.access(path.join(this.dataPath, '.git')).then(() => true).catch(() => false);
  }

  async ensureRepo(): Promise<void> {
    if (!this.enabled) return;
    if (await this.hasGitDir()) return;
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      try {
        const { stdout } = await run('git', ['ls-remote', this.remote!]);
        if (stdout.trim().length > 0) {
          await this.clonePopulatedRemote();
          return;
        }
        await this.git(['init']);
        await this.git(['remote', 'add', 'origin', this.remote!]);
      } catch (err) {
        logGitFailure('[private-journal] git ls-remote failed (best-effort):', err);
        return;
      }
    } catch (err) {
      logGitFailure('[private-journal] git ensureRepo failed (best-effort):', err);
    }
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    return fs.access(targetPath).then(() => true).catch(() => false);
  }

  private async shouldReplaceMarkdownFile(localPath: string, remotePath: string): Promise<boolean> {
    const [localMd, remoteMd] = await Promise.all([
      fs.readFile(localPath, 'utf8'),
      fs.readFile(remotePath, 'utf8'),
    ]);
    return chooseConflictWinner(localMd, remoteMd) === 'theirs';
  }

  private async defaultRemoteBranch(): Promise<string> {
    try {
      const { stdout } = await run('git', ['ls-remote', '--symref', this.remote!, 'HEAD']);
      const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return 'main';
  }

  private async remoteBranches(repoPath = this.dataPath): Promise<string[]> {
    const { stdout } = await this.gitAt(repoPath, ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== 'HEAD');
  }

  private async checkoutableRemoteBranch(repoPath = this.dataPath): Promise<string | undefined> {
    const preferred = await this.defaultRemoteBranch();
    const branches = await this.remoteBranches(repoPath);
    if (branches.includes(preferred)) return preferred;
    return branches[0];
  }

  private async clonePopulatedRemote(): Promise<void> {
    const parentDir = await fs.mkdtemp(path.join(path.dirname(this.dataPath), '.private-journal-clone-'));
    const clonePath = path.join(parentDir, 'repo');
    try {
      await run('git', ['clone', '--no-checkout', this.remote!, clonePath]);
      const branch = await this.checkoutableRemoteBranch(clonePath);
      if (!branch) {
        console.error('[private-journal] git clone found no remote branches (best-effort)');
        return;
      }
      await this.gitAt(clonePath, ['checkout', '-B', branch, `origin/${branch}`]);
      await fs.rename(path.join(clonePath, '.git'), path.join(this.dataPath, '.git'));
      await this.mergeDirectoryContents(clonePath, this.dataPath);
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  }

  private async mergeDirectoryContents(fromDir: string, toDir: string): Promise<void> {
    const entries = await fs.readdir(fromDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const sourcePath = path.join(fromDir, entry.name);
      const targetPath = path.join(toDir, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: true });
        await this.mergeDirectoryContents(sourcePath, targetPath);
        continue;
      }
      if (entry.isFile()) {
        const exists = await this.pathExists(targetPath);
        if (!exists) {
          await fs.copyFile(sourcePath, targetPath);
          continue;
        }
        if (entry.name.endsWith('.md') && await this.shouldReplaceMarkdownFile(targetPath, sourcePath)) {
          await fs.copyFile(sourcePath, targetPath);
        }
      }
    }
  }

  private async currentBranch(): Promise<string> {
    try {
      const { stdout } = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
      const b = stdout.trim();
      if (b && b !== 'HEAD') return b;
    } catch { /* ignore */ }
    return 'main';
  }

  async pull(): Promise<void> {
    if (!this.enabled) return;
    if (!(await this.hasGitDir())) return;
    try {
      await this.git(['pull', '--rebase', '--autostash', 'origin', await this.currentBranch()]);
    } catch (err) {
      if (isRebaseConflictError(err)) {
        await this.resolveRebaseConflicts();
        return;
      }
      console.error('[private-journal] git pull failed (best-effort):', gitErrorText(err));
    }
  }

  private async resolveRebaseConflicts(): Promise<void> {
    // loop until rebase done or unresolvable
    for (let i = 0; i < 100; i++) {
      let conflicted: string[] = [];
      try {
        const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
        conflicted = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      } catch (err) {
        logGitFailure('[private-journal] git conflict scan failed (best-effort):', err);
        break;
      }
      if (conflicted.length === 0) break;
      for (const rel of conflicted) {
        if (rel.endsWith('.md')) {
          await this.resolveMdConflict(rel);
        } else {
          // .embedding or other: take ours, will be regenerated/ignored
          try {
            await this.git(['checkout', '--ours', '--', rel]);
          } catch (err) {
            logGitFailure('[private-journal] git conflict checkout failed (best-effort):', err);
          }
          try {
            await this.git(['add', '--', rel]);
          } catch (err) {
            logGitFailure('[private-journal] git conflict add failed (best-effort):', err);
          }
        }
      }
      try {
        await this.git(['rebase', '--continue']);
        break;
      } catch (err) {
        logGitFailure('[private-journal] git rebase continue failed (best-effort):', err);
        // more conflicts in next commit; loop again
        continue;
      }
    }
    await this.logUnresolvedRebaseState();
  }

  private async resolveMdConflict(rel: string): Promise<void> {
    const rebaseInProgress = await this.hasRebaseInProgress();
    let stage2 = '';
    let stage3 = '';
    try {
      stage2 = (await this.git(['show', `:2:${rel}`])).stdout;
    } catch (err) {
      logGitFailure('[private-journal] git show ours failed (best-effort):', err);
    }
    try {
      stage3 = (await this.git(['show', `:3:${rel}`])).stdout;
    } catch (err) {
      logGitFailure('[private-journal] git show theirs failed (best-effort):', err);
    }
    const localMd = rebaseInProgress ? stage3 : stage2;
    const remoteMd = rebaseInProgress ? stage2 : stage3;
    const winner = chooseConflictWinner(localMd, remoteMd);
    const side = winner === 'ours'
      ? (rebaseInProgress ? '--theirs' : '--ours')
      : (rebaseInProgress ? '--ours' : '--theirs');
    try {
      await this.git(['checkout', side, '--', rel]);
    } catch (err) {
      logGitFailure('[private-journal] git markdown conflict checkout failed (best-effort):', err);
    }
    try {
      await this.git(['add', '--', rel]);
    } catch (err) {
      logGitFailure('[private-journal] git markdown conflict add failed (best-effort):', err);
    }
  }

  private async logUnresolvedRebaseState(): Promise<void> {
    const rebaseInProgress = await this.hasRebaseInProgress();
    try {
      const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
      const conflicted = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
      if (rebaseInProgress || conflicted.length > 0) {
        console.error('[private-journal] git rebase still unresolved after conflict handling (best-effort)');
      }
    } catch (err) {
      logGitFailure('[private-journal] git conflict state check failed (best-effort):', err);
      if (rebaseInProgress) {
        console.error('[private-journal] git rebase still unresolved after conflict handling (best-effort)');
      }
    }
  }

  private async hasRebaseInProgress(): Promise<boolean> {
    const gitDir = path.join(this.dataPath, '.git');
    const rebaseApply = fs.access(path.join(gitDir, 'rebase-apply')).then(() => true).catch(() => false);
    const rebaseMerge = fs.access(path.join(gitDir, 'rebase-merge')).then(() => true).catch(() => false);
    const [applyExists, mergeExists] = await Promise.all([rebaseApply, rebaseMerge]);
    return applyExists || mergeExists;
  }

  async commitAndPush(message: string): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureRepo();
      await this.git(['add', '-A']);
      try {
      await this.git(['commit', '-m', message]);
      } catch (err) {
        if (isNothingToCommitError(err)) {
          return;
        }
        logGitFailure('[private-journal] git commit failed (best-effort):', err);
        return;
      }
      const branch = await this.currentBranch();
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.pull();
        try {
          await this.git(['push', '-u', 'origin', branch]);
          return;
        } catch (err) {
          if (attempt === 1) {
            logGitFailure('[private-journal] git push failed (best-effort):', err);
          }
        }
      }
    } catch (err) {
      logGitFailure('[private-journal] git sync failed (best-effort):', err);
    }
  }
}
