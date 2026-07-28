import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parseFrontmatter } from './journal';

const run = promisify(execFile);
const gitEnv = { ...process.env, GIT_EDITOR: process.env.GIT_EDITOR ?? 'true' };

const DEFAULT_GIT_TIMEOUT_MS = 10000;
const LOCK_FILENAME = '.private-journal-sync.lock';
const STALE_LOCK_MS = 120000;

export function resolveGitTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_GIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_GIT_TIMEOUT_MS;
  return parsed;
}

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

  private async runNet(args: string[], cwd: string = this.dataPath): Promise<{ stdout: string; stderr: string }> {
    return run('git', args, {
      cwd,
      env: gitEnv,
      timeout: resolveGitTimeoutMs(),
    });
  }

  private async hasGitDir(): Promise<boolean> {
    return fs.access(path.join(this.dataPath, '.git')).then(() => true).catch(() => false);
  }

  private get lockPath(): string {
    return path.join(this.dataPath, LOCK_FILENAME);
  }

  private async isStaleLock(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.lockPath, 'utf8');
      const { acquiredAt } = JSON.parse(raw) as { acquiredAt?: number };
      if (typeof acquiredAt !== 'number') return true;
      return Date.now() - acquiredAt > STALE_LOCK_MS;
    } catch {
      // 읽을 수 없거나 깨진 록은 stale로 본다
      return true;
    }
  }

  private async acquireLock(): Promise<boolean> {
    const payload = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      await fs.writeFile(this.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch {
      if (!(await this.isStaleLock())) return false;
      try {
        await fs.writeFile(this.lockPath, payload, 'utf8');
        console.error('[private-journal] stole stale sync lock');
        return true;
      } catch {
        return false;
      }
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (!(await this.acquireLock())) {
      console.error('[private-journal] sync already in progress, skipping');
      return undefined;
    }
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockPath, { force: true }).catch(() => {});
    }
  }

  async ensureRepo(): Promise<void> {
    if (!this.enabled) return;
    if (await this.hasGitDir()) return;
    try {
      await fs.mkdir(this.dataPath, { recursive: true });
      try {
        const { stdout } = await this.runNet(['ls-remote', this.remote!]);
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

  private async deleteEmbeddingForMarkdown(mdPath: string): Promise<void> {
    try {
      await fs.rm(mdPath.replace(/\.md$/, '.embedding'), { force: true });
    } catch (err) {
      logGitFailure('[private-journal] embedding cleanup failed (best-effort):', err);
    }
  }

  private async defaultRemoteBranch(): Promise<string> {
    try {
      const { stdout } = await this.runNet(['ls-remote', '--symref', this.remote!, 'HEAD']);
      const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
      if (m) return m[1];
    } catch { /* ignore */ }
    return 'main';
  }

  private async isTrackedPath(rel: string): Promise<boolean> {
    try {
      await this.git(['ls-files', '--error-unmatch', '--', rel]);
      return true;
    } catch {
      return false;
    }
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
      await this.runNet(['clone', '--no-checkout', this.remote!, clonePath]);
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
          await this.deleteEmbeddingForMarkdown(targetPath);
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
    await this.withLock(() => this.pullUnlocked());
  }

  private async pullUnlocked(): Promise<void> {
    try {
      const branch = await this.currentBranch();
      await this.runNet(['fetch', 'origin', branch]);
      await this.git(['rebase', '--autostash', `origin/${branch}`]);
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
    const mdPath = path.join(this.dataPath, rel);
    const embeddingRel = rel.replace(/\.md$/, '.embedding');
    await this.deleteEmbeddingForMarkdown(mdPath);
    try {
      await this.git(['add', '--', rel]);
      if (await this.isTrackedPath(embeddingRel)) {
        await this.git(['add', '-u', '--', embeddingRel]);
      }
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

  private async abortIfIndexUnmerged(): Promise<void> {
    try {
      const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
      if (!stdout.trim()) return;
      console.error('[private-journal] index still has unmerged paths; resetting to avoid committing conflict markers');
      await this.git(['reset', '--mixed', 'HEAD']);
    } catch (err) {
      logGitFailure('[private-journal] unmerged index check failed (best-effort):', err);
    }
  }

  private async recoverFromInterruptedRebase(): Promise<void> {
    if (!(await this.hasRebaseInProgress())) return;
    console.error('[private-journal] found interrupted rebase, recovering');
    await this.resolveRebaseConflicts();
    if (!(await this.hasRebaseInProgress())) return;
    try {
      await this.git(['rebase', '--abort']);
      console.error('[private-journal] aborted unrecoverable rebase (local commits preserved)');
    } catch (err) {
      logGitFailure('[private-journal] git rebase abort failed (best-effort):', err);
      // abort가 실패하는 경우는 두 가지다. rebase 상태 자체가 불완전해서
      // git이 읽지 못하는 경우와, 온전한 상태인데 다른 이유로 실패한 경우.
      // 전자만 강제 정리한다 — 온전한 상태를 지우면 git이 복구할 수 있었던
      // 작업 트리를 파괴한다.
      const gitDir = path.join(this.dataPath, '.git');
      const salvageable = await this.pathExists(path.join(gitDir, 'rebase-merge', 'head-name'));
      if (salvageable) {
        console.error('[private-journal] rebase state looks intact; leaving it for manual recovery');
        return;
      }
      try {
        await fs.rm(path.join(gitDir, 'rebase-merge'), { recursive: true, force: true });
        await fs.rm(path.join(gitDir, 'rebase-apply'), { recursive: true, force: true });
        // 디렉터리를 지워도 인덱스의 unmerged 항목은 남는다. 그대로 두면
        // 다음 `add -A`가 conflict marker를 그대로 스테이징해서 저널 파일을
        // 손상시킨다. 인덱스를 HEAD로 되돌려 오염을 제거한다.
        //
        // 주의: 이 reset은 인덱스만 정리한다. 작업 트리 파일에 이미 박힌
        // marker는 지우지 않는다. 여기 도달하기 전에 resolveRebaseConflicts()가
        // checkout --ours/--theirs로 각 충돌 파일을 해결하므로 현재는 문제가
        // 없지만, 그 순서가 바뀌면 marker가 남은 파일이 커밋될 수 있다.
        await this.git(['reset', '--mixed', 'HEAD']);
        console.error('[private-journal] force-cleaned unreadable rebase state');
      } catch (cleanupErr) {
        logGitFailure('[private-journal] cleanup of rebase directories failed (best-effort):', cleanupErr);
      }
    }
  }

  async commitAndPush(message: string): Promise<void> {
    if (!this.enabled) return;
    await this.withLock(() => this.commitAndPushUnlocked(message));
  }

  private async commitAndPushUnlocked(message: string): Promise<void> {
    try {
      await this.ensureRepo();
      await this.recoverFromInterruptedRebase();
      await this.abortIfIndexUnmerged();
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
        await this.pullUnlocked();
        try {
          await this.runNet(['push', '-u', 'origin', branch]);
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
