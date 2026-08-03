# Task 3 구현 보고서

## 변경 파일

- `README.md`
  - Published package와 local checkout build 경로를 포함한 OpenCode 설치 예시 추가
  - OpenCode native journal tools와 Git remote 환경변수 동작 설명 추가
  - 기존 Claude/Codex 및 manual MCP 안내 유지
- `test/plugin-manifest.test.ts`
  - `main`, CLI `bin`, `exports["./server"]` package 계약 회귀 테스트 추가

## 테스트

- `npx jest --runInBand --runTestsByPath test/plugin-manifest.test.ts -t "OpenCode server entrypoint"`
  - PASS: 1 passed, 1 skipped
- `npx jest --runInBand --runTestsByPath test/plugin-manifest.test.ts test/bin-launcher.test.ts`
  - PASS: 2 suites, 3 tests

## 우려사항

- 없음. Task 2에서 추가된 `exports["./server"]`가 현재 HEAD에 존재함을 계약 테스트로 확인했습니다.

## Fix round: OpenCode 공식 plugin 설치 방식 반영

### 변경

- OpenCode published package 안내를 `opencode.json`의 `plugin` 배열 방식으로 변경
- 기존 CLI 설치 예시를 제거
- local checkout 안내를 `npm install && npm run build` 후 프로젝트
  `.opencode/plugins/`에 `opencode-plugin.mjs`를 symlink하는 방식으로 변경
- package contract 테스트 이름을 실제 package entrypoint 검사 범위에 맞게 수정
- Claude/Codex/manual MCP 안내는 유지

### 검증

- `npx jest --runInBand --runTestsByPath test/plugin-manifest.test.ts test/bin-launcher.test.ts`
  - PASS: 2 suites, 3 tests
- `git diff --check`
  - PASS: `README.md` diff clean

### 우려사항

- 없음. OpenCode 공식 plugin 문서의 npm config 및 local plugin directory 방식에 맞췄습니다.

## Fix round 2: OpenCode local plugin filename discovery 반영

### 변경

- README local checkout symlink destination을 `private-journal-mcp.js`로 변경
- Task 3 local example과 Task 4 isolated smoke 예시의 symlink destination을
  `private-journal-mcp.js`로 변경
- symlink target `opencode-plugin.mjs`, plugin source, package export는 유지

### 검증

- `npx jest --runInBand --runTestsByPath test/plugin-manifest.test.ts test/bin-launcher.test.ts`
  - PASS: 2 suites, 3 tests
- `git diff --check -- README.md docs/superpowers/plans/2026-08-03-opencode-plugin.md`
  - PASS: 두 문서 diff clean

### 우려사항

- 없음. OpenCode 1.18.3 isolated experiment에서 `.mjs` filename은 발견되지 않고
  `.js` symlink filename은 네 native journal tool을 모두 노출한 확인 결과를 문서 예시에 반영했습니다.
