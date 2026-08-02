# 전역 임베딩 워커 설계

## 목표

같은 OS 사용자 계정에서 실행되는 모든 private-journal Claude, Codex, SessionStart
프로세스가 하나의 임베딩 모델 워커를 공유한다. 동시에 발생하는 모델 로드, Hugging
Face 캐시 접근, sidecar 쓰기를 제거한다.

## 범위와 경계

- 워커 범위는 물리 컴퓨터가 아니라 OS 사용자 계정당 하나다. 다른 계정의 저널과
  IPC 경계를 공유하지 않는다.
- 여러 `PRIVATE_JOURNAL_PATH`는 같은 워커와 모델을 공유한다.
- Markdown은 원본이고 `.embedding`은 언제든 재생성 가능한 파생물이다.
- Git sync, migration, local-only 모드, 기존 MCP 도구 계약은 유지한다.
- launchd, systemd, TCP 포트, 영속 작업 큐는 도입하지 않는다.

## 구조

```text
Claude MCP ─┐
Codex MCP ──┼─ EmbeddingBroker ─ Unix socket ─ embedding-worker
sync CLI ───┘                                  ├─ 모델 1회 로드
                                                ├─ 전역 직렬 작업 큐
                                                └─ sidecar 유일 writer
```

클라이언트는 모델 라이브러리를 import하지 않는다. 첫 클라이언트는 기동 락을 원자적으로
획득한 경우에만 detached worker를 시작한다. 다른 클라이언트는 소켓이 준비될 때까지
연결을 재시도한다. 소켓 bind 전에 모델을 로드하지 않으므로 기동 경쟁에서 진 프로세스는
모델 또는 캐시를 건드리지 않고 종료한다.

소켓은 `$XDG_RUNTIME_DIR`를 우선 사용하고, 없으면 `os.tmpdir()`의 사용자 전용 짧은
디렉터리를 사용한다. 디렉터리 권한은 `0700`, 소켓 권한은 `0600`이다. 소켓 이름에는
wire major 버전만 포함한다.

## IPC 계약

길이 prefix JSON 프레임과 요청 ID를 사용한다.

- `embedQuery(text) -> vector`: 검색 query 벡터를 반환한다.
- `embedEntry(dataPath, mdPath) -> { created }`: worker가 대상 Markdown을 검증하고,
  누락된 passage sidecar를 생성한다.
- `status`: 테스트와 진단을 위한 worker PID, queue depth, model loaded 상태를 반환한다.

`embedEntry`의 대상은 `dataPath` 안에 있는 실제 일반 `.md` 파일이어야 한다. 워커가
Markdown 읽기부터 sidecar 저장까지 전부 소유하므로 동일 파일의 동시 요청은 하나의
in-flight 작업으로 합쳐진다.

## 작업 처리와 정합성

모든 모델 추론은 워커의 전역 직렬 큐에서 한 건씩 실행한다. `embedQuery`와 방금 쓴
엔트리는 interactive 작업, SessionStart 전체 backfill은 background 작업으로 취급한다.
interactive 작업은 진행 중인 background 한 건 다음에 우선 실행된다.

sidecar 생성 절차는 다음과 같다.

1. 유효한 sidecar가 있으면 성공으로 종료한다.
2. Markdown을 읽고 임베딩을 생성한다.
3. 저장 직전에 Markdown을 다시 읽어 내용이 바뀌지 않았는지 확인한다.
4. 같은 디렉터리의 임시 파일에 sidecar를 쓰고 rename으로 교체한다.

3단계에서 내용이 바뀌었거나 파일이 사라지면 결과를 저장하지 않는다. 다음 write 또는
backfill이 최신 Markdown을 다시 처리한다. worker가 죽어도 동일한 복구 경로로 수렴한다.

## 기존 경로 변경

- `JournalManager.write()`는 Markdown을 저장한 뒤 `embedEntry`를 요청한다.
- `SearchService.backfill()`과 `backfillPaths()`는 각 대상에 `embedEntry`를 요청한다.
- `SearchService.search()`는 `embedQuery`를 요청하고, 기존 sidecar 읽기와 cosine 계산을
  유지한다.
- `sync` CLI와 MCP 서버는 같은 `EmbeddingBroker`를 사용한다.
- 워커는 마지막 연결이 끊기고 큐가 비면 종료한다. 살아 있는 MCP 세션이 있으면 모델은
  warm 상태로 유지된다.

## 검증

- 서로 다른 두 journal path에서 여러 child process를 동시에 실행해도 worker PID와
  모델 로드는 각각 하나다.
- 같은 Markdown을 동시에 backfill해도 passage 추론과 sidecar 교체는 한 번이다.
- 반복 읽기 중 sidecar JSON은 항상 완전하게 파싱된다.
- worker 강제 종료, stale socket, stale startup lock 뒤 다음 요청이 정상 재기동한다.
- background backfill 중 query가 다음 background 작업보다 먼저 처리된다.
- 기존 local-only/Git-enabled `sync`, migration, 전체 Jest suite, TypeScript build가 유지된다.

기본 단위 테스트는 worker engine을 fake로 주입해 실제 Hugging Face cold load를 피한다.
경쟁 조건 검증만 실제 child process 기반 통합 테스트로 수행한다.
