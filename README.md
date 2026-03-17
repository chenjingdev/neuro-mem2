# nero-mem2

AI 대화를 일회성 채팅이 아닌 **구조화된 기억**으로 변환하고, 매 턴마다 현재 질문에 맞는 맥락을 재구성하는 로컬 메모리 인프라.

```
User ↔ LLM API
       ↑
   nero-mem2 proxy
       ↑
  ┌────┴────┐
  │ Memory  │
  │  Brain  │
  └────┬────┘
       │
  ┌────┴──────────────────────────┐
  │  Raw Conversations (immutable)│
  │  ↓ LLM extraction            │
  │  Facts  Episodes  Concepts   │
  │     ↕ Anchors (synapse) ↕    │
  │  Hebbian weight + decay      │
  │  ↓                           │
  │  Dual-path retrieval         │
  │  (vector + graph → merge)    │
  └───────────────────────────────┘
```

## 핵심 개념

| 계층 | 역할 | 비유 |
|------|------|------|
| **Raw Conversation** | 원본 대화 (불변) | 감각 입력 |
| **Fact** | 개별 사실 추출 (실시간) | 단기 기억 |
| **Episode** | 세션 단위 흐름 요약 (배치) | 에피소드 기억 |
| **Concept** | 반복 주제/개념 (배치) | 의미 기억 |
| **Anchor** | 기억 노드 간 가중치 연결 | 시냅스 |

- **Hebbian Learning**: 함께 검색된 기억 쌍의 Anchor 가중치가 강화됨
- **Time Decay**: 오래 쓰지 않은 기억의 가중치가 자연 감쇠
- **Dual-path Retrieval**: 벡터 유사도 + 그래프 탐색을 병렬 실행 후 merge

## 설치 및 실행

```bash
git clone https://github.com/chenjingdev/neuro-mem2.git
cd neuro-mem2
npm install
npm --prefix web install
npm run build
```

### Visual Debug Chat App

메모리 파이프라인이 실제로 어떻게 동작하는지 시각적으로 확인할 수 있는 디버그 채팅앱입니다.

```
┌─────────────────────────────────────────────────┐
│  Chat Panel          │  Timeline Panel          │
│                      │                          │
│  User: 인증 어떻게?  │  ▸ vector_search  12ms   │
│                      │  ▸ graph_traversal 8ms   │
│  AI: JWT 기반을...   │  ▸ merge          3ms    │
│                      │  ▸ inject         1ms    │
│                      │  ▸ fact_extract   45ms   │
│                      │                          │
│  [메시지 입력...]    │  ▾ Detail: raw JSON      │
└─────────────────────────────────────────────────┘
```

**1단계: 인증 설정**

기본적으로 `~/.codex/auth.json`이 있으면 로컬에 설치된 Codex 토큰을 자동으로 사용합니다. 별도 로그인 UI는 필요 없습니다.

직접 API 키를 쓰고 싶다면 `~/.nero-mem/auth.json` 또는 `auth.json`에 아래 형식으로 설정할 수 있습니다:

```json
{
  "openai_api_key": "sk-...",
  "anthropic_api_key": "sk-ant-...",
  "provider": "openai"
}
```

또는 환경변수로:
```bash
export NERO_AUTH_PATH=./auth.json
```

**2단계: 전체 개발 서버 실행**

```bash
# 백엔드 + 프론트엔드 동시 실행
npm run dev

# 또는 개별 실행
npm run dev:server
npm run dev:web

# 또는 프로덕션 백엔드 실행
npm run build
npm start
```

브라우저에서 `http://localhost:5173`을 열면 채팅앱이 실행됩니다. 백엔드는 `http://127.0.0.1:3030`에서 함께 뜹니다.

**기능:**
- 채팅 메시지 송수신 (SSE 스트리밍)
- 타임라인 패널: recall 파이프라인 (vector search → graph traversal → merge → inject) 각 단계별 raw JSON
- 타임라인 패널: ingestion 파이프라인 (Fact 추출) 실시간 표시
- 각 단계 클릭 시 상세 JSON 드릴다운
- 세션 목록에서 이전 대화 + 타임라인 재확인
- 대화 기록 + tracing 데이터 SQLite 영구 저장
- 세션 종료 시 Episode/Concept 배치 추출 자동 트리거

### 라이브러리로 사용

```typescript
import { createDatabase, ConversationRepository, IngestService, startServer } from 'nero-mem2';

const db = createDatabase({ path: './nero.db' });
const repo = new ConversationRepository(db);
const ingestService = new IngestService(repo);

startServer({ ingestService }, { port: 3030 });
// → http://127.0.0.1:3030
```

### LLM Proxy 모드

Claude, GPT 등 LLM API 앞에 프록시로 끼어들어 자동으로 기억 맥락을 주입합니다.

```bash
# 환경 변수로 설정
export NERO_PROXY_PORT=8420
export NERO_PROXY_TARGET_URL=https://api.anthropic.com
export NERO_PROXY_API_KEY=sk-your-key
```

또는 설정 파일 `~/.nero-mem/proxy.json`:

```json
{
  "port": 8420,
  "targetUrl": "https://api.anthropic.com",
  "apiKey": "sk-your-key",
  "injectionEnabled": true,
  "maxMemories": 10
}
```

프록시를 통해 API 호출하면, nero-mem2가 자동으로 관련 기억을 찾아 시스템 프롬프트에 주입합니다.

## API Endpoints

| Method | Path | 설명 |
|--------|------|------|
| `POST` | `/ingest` | 대화 전체를 기억으로 저장 |
| `POST` | `/ingest/append` | 기존 대화에 메시지 추가 |
| `POST` | `/recall` | 질문에 맞는 기억 검색 |
| `POST` | `/api/chat` | 채팅 메시지 전송 (SSE 스트림 반환) |
| `GET` | `/api/sessions` | 채팅 세션 목록 조회 |
| `GET` | `/api/sessions/:id` | 세션 상세 (대화 + tracing) |
| `POST` | `/api/sessions/:id/end` | 세션 종료 (배치 추출 트리거) |
| `GET` | `/api/conversations` | 대화 목록 조회 |
| `GET` | `/health` | 헬스체크 |

### 대화 저장 (Ingest)

```bash
curl -X POST http://localhost:3030/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "FastAPI로 인증 시스템 만들고 싶어"},
      {"role": "assistant", "content": "JWT 기반 인증을 추천합니다..."}
    ]
  }'
```

### 기억 검색 (Recall)

```bash
curl -X POST http://localhost:3030/recall \
  -H "Content-Type: application/json" \
  -d '{
    "query": "인증 시스템 어떻게 만들기로 했지?",
    "maxResults": 5
  }'
```

## Python SDK

```bash
cd sdk/python
pip install -e .
```

```python
from nero_mem import MemoryClient

client = MemoryClient("http://localhost:3030")

# 대화 저장
client.ingest(messages=[
    {"role": "user", "content": "React vs Vue 어떤 게 나아?"},
    {"role": "assistant", "content": "프로젝트 규모에 따라 다릅니다..."},
])

# 기억 검색
results = client.recall("프론트엔드 프레임워크 뭐 쓰기로 했지?")
for item in results.items:
    print(f"[{item.score}] {item.content}")
```

Async 클라이언트도 지원:

```python
from nero_mem import AsyncMemoryClient

async with AsyncMemoryClient("http://localhost:3030") as client:
    results = await client.recall("이전에 논의한 인증 방식은?")
```

## 테스트

```bash
npm test              # 전체 테스트 실행
npm run test:watch    # watch 모드
```

## 프로젝트 구조

```
src/
├── api/            REST API (Hono 프레임워크)
│   └── middleware/  인증, rate limiting, 맥락 주입
├── chat/           Visual Debug Chat App 백엔드
│   ├── auth-loader.ts      codex auth.json 토큰 로더
│   ├── chat-router.ts      POST /chat SSE 엔드포인트
│   ├── sessions-router.ts  세션 lifecycle API
│   ├── history-router.ts   세션 히스토리 조회 API
│   ├── trace-collector.ts  파이프라인 tracing 수집기
│   └── db/                 채팅 전용 SQLite 저장소
├── db/             메모리 SQLite 저장소 (better-sqlite3)
├── extraction/     LLM 기반 Fact/Episode/Concept 추출
│   ├── openai-llm-provider.ts   OpenAI streaming provider
│   └── anthropic-llm-provider.ts Anthropic streaming provider
├── models/         데이터 모델 & 타입 정의
├── proxy/          LLM API 프록시 미들웨어
├── retrieval/      Dual-path retrieval (벡터 + 그래프)
├── scoring/        Hebbian 가중치 & decay 계산
├── services/       파이프라인 오케스트레이션
└── events/         이벤트 버스

web/                React + Vite SPA (Debug Chat UI)
├── src/
│   ├── components/  ChatPanel, TimelinePanel, DetailPanel, SessionList
│   ├── hooks/       useChat, useTimeline, useSessions, SSE parser
│   └── pages/       ChatPage
tests/              55+ 테스트 파일
sdk/python/         Python SDK 클라이언트
```

## 기술 스택

- **Runtime**: Node.js (TypeScript, ESM)
- **DB**: SQLite (better-sqlite3) - 외부 DB 서버 불필요
- **API**: Hono
- **Frontend**: React + Vite
- **Test**: Vitest
- **기억 추출**: LLM API (교체 가능한 provider 인터페이스)
- **LLM 지원**: OpenAI, Anthropic (streaming + completion)

## 환경 변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `PORT` | `3030` | API 서버 포트 |
| `DB_PATH` | `./nero.db` | SQLite 데이터베이스 경로 |
| `NERO_PROXY_PORT` | `8420` | 프록시 서버 포트 |
| `NERO_PROXY_TARGET_URL` | `https://api.anthropic.com` | 업스트림 LLM API URL |
| `NERO_PROXY_API_KEY` | - | 업스트림 API 키 |
| `NERO_PROXY_INJECTION` | `on` | 메모리 주입 on/off |
| `NERO_PROXY_DB_PATH` | `~/.nero-mem/nero.db` | SQLite DB 경로 |
| `NERO_PROXY_MAX_MEMORIES` | `10` | 요청당 최대 주입 기억 수 |
| `NERO_PROXY_LOG_LEVEL` | `info` | 로그 레벨 |
| `NERO_AUTH_PATH` | - | auth.json 경로 (채팅앱용) |

## License

ISC
