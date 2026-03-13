# Foxtrot - Web Terminal with Korean Input Buffer

## 배경 / 문제

아이폰 Safari에서 한글 IME가 xterm.js 같은 터미널 에뮬레이터와 직접 상호작용할 때 불안정한 문제가 있다.
조합 중인 한글이 깨지거나, 입력이 누락되거나, 예상치 못한 동작이 발생한다.

## 해결 방법

별도의 텍스트 입력 필드(입력 버퍼)를 가진 웹 터미널을 만든다.
한글 IME 조합은 일반 `<input>` 태그에서 안정적으로 처리하고, 완성된 텍스트만 터미널(pty)에 전송한다.

## 프로젝트 구조

```
foxtrot/
├── package.json        # 의존성 (express, ws, node-pty)
├── server.js           # Express + WebSocket + node-pty 서버 (멀티탭)
├── plan.md             # 이 파일
├── README.md           # 사용법 및 라이선스 (MIT)
└── public/
    └── index.html      # xterm.js 터미널 + 입력 버퍼 UI (단일 파일)
```

## 기술 스택

- **Backend**: Node.js, express, ws, node-pty
- **Frontend**: xterm.js (CDN), xterm-addon-fit (CDN), 단일 HTML 파일

## 구현된 기능

### 1. 입력 버퍼 (Korean IME 안정화)
- 화면 하단에 텍스트 입력 필드 + **Send** 버튼 + **Enter** 버튼
- 텍스트 입력 필드: 한글 IME 조합이 안정적으로 동작하는 일반 `<input>` 태그
- **Send 버튼**: 입력 필드의 텍스트를 터미널에 전송 (개행 없음)
- **Enter 버튼**: 터미널에 `\r` (Enter) 전송
- 입력 필드에서 Enter 키 → 텍스트만 전송 (개행 없음), `isComposing` 체크로 조합 중 전송 방지
- placeholder 없음 (깔끔한 UI)

### 2. 특수 키 입력 (2열 구조)
- **Quick keys 행** (항상 표시, 가로 스크롤):
  - 탭 드롭다운, 1, 2, 3, ESC, TAB, ^C, ^D, ^Z, `|`, `/`, `-`, `~`, Keys 토글
- **확장 키보드 패널** (Keys 버튼으로 토글, 세로 스크롤):
  - **Arrows**: ↑ ↓ ← →
  - **Navigation**: Home, End, PgUp, PgDn, Ins, Del
  - **Function**: F1–F12
  - **Ctrl 조합**: ^A, ^B, ^C, ^D, ^E, ^F, ^K, ^L, ^N, ^P, ^R, ^U, ^W, ^Z, ^\\

### 3. 터미널 영역
- xterm.js로 터미널 출력 렌더링
- xterm-addon-fit으로 자동 크기 조절
- 터미널 영역 직접 키 입력 가능 (PC 사용 시)
- 다크 테마 (#1e1e1e 배경)

### 4. 멀티탭 세션
- 특수문자열 맨 앞에 **탭 드롭다운** 버튼 (`#1`, `#2`, ...)
- 드롭다운 메뉴에서:
  - **+ New Tab**: 새 탭 추가 (새 pty 프로세스 생성)
  - 탭 목록에서 클릭하여 탭 전환
  - **×** 버튼으로 탭 닫기 (pty 종료)
- 각 탭은 독립된 pty 프로세스와 scrollback 버퍼를 가짐
- 탭 전환 시 해당 탭의 scrollback을 터미널에 복원
- shell이 종료된 탭은 `(exited)` 표시
- 서버가 살아있는 한 모든 탭 세션 유지 (브라우저 재접속 시 복원)

### 5. 세션 유지
- 서버 시작 시 초기 탭 하나 자동 생성
- 모든 WebSocket 클라이언트가 동일 탭 세션 공유
- scrollback 버퍼 (탭별 최대 100KB) — 재접속 시 이전 출력 복원
- 브라우저 닫았다 다시 열어도 동일 세션 유지
- shell 종료 시 안내 메시지 표시

### 6. 모바일 최적화
- `viewport` meta 태그로 확대/축소 방지
- `html, body`에 `position: fixed`로 키보드 등장 시 페이지 스크롤 방지
- `visualViewport` API로 키보드 높이만큼 레이아웃 동적 조정
- 키보드가 올라와도 마지막 명령이 화면 하단에 보임 (`scrollToBottom`)
- 출력이 올 때마다 자동으로 맨 아래 스크롤

### 7. WebSocket 통신 (JSON 프로토콜)
- 모든 메시지는 JSON으로 래핑
- **클라이언트 → 서버**:
  - `{ type: "input", data: "..." }` — 키 입력
  - `{ type: "resize", cols, rows }` — 터미널 크기 변경
  - `{ type: "switch", id }` — 탭 전환
  - `{ type: "new-tab" }` — 새 탭 생성
  - `{ type: "close-tab", id }` — 탭 닫기
- **서버 → 클라이언트**:
  - `{ type: "output", data }` — pty 출력
  - `{ type: "scrollback", data }` — 탭 전환 시 전체 출력 복원
  - `{ type: "tab-list", tabs }` — 탭 목록 업데이트
  - `{ type: "switched", id }` — 탭 전환 완료
  - `{ type: "tab-exited", id }` — 탭의 shell 종료 알림
- null 바이트 포함 메시지는 무조건 드롭 (프록시/터널 바이너리 노이즈 대응)

### 8. 프롬프트
- `PS1='$ '`로 간결한 프롬프트 설정 (`bash-3.2$` 대신 `$ `)

## 서버 옵션

- 기본 포트: `16000`
- `--port <number>` 옵션으로 변경 가능

## 실행 방법

```bash
npm install
node server.js              # http://localhost:16000
node server.js --port 8080  # http://localhost:8080
```
