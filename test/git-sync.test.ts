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

async function currentBranch(repoPath: string): Promise<string> {
  const { stdout } = await run('git', ['branch', '--show-current'], { cwd: repoPath });
  return stdout.trim();
}

async function createSeedRemote(basePrefix: string) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), basePrefix));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  await run('git', ['init', '--bare', remote]);
  await run('git', ['clone', remote, seed]);
  await configureGitIdentity(seed);
  await fs.writeFile(path.join(seed, 'entry.md'), md(100, 'seed'), 'utf8');
  await run('git', ['add', 'entry.md'], { cwd: seed });
  await run('git', ['commit', '-m', 'seed remote'], { cwd: seed });
  const branch = await currentBranch(seed);
  await run('git', ['push', '-u', 'origin', branch], { cwd: seed });
  return { base, remote, branch };
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
    const { base, remote } = await createSeedRemote('gs-head-');
    const seed = path.join(base, 'seed');
    const work = path.join(base, 'work');
    await run('git', ['checkout', '-b', 'trunk'], { cwd: seed });
    await fs.writeFile(path.join(seed, 'entry.md'), md(456, 'trunk'), 'utf8');
    await run('git', ['commit', '-am', 'move to trunk'], { cwd: seed });
    await run('git', ['push', '-u', 'origin', 'trunk'], { cwd: seed });
    await run('git', ['symbolic-ref', 'HEAD', 'refs/heads/missing'], { cwd: remote });
    await run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/master']).catch(() => {});
    await run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/main']).catch(() => {});

    const gs = new GitSync(work, remote);

    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    const file = await fs.readFile(path.join(work, 'entry.md'), 'utf8');
    expect(file).toContain('timestamp: 456');
    expect(file).toContain('trunk');
    expect(await currentBranch(work)).toBe('trunk');
  });

  it('merges remote files into an existing local directory without losing local files', async () => {
    const { base, remote } = await createSeedRemote('gs-merge-');
    const seed = path.join(base, 'seed');
    const work = path.join(base, 'work');

    await fs.mkdir(path.join(seed, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(seed, '2026-06-25', 'remote.md'), md(500, 'remote entry'), 'utf8');
    await run('git', ['add', '2026-06-25/remote.md'], { cwd: seed });
    await run('git', ['commit', '-m', 'add remote journal file'], { cwd: seed });
    await run('git', ['push'], { cwd: seed });

    await fs.mkdir(path.join(work, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(work, '2026-06-25', 'local.md'), md(400, 'local entry'), 'utf8');

    const gs = new GitSync(work, remote);

    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    const localMd = await fs.readFile(path.join(work, '2026-06-25', 'local.md'), 'utf8');
    const remoteMd = await fs.readFile(path.join(work, '2026-06-25', 'remote.md'), 'utf8');
    expect(localMd).toContain('local entry');
    expect(remoteMd).toContain('remote entry');
    const { stdout: status } = await run('git', ['status', '--short'], { cwd: work });
    expect(typeof status).toBe('string');
    const { stdout: origin } = await run('git', ['remote', 'get-url', 'origin'], { cwd: work });
    expect(origin.trim()).toBe(remote);
  });

  it('uses remote markdown when the same path has a newer remote timestamp', async () => {
    const { base, remote } = await createSeedRemote('gs-collision-remote-');
    const seed = path.join(base, 'seed');
    const work = path.join(base, 'work');

    await fs.mkdir(path.join(seed, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(seed, '2026-06-25', 'entry.md'), md(600, 'remote newer'), 'utf8');
    await run('git', ['add', '2026-06-25/entry.md'], { cwd: seed });
    await run('git', ['commit', '-m', 'add remote collision'], { cwd: seed });
    await run('git', ['push'], { cwd: seed });

    await fs.mkdir(path.join(work, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(work, '2026-06-25', 'entry.md'), md(500, 'local older'), 'utf8');

    const gs = new GitSync(work, remote);
    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    const finalMd = await fs.readFile(path.join(work, '2026-06-25', 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 600');
    expect(finalMd).toContain('remote newer');
    expect(finalMd).not.toContain('local older');
  });

  it('keeps local markdown when the same path has an equal timestamp', async () => {
    const { base, remote } = await createSeedRemote('gs-collision-local-');
    const seed = path.join(base, 'seed');
    const work = path.join(base, 'work');

    await fs.mkdir(path.join(seed, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(seed, '2026-06-25', 'entry.md'), md(700, 'remote tie'), 'utf8');
    await run('git', ['add', '2026-06-25/entry.md'], { cwd: seed });
    await run('git', ['commit', '-m', 'add remote tie collision'], { cwd: seed });
    await run('git', ['push'], { cwd: seed });

    await fs.mkdir(path.join(work, '2026-06-25'), { recursive: true });
    await fs.writeFile(path.join(work, '2026-06-25', 'entry.md'), md(700, 'local tie'), 'utf8');

    const gs = new GitSync(work, remote);
    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    const finalMd = await fs.readFile(path.join(work, '2026-06-25', 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 700');
    expect(finalMd).toContain('local tie');
    expect(finalMd).not.toContain('remote tie');
  });
});

describe('GitSync rebase conflict integration', () => {
  it('keeps the newer timestamp version and leaves no rebase state', async () => {
    const { base, remote, branch } = await createSeedRemote('gs-conflict-newer-');
    const local = path.join(base, 'local');
    const peer = path.join(base, 'peer');
    await run('git', ['clone', remote, local]);
    await run('git', ['clone', remote, peer]);
    await configureGitIdentity(local);
    await configureGitIdentity(peer);

    await fs.writeFile(path.join(peer, 'entry.md'), md(300, 'theirs newer'), 'utf8');
    await run('git', ['commit', '-am', 'peer update'], { cwd: peer });
    await run('git', ['push', 'origin', branch], { cwd: peer });

    await fs.writeFile(path.join(local, 'entry.md'), md(200, 'ours older'), 'utf8');
    await run('git', ['commit', '-am', 'local update'], { cwd: local });

    const gs = new GitSync(local, remote);
    await expect(gs.pull()).resolves.toBeUndefined();

    const finalMd = await fs.readFile(path.join(local, 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 300');
    expect(finalMd).toContain('theirs newer');
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: local });
    expect(status.trim()).toBe('');
    await expect(fs.access(path.join(local, '.git', 'rebase-merge'))).rejects.toBeDefined();
    await expect(fs.access(path.join(local, '.git', 'rebase-apply'))).rejects.toBeDefined();
  });

  it('keeps ours when timestamps tie and leaves no rebase state', async () => {
    const { base, remote, branch } = await createSeedRemote('gs-conflict-tie-');
    const local = path.join(base, 'local');
    const peer = path.join(base, 'peer');
    await run('git', ['clone', remote, local]);
    await run('git', ['clone', remote, peer]);
    await configureGitIdentity(local);
    await configureGitIdentity(peer);

    await fs.writeFile(path.join(peer, 'entry.md'), md(400, 'theirs tie'), 'utf8');
    await run('git', ['commit', '-am', 'peer tie update'], { cwd: peer });
    await run('git', ['push', 'origin', branch], { cwd: peer });

    await fs.writeFile(path.join(local, 'entry.md'), md(400, 'ours tie'), 'utf8');
    await run('git', ['commit', '-am', 'local tie update'], { cwd: local });

    const gs = new GitSync(local, remote);
    await expect(gs.pull()).resolves.toBeUndefined();

    const finalMd = await fs.readFile(path.join(local, 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 400');
    expect(finalMd).toContain('ours tie');
    expect(finalMd).not.toContain('theirs tie');
    const { stdout: status } = await run('git', ['status', '--porcelain'], { cwd: local });
    expect(status.trim()).toBe('');
    await expect(fs.access(path.join(local, '.git', 'rebase-merge'))).rejects.toBeDefined();
    await expect(fs.access(path.join(local, '.git', 'rebase-apply'))).rejects.toBeDefined();
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

  it('logs ls-remote failures and does not initialize an empty repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-ls-remote-'));
    const missingRemote = path.join(dir, 'missing.git');
    const gs = new GitSync(dir, missingRemote);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const gitSpy = jest.spyOn(gs as any, 'git');

    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      '[private-journal] git ls-remote failed (best-effort):',
      expect.stringContaining('does not appear to be a git repository'),
    );
    expect(gitSpy).not.toHaveBeenCalledWith(['init']);
    await expect(fs.access(path.join(dir, '.git'))).rejects.toBeDefined();
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
