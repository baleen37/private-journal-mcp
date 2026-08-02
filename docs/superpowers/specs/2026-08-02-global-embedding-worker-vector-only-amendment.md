# 전역 임베딩 워커 벡터 전용 정정

이 문서는 `2026-08-02-global-embedding-worker-design.md`의 상충하는 내용을 대체한다.

전역 worker는 모델 추론만 수행한다. RPC는 `embedText(text, kind) -> vector`와 진단용
`status`뿐이다. worker는 `PRIVATE_JOURNAL_PATH`, Markdown 경로, frontmatter, section,
sidecar를 알지 못하며 journal 데이터 파일을 읽거나 쓰지 않는다. 자체 Unix socket의 생성과
권한 설정만 worker의 filesystem 책임이다.

각 MCP/CLI 프로세스는 반환된 vector로 기존 `EmbeddingData`를 만들고, sidecar는 같은
디렉터리 임시 파일 뒤 rename으로 저장한다. 동시에 같은 sidecar를 저장해도 완전한 JSON
중 하나만 남으므로 손상되지 않는다. sidecar가 현재 Markdown과 맞는지는 호출자가 기존
text, sections, timestamp, path를 비교해 판단하며 불일치면 다시 임베딩한다.

Unix socket의 startup lock, stale socket 회수, detached worker 기동은 broker가 맡는다.
worker 자체는 이미 사용 중인 socket을 unlink하거나 회수하지 않는다.
