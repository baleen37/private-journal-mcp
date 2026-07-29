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
exports.GitSync = void 0;
exports.resolveGitTimeoutMs = resolveGitTimeoutMs;
exports.chooseConflictWinner = chooseConflictWinner;
const child_process_1 = require("child_process");
const util_1 = require("util");
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const journal_1 = require("./journal");
const run = (0, util_1.promisify)(child_process_1.execFile);
const gitEnv = { ...process.env, GIT_EDITOR: process.env.GIT_EDITOR ?? 'true' };
const DEFAULT_GIT_TIMEOUT_MS = 10000;
const LOCK_FILENAME = '.private-journal-sync.lock';
const EMBEDDING_EXT = '.embedding';
const EMBEDDING_GLOB = `*${EMBEDDING_EXT}`;
const STALE_LOCK_MS = 120000;
const PUSH_RETRY_LIMIT = 5;
function resolveGitTimeoutMs(env = process.env) {
    const raw = env.PRIVATE_JOURNAL_GIT_TIMEOUT_MS;
    if (!raw)
        return DEFAULT_GIT_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return DEFAULT_GIT_TIMEOUT_MS;
    return parsed;
}
function gitErrorText(error) {
    if (error && typeof error === 'object') {
        const stderr = 'stderr' in error ? error.stderr : undefined;
        if (typeof stderr === 'string' && stderr.trim())
            return stderr.trim();
        const stdout = 'stdout' in error ? error.stdout : undefined;
        if (typeof stdout === 'string' && stdout.trim())
            return stdout.trim();
    }
    if (error instanceof Error)
        return error.message;
    return String(error);
}
function isNothingToCommitError(error) {
    return /nothing (added to commit|to commit)/i.test(gitErrorText(error));
}
function isRebaseConflictError(error) {
    return /(conflict|could not apply|resolve all conflicts manually|fix conflicts)/i.test(gitErrorText(error));
}
// fetch가 요청한 ref를 찾지 못한 경우. 이 메시지만으로는 "새 remote"인지
// "브랜치명 오타"인지 구분할 수 없으므로 호출부에서 remote 상태를 함께 확인한다.
function isMissingRemoteBranchError(error) {
    return /couldn't find remote ref|no such ref was fetched/i.test(gitErrorText(error));
}
function logGitFailure(prefix, error) {
    console.error(prefix, gitErrorText(error));
}
function chooseConflictWinner(oursMd, theirsMd) {
    const ours = (0, journal_1.parseFrontmatter)(oursMd).timestamp;
    const theirs = (0, journal_1.parseFrontmatter)(theirsMd).timestamp;
    return theirs > ours ? 'theirs' : 'ours';
}
class GitSync {
    dataPath;
    remote;
    constructor(dataPath, remote) {
        this.dataPath = dataPath;
        this.remote = remote;
    }
    get enabled() {
        return !!this.remote;
    }
    async git(args) {
        return run('git', args, { cwd: this.dataPath, env: gitEnv });
    }
    async gitAt(cwd, args) {
        return run('git', args, { cwd, env: gitEnv });
    }
    async runNet(args, cwd = this.dataPath) {
        return run('git', args, {
            cwd,
            env: gitEnv,
            timeout: resolveGitTimeoutMs(),
        });
    }
    async hasGitDir() {
        return fs.access(path.join(this.dataPath, '.git')).then(() => true).catch(() => false);
    }
    get lockPath() {
        return path.join(this.dataPath, LOCK_FILENAME);
    }
    async isStaleLock() {
        try {
            const raw = await fs.readFile(this.lockPath, 'utf8');
            const { acquiredAt } = JSON.parse(raw);
            if (typeof acquiredAt !== 'number')
                return true;
            return Date.now() - acquiredAt > STALE_LOCK_MS;
        }
        catch {
            // 읽을 수 없거나 깨진 록은 stale로 본다
            return true;
        }
    }
    async acquireLock() {
        const payload = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
        try {
            await fs.mkdir(this.dataPath, { recursive: true });
            await fs.writeFile(this.lockPath, payload, { encoding: 'utf8', flag: 'wx' });
            return true;
        }
        catch {
            if (!(await this.isStaleLock()))
                return false;
            try {
                await fs.writeFile(this.lockPath, payload, 'utf8');
                console.error('[private-journal] stole stale sync lock');
                return true;
            }
            catch {
                return false;
            }
        }
    }
    async withLock(fn) {
        if (!(await this.acquireLock())) {
            console.error('[private-journal] sync already in progress, skipping');
            return undefined;
        }
        try {
            return await fn();
        }
        finally {
            await fs.rm(this.lockPath, { force: true }).catch(() => { });
        }
    }
    async ensureRepo() {
        if (!this.enabled)
            return;
        if (await this.hasGitDir()) {
            await this.ensureRepoMetadata();
            return;
        }
        try {
            await fs.mkdir(this.dataPath, { recursive: true });
            try {
                const { stdout } = await this.runNet(['ls-remote', this.remote]);
                if (stdout.trim().length > 0) {
                    await this.clonePopulatedRemote();
                    await this.ensureRepoMetadata();
                    return;
                }
                await this.git(['init']);
                await this.git(['remote', 'add', 'origin', this.remote]);
                await this.ensureRepoMetadata();
            }
            catch (err) {
                logGitFailure('[private-journal] git ls-remote failed (best-effort):', err);
                return;
            }
        }
        catch (err) {
            logGitFailure('[private-journal] git ensureRepo failed (best-effort):', err);
        }
    }
    async ensureRepoMetadata() {
        try {
            const attrsPath = path.join(this.dataPath, '.gitattributes');
            if (!(await this.pathExists(attrsPath))) {
                await fs.writeFile(attrsPath, '*.embedding binary\n', 'utf8');
            }
        }
        catch (err) {
            logGitFailure('[private-journal] gitattributes setup failed (best-effort):', err);
        }
        // 록 파일과 파생 임베딩은 데이터 repo에 커밋되면 안 된다.
        // .gitignore가 아니라 .git/info/exclude를 쓴다 — 사용자의 .gitignore를 건드리지 않고
        // 원격에 퍼지지도 않는다.
        //
        // .embedding은 md에서 언제든 재생성되는 파생물이고(1000건 약 25초),
        // 부동소수 JSON이라 델타 압축이 거의 안 먹어 커밋마다 통째로 쌓인다.
        // 히스토리 증가는 영구적이지만 재생성 비용은 일회성이라 제외가 유리하다.
        // 이미 추적 중인 임베딩은 pruneTrackedEmbeddings()가 인덱스에서 뺀다.
        const excludePath = path.join(this.dataPath, '.git', 'info', 'exclude');
        try {
            await fs.mkdir(path.dirname(excludePath), { recursive: true });
            let current = '';
            try {
                current = await fs.readFile(excludePath, 'utf8');
            }
            catch { /* 파일이 없으면 새로 만든다 */ }
            const needed = [LOCK_FILENAME, EMBEDDING_GLOB].filter((rule) => !current.includes(rule));
            if (needed.length > 0) {
                await fs.appendFile(excludePath, `\n${needed.join('\n')}\n`, 'utf8');
            }
        }
        catch (err) {
            logGitFailure('[private-journal] git exclude setup failed (best-effort):', err);
        }
        await this.pruneTrackedEmbeddings();
    }
    // 과거 커밋에 이미 들어간 .embedding을 인덱스에서만 제거한다. 작업 트리
    // 파일은 남겨서 검색이 즉시 계속 동작하고, 다음 커밋부터 추적이 끊긴다.
    async pruneTrackedEmbeddings() {
        try {
            const { stdout } = await this.git(['ls-files', '-z', '--', `*${EMBEDDING_EXT}`]);
            const tracked = stdout.split('\0').filter((entry) => entry.length > 0);
            if (tracked.length === 0)
                return;
            await this.git(['rm', '--cached', '--quiet', '--', ...tracked]);
            console.error(`[private-journal] untracked ${tracked.length} derived .embedding file(s); local copies kept`);
        }
        catch (err) {
            logGitFailure('[private-journal] embedding untracking failed (best-effort):', err);
        }
    }
    async pathExists(targetPath) {
        return fs.access(targetPath).then(() => true).catch(() => false);
    }
    async shouldReplaceMarkdownFile(localPath, remotePath) {
        const [localMd, remoteMd] = await Promise.all([
            fs.readFile(localPath, 'utf8'),
            fs.readFile(remotePath, 'utf8'),
        ]);
        return chooseConflictWinner(localMd, remoteMd) === 'theirs';
    }
    async deleteEmbeddingForMarkdown(mdPath) {
        try {
            await fs.rm(mdPath.replace(/\.md$/, '.embedding'), { force: true });
        }
        catch (err) {
            logGitFailure('[private-journal] embedding cleanup failed (best-effort):', err);
        }
    }
    async defaultRemoteBranch() {
        try {
            const { stdout } = await this.runNet(['ls-remote', '--symref', this.remote, 'HEAD']);
            const m = stdout.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
            if (m)
                return m[1];
        }
        catch { /* ignore */ }
        return 'main';
    }
    async isTrackedPath(rel) {
        try {
            await this.git(['ls-files', '--error-unmatch', '--', rel]);
            return true;
        }
        catch {
            return false;
        }
    }
    async remoteBranches(repoPath = this.dataPath) {
        const { stdout } = await this.gitAt(repoPath, ['for-each-ref', '--format=%(refname:strip=3)', 'refs/remotes/origin']);
        return stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && line !== 'HEAD');
    }
    async checkoutableRemoteBranch(repoPath = this.dataPath) {
        const preferred = await this.defaultRemoteBranch();
        const branches = await this.remoteBranches(repoPath);
        if (branches.includes(preferred))
            return preferred;
        return branches[0];
    }
    async clonePopulatedRemote() {
        const parentDir = await fs.mkdtemp(path.join(path.dirname(this.dataPath), '.private-journal-clone-'));
        const clonePath = path.join(parentDir, 'repo');
        try {
            await this.runNet(['clone', '--no-checkout', this.remote, clonePath]);
            const branch = await this.checkoutableRemoteBranch(clonePath);
            if (!branch) {
                console.error('[private-journal] git clone found no remote branches (best-effort)');
                return;
            }
            await this.gitAt(clonePath, ['checkout', '-B', branch, `origin/${branch}`]);
            await fs.rename(path.join(clonePath, '.git'), path.join(this.dataPath, '.git'));
            await this.mergeDirectoryContents(clonePath, this.dataPath);
        }
        finally {
            await fs.rm(parentDir, { recursive: true, force: true });
        }
    }
    async mergeDirectoryContents(fromDir, toDir) {
        const entries = await fs.readdir(fromDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.git')
                continue;
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
    async currentBranch() {
        try {
            const { stdout } = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']);
            const b = stdout.trim();
            if (b && b !== 'HEAD')
                return b;
        }
        catch { /* ignore */ }
        return 'main';
    }
    async pull() {
        if (!this.enabled)
            return;
        if (!(await this.hasGitDir()))
            return;
        await this.withLock(() => this.pullUnlocked());
    }
    // remote에 브랜치가 하나도 없으면 아직 아무것도 push하지 않은 새 repo다.
    // 확인 자체가 실패하면 침묵하지 않는다(false) — 판단이 안 될 때는 로그를 남긴다.
    async remoteHasNoBranches() {
        try {
            const { stdout } = await this.runNet(['ls-remote', '--heads', this.remote]);
            return stdout.trim().length === 0;
        }
        catch {
            return false;
        }
    }
    async pullUnlocked() {
        try {
            const branch = await this.currentBranch();
            await this.runNet(['fetch', 'origin', branch]);
            await this.git(['rebase', '--autostash', `origin/${branch}`]);
        }
        catch (err) {
            if (isRebaseConflictError(err)) {
                await this.resolveRebaseConflicts();
                return;
            }
            // 아직 아무것도 push하지 않은 새 remote에는 브랜치가 없다. 실패가 아니라
            // 정상 상태이므로 조용히 넘어간다 — 첫 세션마다 에러가 보이면 사용자가
            // 설정이 잘못된 줄 안다.
            //
            // 단 에러 메시지만으로는 "새 remote"와 "브랜치명 오타" / "서버에서 브랜치
            // 삭제됨"을 구분할 수 없다(git이 같은 문자열을 낸다). 오타는 사용자가
            // 반드시 알아야 하므로, remote에 브랜치가 하나도 없을 때만 침묵한다.
            if (isMissingRemoteBranchError(err) && (await this.remoteHasNoBranches()))
                return;
            console.error('[private-journal] git pull failed (best-effort):', gitErrorText(err));
        }
    }
    async resolveRebaseConflicts() {
        // loop until rebase done or unresolvable
        for (let i = 0; i < 100; i++) {
            let conflicted = [];
            try {
                const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
                conflicted = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
            }
            catch (err) {
                logGitFailure('[private-journal] git conflict scan failed (best-effort):', err);
                break;
            }
            if (conflicted.length === 0)
                break;
            for (const rel of conflicted) {
                if (rel.endsWith('.md')) {
                    await this.resolveMdConflict(rel);
                }
                else {
                    // .embedding or other: take ours, will be regenerated/ignored
                    try {
                        await this.git(['checkout', '--ours', '--', rel]);
                    }
                    catch (err) {
                        logGitFailure('[private-journal] git conflict checkout failed (best-effort):', err);
                    }
                    try {
                        await this.git(['add', '--', rel]);
                    }
                    catch (err) {
                        logGitFailure('[private-journal] git conflict add failed (best-effort):', err);
                    }
                }
            }
            try {
                await this.git(['rebase', '--continue']);
                break;
            }
            catch (err) {
                logGitFailure('[private-journal] git rebase continue failed (best-effort):', err);
                // more conflicts in next commit; loop again
                continue;
            }
        }
        await this.logUnresolvedRebaseState();
    }
    async resolveMdConflict(rel) {
        const rebaseInProgress = await this.hasRebaseInProgress();
        let stage2 = '';
        let stage3 = '';
        try {
            stage2 = (await this.git(['show', `:2:${rel}`])).stdout;
        }
        catch (err) {
            logGitFailure('[private-journal] git show ours failed (best-effort):', err);
        }
        try {
            stage3 = (await this.git(['show', `:3:${rel}`])).stdout;
        }
        catch (err) {
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
        }
        catch (err) {
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
        }
        catch (err) {
            logGitFailure('[private-journal] git markdown conflict add failed (best-effort):', err);
        }
    }
    async logUnresolvedRebaseState() {
        const rebaseInProgress = await this.hasRebaseInProgress();
        try {
            const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
            const conflicted = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
            if (rebaseInProgress || conflicted.length > 0) {
                console.error('[private-journal] git rebase still unresolved after conflict handling (best-effort)');
            }
        }
        catch (err) {
            logGitFailure('[private-journal] git conflict state check failed (best-effort):', err);
            if (rebaseInProgress) {
                console.error('[private-journal] git rebase still unresolved after conflict handling (best-effort)');
            }
        }
    }
    async hasRebaseInProgress() {
        const gitDir = path.join(this.dataPath, '.git');
        const rebaseApply = fs.access(path.join(gitDir, 'rebase-apply')).then(() => true).catch(() => false);
        const rebaseMerge = fs.access(path.join(gitDir, 'rebase-merge')).then(() => true).catch(() => false);
        const [applyExists, mergeExists] = await Promise.all([rebaseApply, rebaseMerge]);
        return applyExists || mergeExists;
    }
    async abortIfIndexUnmerged() {
        try {
            const { stdout } = await this.git(['diff', '--name-only', '--diff-filter=U']);
            if (!stdout.trim())
                return;
            console.error('[private-journal] index still has unmerged paths; resetting to avoid committing conflict markers');
            await this.git(['reset', '--mixed', 'HEAD']);
        }
        catch (err) {
            logGitFailure('[private-journal] unmerged index check failed (best-effort):', err);
        }
    }
    async recoverFromInterruptedRebase() {
        if (!(await this.hasRebaseInProgress()))
            return;
        console.error('[private-journal] found interrupted rebase, recovering');
        await this.resolveRebaseConflicts();
        if (!(await this.hasRebaseInProgress()))
            return;
        try {
            await this.git(['rebase', '--abort']);
            console.error('[private-journal] aborted unrecoverable rebase (local commits preserved)');
        }
        catch (err) {
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
            }
            catch (cleanupErr) {
                logGitFailure('[private-journal] cleanup of rebase directories failed (best-effort):', cleanupErr);
            }
        }
    }
    async commitAndPush(message) {
        if (!this.enabled)
            return;
        await this.withLock(() => this.commitAndPushUnlocked(message));
    }
    async commitAndPushUnlocked(message) {
        try {
            await this.ensureRepo();
            await this.recoverFromInterruptedRebase();
            await this.abortIfIndexUnmerged();
            await this.git(['add', '-A']);
            try {
                await this.git(['commit', '-m', message]);
            }
            catch (err) {
                if (isNothingToCommitError(err)) {
                    // 올릴 것이 없어도 받을 것은 있을 수 있다. 여기서 그냥 리턴하면
                    // 쓰기가 없는 기기(주로 읽기만 하는 기기)는 원격 변경을 영구히
                    // 받지 못한다. push 루프를 건너뛰되 pull은 반드시 한다.
                    await this.pullUnlocked();
                    return;
                }
                logGitFailure('[private-journal] git commit failed (best-effort):', err);
                return;
            }
            const branch = await this.currentBranch();
            for (let attempt = 0; attempt < PUSH_RETRY_LIMIT; attempt++) {
                await this.pullUnlocked();
                try {
                    await this.runNet(['push', '-u', 'origin', branch]);
                    return;
                }
                catch (err) {
                    if (attempt === PUSH_RETRY_LIMIT - 1) {
                        logGitFailure('[private-journal] git push failed (best-effort):', err);
                        return;
                    }
                    // 지수 백오프: 100ms, 200ms, 400ms, 800ms
                    const delay = 100 * 2 ** attempt;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        catch (err) {
            logGitFailure('[private-journal] git sync failed (best-effort):', err);
        }
    }
}
exports.GitSync = GitSync;
