# Git Commit Identity Design

## Goal

자동 Git 동기화 커밋의 author와 committer를 짧은 기본 identity로 만들고, `GIT_NAME`/`GIT_EMAIL` 환경변수로 사용자가 덮어쓸 수 있게 한다.

## Scope

- 기본 author name: `journal`
- 기본 author email: `journal@localhost`
- `GIT_NAME`, `GIT_EMAIL`이 설정되면 해당 값을 author와 committer에 사용한다.
- MCP가 실행하는 Git subprocess의 자동 동기화 커밋에만 적용한다.
- 기존 커밋과 사용자가 직접 실행하는 Git 커밋은 변경하지 않는다.

## Design

`src/git-sync.ts`에서 Git subprocess용 환경을 만들 때 identity resolver를 거친다. `GIT_NAME`과 `GIT_EMAIL`을 기본값과 환경변수로 해석하고, 두 값을 Git이 이해하는 author/committer 환경변수 네 개에 동일하게 넣는다. 이렇게 하면 author email을 GitHub 계정 이메일로 설정할 수 있고 전역 Git identity가 자동으로 섞이지 않는다.

## Verification

- 기본값 resolver 테스트
- `GIT_NAME`/`GIT_EMAIL` 환경변수 오버라이드 테스트
- 기존 전체 테스트, build, `git diff --check`
