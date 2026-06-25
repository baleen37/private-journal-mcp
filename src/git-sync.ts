import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter } from './journal';

const run = promisify(execFile);

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
    return run('git', args, { cwd: this.dataPath });
  }

  private async hasGitDir(): Promise<boolean> {
    return fs.access(path.join(this.dataPath, '.git')).then(() => true).catch(() => false);
  }

  async ensureRepo(): Promise<void> {
    if (!this.enabled) return;
    if (await this.hasGitDir()) return;
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      // does remote have any refs?
      let remoteHasContent = false;
      try {
        const { stdout } = await run('git', ['ls-remote', this.remote!]);
        remoteHasContent = stdout.trim().length > 0;
      } catch {
        remoteHasContent = false;
      }
      if (remoteHasContent) {
        await this.git(['init']);
        await this.git(['remote', 'add', 'origin', this.remote!]);
        await this.git(['fetch', 'origin']);
        const branch = await this.checkoutableRemoteBranch();
        if (!branch) {
          console.error('[private-journal] git fetch found no remote branches (best-effort)');
          return;
        }
        await this.git(['checkout', '-B', branch, `origin/${branch}`]);
      } else {
        await this.git(['init']);
        await this.git(['remote', 'add', 'origin', this.remote!]);
      }
    } catch (err) {
      logGitFailure('[private-journal] git ensureRepo failed (best-effort):', err);
    }
  }

  private async defaultRemoteBranch(): Promise<string> {
    try {
      const { stdout } = await run('git', ['ls-remote', '--symref', this.remote!, 'HEAD']);
      const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return 'main';
  }

  private async remoteBranches(): Promise<string[]> {
    const { stdout } = await this.git(['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line !== 'HEAD');
  }

  private async checkoutableRemoteBranch(): Promise<string | undefined> {
    const preferred = await this.defaultRemoteBranch();
    const branches = await this.remoteBranches();
    if (branches.includes(preferred)) return preferred;
    return branches[0];
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
    let oursMd = '';
    let theirsMd = '';
    try {
      oursMd = (await this.git(['show', `:2:${rel}`])).stdout;
    } catch (err) {
      logGitFailure('[private-journal] git show ours failed (best-effort):', err);
    }
    try {
      theirsMd = (await this.git(['show', `:3:${rel}`])).stdout;
    } catch (err) {
      logGitFailure('[private-journal] git show theirs failed (best-effort):', err);
    }
    const winner = chooseConflictWinner(oursMd, theirsMd);
    const side = winner === 'ours' ? '--ours' : '--theirs';
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
        console.error('[private-journal] git commit failed (best-effort):', gitErrorText(err));
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
            console.error('[private-journal] git push failed (best-effort):', err);
          }
        }
      }
    } catch (err) {
      console.error('[private-journal] git sync failed (best-effort):', err);
    }
  }
}
