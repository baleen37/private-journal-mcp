import { chooseConflictWinner, GitSync } from '../src/git-sync';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const run = promisify(execFile);

function md(ts: number, body = 'x') {
  return `---\ntitle: "t"\ndate: d\ntimestamp: ${ts}\n---\n\n## Reflections\n\n${body}\n`;
}

async function configureGitIdentity(repoPath: string) {
  await run('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
  await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
}

describe('chooseConflictWinner', () => {
  it('picks theirs when their timestamp is newer', () => {
    expect(chooseConflictWinner(md(100), md(200))).toBe('theirs');
  });
  it('picks ours when timestamps are equal', () => {
    expect(chooseConflictWinner(md(100), md(100))).toBe('ours');
  });
  it('picks ours when ours is newer', () => {
    expect(chooseConflictWinner(md(300), md(200))).toBe('ours');
  });
});

describe('GitSync (disabled when no remote)', () => {
  it('is no-op when remote undefined', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-'));
    const gs = new GitSync(dir, undefined);
    expect(gs.enabled).toBe(false);
    await gs.ensureRepo();
    await gs.commitAndPush('msg'); // should not throw
    await expect(fs.access(path.join(dir, '.git'))).rejects.toBeDefined();
  });
});

describe('GitSync commitAndPush against a bare remote', () => {
  it('commits and pushes journal files', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gsr-'));
    const remote = path.join(base, 'remote.git');
    const work = path.join(base, 'work');
    await run('git', ['init', '--bare', remote]);
    await fs.mkdir(work, { recursive: true });

    const gs = new GitSync(work, remote);
    await gs.ensureRepo();
    await configureGitIdentity(work);
    await fs.mkdir(path.join(work, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(work, '2026-06-25', '01-02-03-000000.md'), md(123), 'utf8');
    await gs.commitAndPush('journal: test');

    // clone remote elsewhere and verify file present
    const verify = path.join(base, 'verify');
    await run('git', ['clone', remote, verify]);
    const exists = await fs.access(path.join(verify, '2026-06-25', '01-02-03-000000.md')).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    errorSpy.mockRestore();
  });
});

describe('GitSync ensureRepo with populated remote', () => {
  it('falls back to an actual remote branch when remote HEAD is stale', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-head-'));
    const remote = path.join(base, 'remote.git');
    const seed = path.join(base, 'seed');
    const work = path.join(base, 'work');

    await run('git', ['init', '--bare', remote]);
    await run('git', ['clone', remote, seed]);
    await configureGitIdentity(seed);
    await run('git', ['checkout', '-b', 'trunk'], { cwd: seed });
    await fs.writeFile(path.join(seed, 'entry.md'), md(456), 'utf8');
    await run('git', ['add', 'entry.md'], { cwd: seed });
    await run('git', ['commit', '-m', 'seed remote'], { cwd: seed });
    await run('git', ['push', '-u', 'origin', 'trunk'], { cwd: seed });
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/missing'], { cwd: remote });

    const gs = new GitSync(work, remote);

    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    const file = await fs.readFile(path.join(work, 'entry.md'), 'utf8');
    expect(file).toContain('timestamp: 456');
    const { stdout } = await run('git', ['branch', '--show-current'], { cwd: work });
    expect(stdout.trim()).toBe('trunk');
  });
});

describe('GitSync best-effort error handling', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs real commit failures instead of treating them as nothing to commit', async () => {
    const gs = new GitSync('/tmp/private-journal-gs', '/tmp/remote.git');
    const error = Object.assign(new Error('commit failed'), {
      stderr: 'Author identity unknown',
      stdout: '',
    });
    const git = jest.fn()
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(error);
    const ensureRepo = jest.spyOn(gs, 'ensureRepo').mockResolvedValue();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    (gs as any).git = git;

    await expect(gs.commitAndPush('journal: test')).resolves.toBeUndefined();

    expect(ensureRepo).toHaveBeenCalled();
    expect(git).toHaveBeenCalledWith(['commit', '-m', 'journal: test']);
    expect(errorSpy).toHaveBeenCalledWith(
      '[private-journal] git commit failed (best-effort):',
      error.stderr,
    );
  });

  it('logs non-conflict pull failures and skips conflict resolution', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'gsp-'));
    const remote = path.join(base, 'remote.git');
    await run('git', ['init', '--bare', remote]);

    const gs = new GitSync(base, remote);
    const error = Object.assign(new Error('pull failed'), {
      stderr: 'fatal: Authentication failed',
      stdout: '',
    });
    const resolveSpy = jest.spyOn(gs as any, 'resolveRebaseConflicts').mockResolvedValue(undefined);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    jest.spyOn(gs as any, 'hasGitDir').mockResolvedValue(true);
    jest.spyOn(gs as any, 'currentBranch').mockResolvedValue('main');
    (gs as any).git = jest.fn().mockRejectedValue(error);

    await expect(gs.pull()).resolves.toBeUndefined();

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      '[private-journal] git pull failed (best-effort):',
      error.stderr,
    );
  });

  it('logs internal conflict-resolution failures and unresolved rebase state', async () => {
    const gs = new GitSync('/tmp/private-journal-gs-conflict', '/tmp/remote.git');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const resolveMdConflict = jest.spyOn(gs as any, 'resolveMdConflict').mockResolvedValue(undefined);
    jest.spyOn(gs as any, 'hasRebaseInProgress').mockResolvedValue(true);
    const conflictError = Object.assign(new Error('pull conflict'), {
      stderr: 'CONFLICT (content): Merge conflict in entry.md',
      stdout: '',
    });
    const git = jest.fn()
      .mockRejectedValueOnce(conflictError)
      .mockResolvedValueOnce({ stdout: 'entry.md\n', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('continue failed'), {
        stderr: 'error: could not apply deadbeef',
        stdout: '',
      }))
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('status failed'), {
        stderr: 'fatal: ambiguous argument HEAD',
        stdout: '',
      }));

    jest.spyOn(gs as any, 'hasGitDir').mockResolvedValue(true);
    jest.spyOn(gs as any, 'currentBranch').mockResolvedValue('main');
    (gs as any).git = git;

    await expect(gs.pull()).resolves.toBeUndefined();

    expect(resolveMdConflict).toHaveBeenCalledWith('entry.md');
    expect(errorSpy).toHaveBeenCalledWith(
      '[private-journal] git rebase continue failed (best-effort):',
      'error: could not apply deadbeef',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[private-journal] git conflict state check failed (best-effort):',
      'fatal: ambiguous argument HEAD',
    );
    expect(errorSpy).toHaveBeenCalledWith(
      '[private-journal] git rebase still unresolved after conflict handling (best-effort)',
    );
  });
});
