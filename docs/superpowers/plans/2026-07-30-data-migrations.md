# Data Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 저널 데이터를 순차적으로 마이그레이션하고, 여러 컴퓨터의 서로 다른 앱 버전이 신버전 포맷을 손상시키지 못하게 한다.

**Architecture:** `MigrationManager`가 데이터 루트의 버전 파일과 단계별 변환을 관리하고, 모든 변환은 sibling stage 디렉터리에서 완료한 뒤 트랜잭션 방식으로 활성화한다. `GitSync`는 원격 버전을 fetch 단계에서 검사하고, 서버와 sync CLI는 pull → migration → backfill → commit/push 순서로 이 호환성 장벽을 통과한다.

**Tech Stack:** TypeScript 5, Node.js `fs/promises`, Jest 29, Git CLI

## Global Constraints

- 데이터 버전은 `.private-journal-version.json`의 `{ "version": number }`이며 최초 포맷은 `1`이다.
- 마이그레이션은 `n -> n + 1`만 수행하며, 데이터 다운그레이드는 절대 하지 않는다.
- 변환 실패와 지원하지 않는 미래 버전은 원본을 보존하고 MCP transport 연결 전에 실패한다.
- `.embedding`은 Git에 올리지 않는 파생 캐시다. 변환된 Markdown의 sidecar만 무효화하고 백필로 재생성한다.
- 데이터 변환과 버전 파일 변경은 같은 Git 커밋에 포함한다.
- 원격 데이터 버전이 현재 앱보다 높거나 원격 버전을 확인할 수 없으면 push하지 않는다.
- 버전 파일 Git 충돌은 자동 해결하지 않는다.

---

## 파일 구조

- Create: `src/migrations.ts` — 버전 파일 파싱, 단계 레지스트리, stage/backup 트랜잭션, 중단 복구
- Create: `test/migrations.test.ts` — 마이그레이션 엔진의 단위·파일시스템 회귀 테스트
- Modify: `src/git-sync.ts` — 원격 버전 preflight와 버전 파일 충돌 차단
- Modify: `test/git-sync.test.ts` — 실제 bare remote를 사용한 혼합 버전 동기화 테스트
- Modify: `src/server.ts` — 시작과 쓰기 직전의 pull/migration 준비 흐름
- Modify: `src/index.ts` — `sync` CLI의 pull/migration/commit 순서
- Modify: `test/server.test.ts` — 서버 준비 실패 시 transport를 열지 않는 테스트
- Modify: `test/index.test.ts` — sync CLI의 마이그레이션 순서 테스트
- Modify: `README.md` — 혼합 버전 장치의 업데이트 필요 동작 한 단락

### Task 1: 버전 문서와 순차 마이그레이션 엔진

**Files:**

- Create: `src/migrations.ts`
- Create: `test/migrations.test.ts`

**Interfaces:**

- Produces: `export const CURRENT_DATA_VERSION = 1`
- Produces: `export const DATA_VERSION_FILENAME = '.private-journal-version.json'`
- Produces: `export class DataVersionError extends Error`
- Produces: `export interface MigrationResult { invalidatedMarkdownPaths: string[]; invalidateAllEmbeddings?: boolean }`
- Produces: `export interface Migration { from: number; to: number; apply(stagePath: string): Promise<MigrationResult> }`
- Produces: `export class MigrationManager { constructor(dataPath: string, migrations?: Migration[], currentVersion?: number); run(): Promise<void>; readVersion(): Promise<number> }`
- Consumes: 후속 Task는 `CURRENT_DATA_VERSION`, `DataVersionError`, `MigrationManager.run()`을 사용한다.

- [ ] **Step 1: 버전 초기화와 순차 변환의 실패 테스트를 작성한다**

```ts
import { MigrationManager, type Migration } from '../src/migrations';

it('initializes a versionless existing data directory at version 1', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, 'entry.md'), '# existing\n', 'utf8');

  await new MigrationManager(dir).run();

  await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
    .resolves.toBe('{"version":1}\n');
});

it('applies each consecutive migration in order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
  const calls: string[] = [];
  const migrations: Migration[] = [
    { from: 1, to: 2, apply: async () => { calls.push('1->2'); return { invalidatedMarkdownPaths: [] }; } },
    { from: 2, to: 3, apply: async () => { calls.push('2->3'); return { invalidatedMarkdownPaths: [] }; } },
  ];

  await new MigrationManager(dir, migrations, 3).run();

  expect(calls).toEqual(['1->2', '2->3']);
  await expect(fs.readFile(path.join(dir, '.private-journal-version.json'), 'utf8'))
    .resolves.toBe('{"version":3}\n');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --runInBand test/migrations.test.ts`

Expected: FAIL because `../src/migrations` does not exist.

- [ ] **Step 3: 최소 버전 API와 레지스트리 검증을 구현한다**

```ts
export const CURRENT_DATA_VERSION = 1;
export const DATA_VERSION_FILENAME = '.private-journal-version.json';

export class DataVersionError extends Error {}

export interface MigrationResult {
  invalidatedMarkdownPaths: string[];
  invalidateAllEmbeddings?: boolean;
}

export interface Migration {
  from: number;
  to: number;
  apply(stagePath: string): Promise<MigrationResult>;
}
```

`readVersion()`은 없는 파일을 `1`로 취급하고, 존재하는 파일은 JSON 객체의 양의 정수
`version`만 수용한다. `run()`은 현재 버전보다 높은 데이터, 누락된 다음 단계, 또는
`from/to`가 연속되지 않은 레지스트리에 `DataVersionError`를 던진다. 현재 버전이
`1`이고 버전 파일만 없는 경우에는 stage 없이 정확히 `{"version":1}\n`만 기록한다.

- [ ] **Step 4: 오류 경계 테스트를 추가한다**

```ts
it.each(['not json', '{"version":0}', '{"version":1.5}', '{"version":"2"}'])
('rejects malformed version metadata: %s', async (raw) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), raw, 'utf8');
  await expect(new MigrationManager(dir).run()).rejects.toThrow(DataVersionError);
});

it('rejects future data without changing its version file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const versionPath = path.join(dir, '.private-journal-version.json');
  await fs.writeFile(versionPath, '{"version":2}\n', 'utf8');
  await expect(new MigrationManager(dir).run()).rejects.toThrow('newer than this app');
  await expect(fs.readFile(versionPath, 'utf8')).resolves.toBe('{"version":2}\n');
});
```

- [ ] **Step 5: Task 1 테스트를 통과시킨다**

Run: `npm test -- --runInBand test/migrations.test.ts`

Expected: PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add src/migrations.ts test/migrations.test.ts
git commit -m "feat: add data version registry"
```

### Task 2: stage 활성화, sidecar 무효화, 중단 복구

**Files:**

- Modify: `src/migrations.ts`
- Modify: `test/migrations.test.ts`

**Interfaces:**

- Consumes: Task 1의 `Migration`, `MigrationResult`, `MigrationManager`.
- Produces: `MigrationManager.run()`은 변환 전 원본을 sibling stage에 복사하고 성공 시에만 활성화한다.
- Produces: `MIGRATION_TRANSACTION_FILENAME = '.private-journal-migration-transaction.json'`은 데이터 루트의 부모에만 존재한다.

- [ ] **Step 1: stage 실패가 원본을 보존한다는 테스트를 작성한다**

```ts
it('leaves the original markdown, metadata, and embedding intact when stage migration fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  const mdPath = path.join(dir, 'entry.md');
  await fs.writeFile(mdPath, 'old format', 'utf8');
  await fs.writeFile(path.join(dir, 'entry.embedding'), 'old embedding', 'utf8');
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n', 'utf8');
  const failing: Migration = { from: 1, to: 2, apply: async (stage) => {
    await fs.writeFile(path.join(stage, 'entry.md'), 'partially changed', 'utf8');
    throw new Error('cannot convert entry.md');
  } };

  await expect(new MigrationManager(dir, [failing], 2).run()).rejects.toThrow('cannot convert entry.md');
  await expect(fs.readFile(mdPath, 'utf8')).resolves.toBe('old format');
  await expect(fs.readFile(path.join(dir, 'entry.embedding'), 'utf8')).resolves.toBe('old embedding');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --runInBand test/migrations.test.ts -t "leaves the original"`

Expected: FAIL because Task 1 does not yet execute transformations in a stage directory.

- [ ] **Step 3: 트랜잭션 활성화와 복구를 구현한다**

`run()`에서 변환이 필요하면 `fs.mkdtemp(path.join(dirname(dataPath), '.private-journal-migrate-'))`
로 stage를 만든다. `.git`과 `.private-journal-sync.lock`만 제외하고 데이터 루트를 stage로
복사한다. 모든 migration이 stage에서 성공한 뒤 stage 버전 파일을 기록한다.

부모 디렉터리의 트랜잭션 문서는 다음 형태로 쓴다.

```ts
type MigrationTransaction = {
  state: 'prepared' | 'backed-up' | 'activated';
  dataPath: string;
  stagePath: string;
  backupPath: string;
};
```

`prepared`를 기록한 뒤 데이터 루트의 `.git`과 migration lock을 제외한 내용을 backup으로
`rename`하고 `backed-up`을 기록한다. stage 내용을 데이터 루트로 `rename`하고 `activated`를
기록한다. 마지막으로 backup, stage, 트랜잭션 문서를 제거한다. 다음 `run()`의 첫 동작은
트랜잭션 문서를 검사하는 것이다. `prepared`와 `backed-up`은 backup을 원본으로 복원하고,
`activated`는 새 데이터가 완성된 것으로 보고 backup만 정리한다. 경로가 `dirname(dataPath)`
밖이면 `DataVersionError`로 중단한다.

- [ ] **Step 4: sidecar와 복구 회귀 테스트를 작성한다**

```ts
it('removes only the sidecar for markdown changed by a successful migration', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-'));
  await fs.writeFile(path.join(dir, '.private-journal-version.json'), '{"version":1}\n');
  await fs.writeFile(path.join(dir, 'changed.md'), 'old', 'utf8');
  await fs.writeFile(path.join(dir, 'changed.embedding'), 'old sidecar', 'utf8');
  await fs.writeFile(path.join(dir, 'unchanged.md'), 'steady', 'utf8');
  await fs.writeFile(path.join(dir, 'unchanged.embedding'), 'steady sidecar', 'utf8');
  const change: Migration = { from: 1, to: 2, apply: async (stage) => {
    await fs.writeFile(path.join(stage, 'changed.md'), 'new', 'utf8');
    return { invalidatedMarkdownPaths: ['changed.md'] };
  } };
  await new MigrationManager(dir, [change], 2).run();
  await expect(fs.access(path.join(dir, 'changed.embedding'))).rejects.toBeDefined();
  await expect(fs.readFile(path.join(dir, 'unchanged.embedding'), 'utf8')).resolves.toBe('steady sidecar');
});

it('restores the backup after an interrupted backed-up activation', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-parent-'));
  const dataPath = path.join(parent, 'data');
  const backupPath = path.join(parent, 'backup');
  const stagePath = path.join(parent, 'stage');
  const transactionPath = path.join(parent, MIGRATION_TRANSACTION_FILENAME);
  await Promise.all([fs.mkdir(dataPath), fs.mkdir(backupPath), fs.mkdir(stagePath)]);
  await fs.writeFile(path.join(backupPath, 'entry.md'), 'original', 'utf8');
  await fs.writeFile(path.join(backupPath, '.private-journal-version.json'), '{"version":1}\n');
  await fs.writeFile(path.join(stagePath, 'entry.md'), 'migrated', 'utf8');
  await fs.writeFile(transactionPath, JSON.stringify({
    state: 'backed-up', dataPath, backupPath, stagePath,
  }), 'utf8');

  await new MigrationManager(dataPath).run();

  await expect(fs.readFile(path.join(dataPath, 'entry.md'), 'utf8')).resolves.toBe('original');
  await expect(fs.access(transactionPath)).rejects.toBeDefined();
});
```

`invalidatedMarkdownPaths`의 값은 stage 기준 상대 `.md` 경로만 수용한다. 절대 경로,
`..` 경로, `.md`가 아닌 항목은 `DataVersionError`로 중단한다. `invalidateAllEmbeddings`가
참이면 stage의 `.embedding` 파일을 모두 제거한다.

- [ ] **Step 5: Task 2 테스트를 통과시킨다**

Run: `npm test -- --runInBand test/migrations.test.ts`

Expected: PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add src/migrations.ts test/migrations.test.ts
git commit -m "feat: migrate journal data transactionally"
```

### Task 3: Git 원격 버전 호환성 장벽

**Files:**

- Modify: `src/git-sync.ts`
- Modify: `test/git-sync.test.ts`

**Interfaces:**

- Consumes: Task 1의 `CURRENT_DATA_VERSION`, `DATA_VERSION_FILENAME`, `DataVersionError`.
- Produces: `GitSync.pull(supportedVersion?: number): Promise<string[]>`.
- Produces: `GitSync.commitAndPush(message: string, supportedVersion?: number): Promise<string[]>`.
- Produces: `GitSync.assertRemoteVersionSupported(supportedVersion: number): Promise<void>`.

- [ ] **Step 1: 미래 원격 버전과 버전 파일 충돌의 실패 테스트를 작성한다**

```ts
import { DataVersionError } from '../src/migrations';

it('refuses to pull a remote data version newer than the supported version', async () => {
  const { remote, branch, base } = await createSeedRemote('gs-version-');
  const peer = path.join(base, 'peer');
  await run('git', ['clone', remote, peer]);
  await fs.writeFile(path.join(peer, '.private-journal-version.json'), '{"version":2}\n', 'utf8');
  await run('git', ['add', '.private-journal-version.json'], { cwd: peer });
  await run('git', ['commit', '-m', 'data v2'], { cwd: peer });
  await run('git', ['push', 'origin', branch], { cwd: peer });

  const local = path.join(base, 'local');
  await run('git', ['clone', remote, local]);
  const sync = new GitSync(local, remote);
  await expect(sync.pull(1)).rejects.toThrow('newer than this app');
});

it('does not auto-resolve a .private-journal-version.json rebase conflict', async () => {
  const { remote, branch, base } = await createSeedRemote('gs-version-conflict-');
  const seed = path.join(base, 'seed');
  await fs.writeFile(path.join(seed, '.private-journal-version.json'), '{"version":1}\n', 'utf8');
  await run('git', ['add', '.private-journal-version.json'], { cwd: seed });
  await run('git', ['commit', '-m', 'data v1'], { cwd: seed });
  await run('git', ['push', 'origin', branch], { cwd: seed });
  const local = path.join(base, 'local');
  const peer = path.join(base, 'peer');
  await Promise.all([run('git', ['clone', remote, local]), run('git', ['clone', remote, peer])]);
  await fs.writeFile(path.join(peer, '.private-journal-version.json'), '{"version":2}\n', 'utf8');
  await run('git', ['commit', '-am', 'peer v2'], { cwd: peer });
  await run('git', ['push', 'origin', branch], { cwd: peer });
  await fs.writeFile(path.join(local, '.private-journal-version.json'), '{"version":3}\n', 'utf8');
  await run('git', ['commit', '-am', 'local v3'], { cwd: local });

  await expect(new GitSync(local, remote).pull(3)).rejects.toThrow(DataVersionError);
  const { stdout } = await run('git', ['diff', '--name-only', '--diff-filter=U'], { cwd: local });
  expect(stdout).toContain('.private-journal-version.json');
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --runInBand test/git-sync.test.ts -t "newer than the supported|does not auto-resolve"`

Expected: FAIL because GitSync가 원격 버전을 해석하거나 version-file conflict를 구분하지 않는다.

- [ ] **Step 3: fetch 전용 preflight와 충돌 차단을 구현한다**

`assertRemoteVersionSupported()`는 현재 branch를 fetch한 다음
`git show origin/<branch>:.private-journal-version.json`을 읽는다. 파일이 없으면 버전 `1`로
간주하고, malformed JSON은 `DataVersionError`로 거부한다. 원격 버전이 `supportedVersion`보다
크면 `DataVersionError('Journal data version X is newer than this app supports (Y). Update the app.')`
를 던진다.

`pullUnlocked(supportedVersion)`는 fetch, 원격 버전 검사, rebase 순서로 실행하고 `pull()`은
이를 호출한다. `commitAndPush()`는 `git add`와 commit 전에 한 번 검사하고, 각 push 재시도마다
`pullUnlocked(supportedVersion)`를 호출해 rebase 직전에도 다시 검사한다. fetch가 실패하면
`commitAndPush()`는 commit/push를 하지 않고 오류를 호출자에게 전달한다.
`resolveRebaseConflicts()`는 충돌 경로가
`.private-journal-version.json`이면 `checkout --ours/--theirs`와 `git add`를 실행하지 않고
`DataVersionError`를 던진다.

- [ ] **Step 4: 오프라인 로컬 보존과 지원 버전 push의 테스트를 추가한다**

```ts
it('keeps a local entry and does not push when preflight sees a future remote version', async () => {
  const { remote, branch, base } = await createSeedRemote('gs-future-push-');
  const local = path.join(base, 'local');
  const peer = path.join(base, 'peer');
  await Promise.all([run('git', ['clone', remote, local]), run('git', ['clone', remote, peer])]);
  await configureGitIdentity(local);
  await fs.writeFile(path.join(peer, '.private-journal-version.json'), '{"version":2}\n', 'utf8');
  await run('git', ['add', '.private-journal-version.json'], { cwd: peer });
  await run('git', ['commit', '-m', 'data v2'], { cwd: peer });
  await run('git', ['push', 'origin', branch], { cwd: peer });
  await fs.writeFile(path.join(local, 'offline.md'), md(999, 'preserve me'), 'utf8');

  await expect(new GitSync(local, remote).commitAndPush('journal: test', 1)).rejects.toThrow(DataVersionError);
  await expect(fs.readFile(path.join(local, 'offline.md'), 'utf8')).resolves.toContain('preserve me');
  const verify = path.join(base, 'verify');
  await run('git', ['clone', remote, verify]);
  await expect(fs.access(path.join(verify, 'offline.md'))).rejects.toBeDefined();
});

it('pushes when the remote data version is supported', async () => {
  const { remote, base } = await createSeedRemote('gs-supported-push-');
  const local = path.join(base, 'local');
  await run('git', ['clone', remote, local]);
  await configureGitIdentity(local);
  await fs.writeFile(path.join(local, '.private-journal-version.json'), '{"version":1}\n', 'utf8');
  await fs.writeFile(path.join(local, 'fresh.md'), md(1000, 'current format'), 'utf8');

  await new GitSync(local, remote).commitAndPush('journal: test', 1);

  const verify = path.join(base, 'verify');
  await run('git', ['clone', remote, verify]);
  await expect(fs.readFile(path.join(verify, '.private-journal-version.json'), 'utf8'))
    .resolves.toBe('{"version":1}\n');
  await expect(fs.readFile(path.join(verify, 'fresh.md'), 'utf8')).resolves.toContain('current format');
});
```

- [ ] **Step 5: Task 3 테스트를 통과시킨다**

Run: `npm test -- --runInBand test/git-sync.test.ts`

Expected: PASS.

- [ ] **Step 6: 커밋한다**

```bash
git add src/git-sync.ts test/git-sync.test.ts
git commit -m "feat: guard sync by data version"
```

### Task 4: 서버와 sync CLI에 준비 흐름 연결

**Files:**

- Modify: `src/server.ts`
- Modify: `src/index.ts`
- Modify: `test/server.test.ts`
- Modify: `test/index.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: Task 1의 `MigrationManager`, `CURRENT_DATA_VERSION`; Task 3의 version-aware `GitSync.pull()`과 `commitAndPush()`.
- Produces: `PrivateJournalServer.prepareData(): Promise<string[]>` private helper.
- Produces: `runSync()`은 `ensureRepo → pull → migration → backfill → commitAndPush` 순서를 사용한다.

- [ ] **Step 1: 시작·쓰기·CLI 순서의 실패 테스트를 작성한다**

```ts
const migrationsRun = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/migrations', () => ({
  CURRENT_DATA_VERSION: 1,
  DataVersionError: class DataVersionError extends Error {},
  MigrationManager: jest.fn().mockImplementation(() => ({ run: migrationsRun })),
}));

it('does not connect the MCP transport when data migration rejects', async () => {
  const srv = new PrivateJournalServer({ dataPath: '/data' });
  jest.spyOn((srv as any).migrations, 'run').mockRejectedValue(new DataVersionError('update required'));
  const connect = jest.spyOn(McpServer.prototype, 'connect').mockResolvedValue(undefined as never);

  await expect(srv.run()).rejects.toThrow('update required');
  expect(connect).not.toHaveBeenCalled();
});

it('runs migration after pull and before sync commit', async () => {
  await runSync({ dataPath: '/resolved/data/path', remote: 'resolved.git' });
  expect(pull.mock.invocationCallOrder[0]).toBeLessThan(migrationsRun.mock.invocationCallOrder[0]);
  expect(migrationsRun.mock.invocationCallOrder[0]).toBeLessThan(commitAndPush.mock.invocationCallOrder[0]);
});

it('runs migration and backfill even when sync has no remote', async () => {
  await runSync({ dataPath: '/resolved/data/path', remote: undefined });
  expect(migrationsRun).toHaveBeenCalledTimes(1);
  expect(backfill).toHaveBeenCalledTimes(1);
  expect(commitAndPush).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --runInBand test/server.test.ts test/index.test.ts`

Expected: FAIL because `MigrationManager`가 생성·호출되지 않고 `runSync()`가 pull/migration 순서를 갖지 않는다.

- [ ] **Step 3: 하나의 준비 헬퍼로 흐름을 구현한다**

`PrivateJournalServer` 생성자에서 `this.migrations = new MigrationManager(this.dataPath)`를 만든다.
`prepareData()`는 remote가 있을 때 `ensureRepo()`, `pull(CURRENT_DATA_VERSION)`을 호출하고,
그 뒤 `migrations.run()`을 호출한다. `run()`은 backfill과 MCP transport 연결 전에 이 helper를
`await`한다. `handleWrite()`는 `journal.write()` 전에 helper를 호출해 온라인 장치가 원격의
새 버전을 먼저 받게 하고, background sync에는
`commitAndPush(message, CURRENT_DATA_VERSION)`를 전달한다.

`runSync()`도 Git remote가 있을 때 `ensureRepo()`, `pull(CURRENT_DATA_VERSION)`을 실행한 뒤
`migrations.run()`, backfill, `commitAndPush(message, CURRENT_DATA_VERSION)` 순서를 사용한다.
remote가 없어도 `migrations.run()`과 backfill은 실행한다. migration 또는 compatibility 오류는
best-effort 로그로 삼키지 않는다. 네트워크 preflight 오류로 인한 background sync는 기존 entry를
보존하고 오류만 로그한다.

README에는 "같은 저널을 여러 컴퓨터에서 쓸 때 데이터 포맷을 올린 뒤 구버전 앱은 읽기·쓰기
대신 업데이트가 필요하다는 오류를 낸다"는 짧은 호환성 안내를 추가한다.

- [ ] **Step 4: Task 4 테스트를 통과시킨다**

Run: `npm test -- --runInBand test/server.test.ts test/index.test.ts`

Expected: PASS.

- [ ] **Step 5: 전체 검증을 실행한다**

Run: `npm test -- --runInBand && npm run build`

Expected: Jest 전체 PASS 및 TypeScript build 성공.

- [ ] **Step 6: 커밋한다**

```bash
git add src/server.ts src/index.ts README.md test/server.test.ts test/index.test.ts
git commit -m "feat: run migrations before journal access"
```
