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
