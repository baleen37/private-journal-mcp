import { chooseConflictWinner, GitSync, resolveGitTimeoutMs } from '../src/git-sync';
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
    await fs.writeFile(
      path.join(work, '2026-06-25', 'entry.embedding'),
      '{"text":"stale local embedding"}',
      'utf8',
    );

    const gs = new GitSync(work, remote);
    await expect(gs.ensureRepo()).resolves.toBeUndefined();

    const finalMd = await fs.readFile(path.join(work, '2026-06-25', 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 600');
    expect(finalMd).toContain('remote newer');
    expect(finalMd).not.toContain('local older');
    await expect(fs.access(path.join(work, '2026-06-25', 'entry.embedding'))).rejects.toBeDefined();
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
    await fs.writeFile(path.join(local, 'entry.embedding'), '{"text":"stale local embedding"}', 'utf8');
    await run('git', ['commit', '-am', 'local update'], { cwd: local });

    const gs = new GitSync(local, remote);
    await expect(gs.pull()).resolves.toBeUndefined();

    const finalMd = await fs.readFile(path.join(local, 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 300');
    expect(finalMd).toContain('theirs newer');
    await expect(fs.access(path.join(local, 'entry.embedding'))).rejects.toBeDefined();
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
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // diff --diff-filter=U (abortIfIndexUnmerged)
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // add -A
      .mockRejectedValueOnce(error); // commit
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
    (gs as any).runNet = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
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
    (gs as any).runNet = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
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

describe('GitSync repo metadata', () => {
  it('creates .gitattributes marking .embedding as binary', async () => {
    const { base, remote } = await createSeedRemote('gs-attrs-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();

    const attrs = await fs.readFile(path.join(dir, '.gitattributes'), 'utf8');
    expect(attrs).toContain('*.embedding binary');
  }, 30000);

  it('excludes the lock file from the data repo', async () => {
    const { base, remote } = await createSeedRemote('gs-exclude-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    await fs.writeFile(path.join(dir, '.private-journal-sync.lock'), '{}', 'utf8');
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: dir });
    expect(stdout).not.toContain('.private-journal-sync.lock');
  }, 30000);

  it('does not overwrite an existing .gitattributes', async () => {
    const { base, remote } = await createSeedRemote('gs-attrs-keep-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await fs.writeFile(path.join(dir, '.gitattributes'), '# custom\n', 'utf8');

    await gs.ensureRepo(); // 두 번째 호출
    const attrs = await fs.readFile(path.join(dir, '.gitattributes'), 'utf8');
    expect(attrs).toBe('# custom\n');
  }, 30000);

  it('does not throw when .gitattributes write fails (read-only directory)', async () => {
    const { base, remote } = await createSeedRemote('gs-attrs-readonly-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo(); // .gitattributes 생성

    await fs.rm(path.join(dir, '.gitattributes'), { force: true });
    await fs.chmod(dir, 0o555);
    try {
      await expect(gs.ensureRepo()).resolves.toBeUndefined();
    } finally {
      await fs.chmod(dir, 0o700);
    }
  }, 30000);
});

describe('resolveGitTimeoutMs', () => {
  it('defaults to 10000ms', () => {
    expect(resolveGitTimeoutMs({})).toBe(10000);
  });
  it('reads PRIVATE_JOURNAL_GIT_TIMEOUT_MS', () => {
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: '500' })).toBe(500);
  });
  it('ignores non-numeric values', () => {
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: 'abc' })).toBe(10000);
  });
  it('ignores zero and negative values', () => {
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: '0' })).toBe(10000);
    expect(resolveGitTimeoutMs({ PRIVATE_JOURNAL_GIT_TIMEOUT_MS: '-5' })).toBe(10000);
  });
});

describe('GitSync network timeout', () => {
  it('gives up on an unreachable remote and leaves no rebase state', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gs-timeout-'));
    // 라우팅되지 않는 주소 — 연결이 걸린 상태로 매달린다
    const gs = new GitSync(dir, 'git://10.255.255.1/nope.git');
    process.env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS = '1000';
    try {
      const started = Date.now();
      await gs.ensureRepo();
      // 타임아웃 상한 안에서 돌아와야 한다 (여유 있게 15초)
      expect(Date.now() - started).toBeLessThan(15000);
      // rebase 진행 중 상태가 남지 않아야 한다
      await expect(fs.access(path.join(dir, '.git', 'rebase-merge'))).rejects.toBeDefined();
      await expect(fs.access(path.join(dir, '.git', 'rebase-apply'))).rejects.toBeDefined();
    } finally {
      delete process.env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS;
    }
  }, 30000);
});

describe('GitSync rebase recovery', () => {
  it('force-cleans unreadable rebase state and still commits', async () => {
    const { base, remote } = await createSeedRemote('gs-recover-unreadable-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    // rebase 진행 중 상태를 인위적으로 만든다 (불완전한 상태 — head-name 없음)
    await fs.mkdir(path.join(dir, '.git', 'rebase-merge'), { recursive: true });

    // 새 항목을 쓰고 sync
    await fs.writeFile(path.join(dir, 'recovered.md'), md(500, 'recovered'), 'utf8');
    await gs.commitAndPush('after interruption');

    // rebase 상태가 정리되었다
    await expect(fs.access(path.join(dir, '.git', 'rebase-merge'))).rejects.toBeDefined();
    // 항목이 실제로 커밋되었다
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('after interruption');
  }, 30000);

  it('resolves actual rebase conflicts during recovery and preserves newer version', async () => {
    const { base, remote, branch } = await createSeedRemote('gs-recover-conflict-');
    const local = path.join(base, 'local');
    const peer = path.join(base, 'peer');
    await run('git', ['clone', remote, local]);
    await run('git', ['clone', remote, peer]);
    await configureGitIdentity(local);
    await configureGitIdentity(peer);

    // peer가 먼저 push
    await fs.writeFile(path.join(peer, 'entry.md'), md(600, 'peer newer'), 'utf8');
    await run('git', ['commit', '-am', 'peer push'], { cwd: peer });
    await run('git', ['push', 'origin', branch], { cwd: peer });

    // local이 다르게 커밋 (충돌 발생할 상태)
    await fs.writeFile(path.join(local, 'entry.md'), md(500, 'local older'), 'utf8');
    await run('git', ['commit', '-am', 'local commit'], { cwd: local });

    // pull이 자동으로 진행되지 않은 상태로 commitAndPush 호출
    // (rebase가 중단된 상태로 들어온다는 시뮬레이션)
    const gs = new GitSync(local, remote);

    // fetch를 미리 해서 rebase가 충돌하게 만들고
    await (gs as any).runNet(['fetch', 'origin', branch]);
    // 실제 rebase 시작 — 충돌로 중단된다
    try {
      await (gs as any).git(['rebase', '--autostash', `origin/${branch}`]);
    } catch (e) {
      // 충돌로 실패하는 것이 정상
    }

    // 이제 rebase-merge가 있는 상태에서 commitAndPush
    await fs.writeFile(path.join(local, 'newfile.md'), md(700, 'new entry'), 'utf8');
    await gs.commitAndPush('recover from conflict');

    // rebase 상태가 정리되었다
    await expect(fs.access(path.join(local, '.git', 'rebase-merge'))).rejects.toBeDefined();
    // 새 파일이 커밋되었다
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: local });
    expect(stdout).toContain('recover from conflict');
    // entry.md는 peer의 버전(더 최신 timestamp)으로 해결되었다
    const finalMd = await fs.readFile(path.join(local, 'entry.md'), 'utf8');
    expect(finalMd).toContain('timestamp: 600');
    expect(finalMd).toContain('peer newer');
    expect(finalMd).not.toContain('<<<<<<<');
  }, 30000);
});

describe('GitSync unmerged index protection', () => {
  it('prevents conflict markers from being committed after forced rebase cleanup', async () => {
    const { base, remote, branch } = await createSeedRemote('gs-marker-');
    const dir = path.join(base, 'local');
    await run('git', ['clone', remote, dir]);
    await configureGitIdentity(dir);

    // 충돌을 만든다
    const entryPath = path.join(dir, 'entry.md');
    await fs.writeFile(entryPath, md(300, 'local version'), 'utf8');
    await run('git', ['commit', '-am', 'local change'], { cwd: dir });

    // remote에 충돌하는 변경
    const seed = path.join(base, 'seed');
    await fs.writeFile(path.join(seed, 'entry.md'), md(400, 'remote version'), 'utf8');
    await run('git', ['commit', '-am', 'remote change'], { cwd: seed });
    await run('git', ['push', 'origin', branch], { cwd: seed });

    // rebase가 충돌로 중단
    const gs = new GitSync(dir, remote);
    await (gs as any).runNet(['fetch', 'origin', branch]);
    try {
      await (gs as any).git(['rebase', '--autostash', `origin/${branch}`]);
    } catch (e) {
      // expected
    }

    // commitAndPush가 unmerged를 정리해야 한다
    await fs.writeFile(path.join(dir, 'newfile.md'), md(500, 'new'), 'utf8');
    await gs.commitAndPush('with marker protection');

    // commit 성공
    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('with marker protection');

    // 파일에 marker가 없다
    const finalMd = await fs.readFile(entryPath, 'utf8');
    expect(finalMd).not.toContain('<<<<<<<');
  }, 30000);
});

describe('GitSync file lock', () => {
  it('skips sync when the lock is already held', async () => {
    const { base, remote } = await createSeedRemote('gs-lock-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    // 다른 세션이 방금 록을 잡은 것처럼 만든다
    await fs.writeFile(
      path.join(dir, '.private-journal-sync.lock'),
      JSON.stringify({ pid: 999999, acquiredAt: Date.now() }),
      'utf8',
    );

    await fs.writeFile(path.join(dir, 'skipped.md'), md(600, 'skipped'), 'utf8');
    await gs.commitAndPush('should be skipped');

    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).not.toContain('should be skipped');
  }, 30000);

  it('steals a stale lock', async () => {
    const { base, remote } = await createSeedRemote('gs-stale-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    // 임계값(120초)보다 오래된 록
    await fs.writeFile(
      path.join(dir, '.private-journal-sync.lock'),
      JSON.stringify({ pid: 999999, acquiredAt: Date.now() - 200000 }),
      'utf8',
    );

    await fs.writeFile(path.join(dir, 'stolen.md'), md(700, 'stolen'), 'utf8');
    await gs.commitAndPush('after stealing stale lock');

    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('after stealing stale lock');
  }, 30000);

  it('releases the lock after sync so the next call succeeds', async () => {
    const { base, remote } = await createSeedRemote('gs-release-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    await fs.writeFile(path.join(dir, 'first.md'), md(800, 'first'), 'utf8');
    await gs.commitAndPush('first entry');
    // 록이 해제되어 파일이 남아있지 않다
    await expect(
      fs.access(path.join(dir, '.private-journal-sync.lock')),
    ).rejects.toBeDefined();

    await fs.writeFile(path.join(dir, 'second.md'), md(900, 'second'), 'utf8');
    await gs.commitAndPush('second entry');

    const { stdout } = await run('git', ['log', '--oneline'], { cwd: dir });
    expect(stdout).toContain('first entry');
    expect(stdout).toContain('second entry');
  }, 30000);

  it('picks up entries skipped by an earlier locked run', async () => {
    const { base, remote } = await createSeedRemote('gs-catchup-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    const lockPath = path.join(dir, '.private-journal-sync.lock');
    await fs.writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), 'utf8');
    await fs.writeFile(path.join(dir, 'deferred.md'), md(1000, 'deferred'), 'utf8');
    await gs.commitAndPush('skipped run');

    // 록이 풀린 뒤 다음 호출이 밀린 항목을 쓸어담는다
    await fs.rm(lockPath, { force: true });
    await gs.commitAndPush('catch-up run');

    const { stdout } = await run('git', ['ls-files'], { cwd: dir });
    expect(stdout).toContain('deferred.md');
  }, 30000);

  it('does not commit the lock file', async () => {
    const { base, remote } = await createSeedRemote('gs-lockignore-');
    const dir = path.join(base, 'local');
    const gs = new GitSync(dir, remote);
    await gs.ensureRepo();
    await configureGitIdentity(dir);

    await fs.writeFile(path.join(dir, 'entry2.md'), md(1100, 'e2'), 'utf8');
    await gs.commitAndPush('with lock ignored');

    const { stdout } = await run('git', ['ls-files'], { cwd: dir });
    expect(stdout).not.toContain('.private-journal-sync.lock');
  }, 30000);

  it('does not deadlock when commitAndPush internally pulls', async () => {
    const { base, remote, branch } = await createSeedRemote('gs-deadlock-');
    const local = path.join(base, 'local');
    const peer = path.join(base, 'peer');
    await run('git', ['clone', remote, local]);
    await run('git', ['clone', remote, peer]);
    await configureGitIdentity(local);
    await configureGitIdentity(peer);

    // peer가 먼저 원격에 push해서 원격이 로컬보다 앞서게 만든다 (충돌은 피하도록 별도 파일)
    await fs.writeFile(path.join(peer, 'peer.md'), md(1150, 'from peer'), 'utf8');
    await run('git', ['add', 'peer.md'], { cwd: peer });
    await run('git', ['commit', '-m', 'peer push'], { cwd: peer });
    await run('git', ['push', 'origin', branch], { cwd: peer });

    const gs = new GitSync(local, remote);
    await fs.writeFile(path.join(local, 'pushed.md'), md(1200, 'pushed'), 'utf8');
    await gs.commitAndPush('should actually push');

    // push가 실제로 성공했다 (내부 pull이 데드락으로 skip됐다면 non-fast-forward로 거부된다)
    const { stdout } = await run('git', ['log', '--oneline', `origin/${branch}`], { cwd: local });
    expect(stdout).toContain('should actually push');

    // 내부 pull이 실제로 돌아서 peer의 변경을 작업 트리에 받아왔다
    await expect(fs.access(path.join(local, 'peer.md'))).resolves.toBeUndefined();
  }, 30000);
});

describe('GitSync multi-machine concurrency', () => {
  it('preserves entries from two machines pushing alternately', async () => {
    const { base, remote } = await createSeedRemote('gs-multi-');
    const machineA = path.join(base, 'machineA');
    const machineB = path.join(base, 'machineB');

    const gsA = new GitSync(machineA, remote);
    const gsB = new GitSync(machineB, remote);
    await gsA.ensureRepo();
    await gsB.ensureRepo();
    await configureGitIdentity(machineA);
    await configureGitIdentity(machineB);

    // 각 기기가 서로 다른 파일명으로 항목을 쓴다 (실제로는 마이크로초 접미사)
    await fs.writeFile(path.join(machineA, 'a-000001.md'), md(2000, 'from A'), 'utf8');
    await fs.writeFile(path.join(machineB, 'b-000002.md'), md(2001, 'from B'), 'utf8');

    // 번갈아 push — B는 A가 먼저 올린 것을 rebase해야 한다
    await gsA.commitAndPush('entry from A');
    await gsB.commitAndPush('entry from B');

    // 세 번째 클론에서 확인: 양쪽 항목이 모두 살아있다
    const verify = path.join(base, 'verify');
    await run('git', ['clone', remote, verify]);
    const files = await fs.readdir(verify);
    expect(files).toContain('a-000001.md');
    expect(files).toContain('b-000002.md');

    // rebase가 깨끗하게 끝났다
    await expect(fs.access(path.join(machineB, '.git', 'rebase-merge'))).rejects.toBeDefined();
    await expect(fs.access(path.join(machineB, '.git', 'rebase-apply'))).rejects.toBeDefined();
  }, 60000);

  it('converges when both machines push before pulling', async () => {
    const { base, remote } = await createSeedRemote('gs-race-');
    const machineA = path.join(base, 'machineA');
    const machineB = path.join(base, 'machineB');

    const gsA = new GitSync(machineA, remote);
    const gsB = new GitSync(machineB, remote);
    await gsA.ensureRepo();
    await gsB.ensureRepo();
    await configureGitIdentity(machineA);
    await configureGitIdentity(machineB);

    // 양쪽이 서로를 모르는 상태에서 각각 쓴다
    await fs.writeFile(path.join(machineA, 'race-a.md'), md(3000, 'race A'), 'utf8');
    await fs.writeFile(path.join(machineB, 'race-b.md'), md(3001, 'race B'), 'utf8');

    // 동시에 push 시도 — 한쪽은 반드시 거부당하고 재시도로 수습해야 한다
    await Promise.all([
      gsA.commitAndPush('race from A'),
      gsB.commitAndPush('race from B'),
    ]);

    // 뒤처진 쪽이 따라잡을 기회를 준다
    await gsA.commitAndPush('catch up A');
    await gsB.commitAndPush('catch up B');

    const verify = path.join(base, 'verify');
    await run('git', ['clone', remote, verify]);
    const files = await fs.readdir(verify);
    expect(files).toContain('race-a.md');
    expect(files).toContain('race-b.md');
  }, 60000);
});
