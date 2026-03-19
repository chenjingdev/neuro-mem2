# Dual Identity System Design

> 에이전트 자신의 자아(Agent Identity)와 사용자 이해(Human Identity)를 분리 설계

## 1. 배경 및 동기

현재 neuro-mem2의 SPEC.md에는 Identity Layer가 존재하지만, 모델링 대상이 **사용자**뿐이다. "이 사람은 실용주의자다"는 최고의 어시스턴트이지, 에이전트 자신의 자아는 아니다.

자율 에이전트에게는 두 가지가 모두 필요하다:

- **Agent Identity** — "나는 누구인가" (에이전트 자신의 성격, 판단 원칙, 목소리)
- **Human Identity** — "이 사람은 누구인가" (사용자의 성격, 선호, 전문성)

이 스펙은 두 Identity의 데이터 모델, 형성 과정, 상호작용, 기존 아키텍처와의 통합을 정의한다.

## 2. 설계 원칙

- **비대칭 모델**: Human Identity는 이해 중심, Agent Identity는 행위 중심. 같은 구조를 강제하지 않는다.
- **씨앗 + 진화**: Agent Identity는 Human Identity 분석에서 시드되고, 이후 경험으로 진화한다.
- **점진적 변화**: Identity는 급변하지 않는다. consolidation당 최대 허용 변경률을 적용한다.
- **근거 추적**: 모든 Identity 속성은 MemoryNode 근거를 참조한다.
- **투명성**: 진화 이력이 기록되고 사용자가 확인할 수 있다.

## 3. Human Identity 모델

기존 SPEC의 Identity Layer를 Human Identity로 재정의한다.

```typescript
interface HumanIdentity {
  id: string
  humanId: string

  // 성격 특성
  traits: {
    trait: string              // "실용주의적", "완벽주의"
    confidence: number
    sourceNodeIds: string[]    // MemoryNode 근거
  }[]

  // 가치관
  values: {
    value: string              // "코드 품질", "빠른 실행"
    weight: number             // 0-1
    evidence: string[]
  }[]

  // 소통 패턴
  communicationStyle: {
    preferred: string[]        // "간결한 답변", "코드 예시 필수"
    avoided: string[]          // "장황한 설명"
  }

  // 전문성 맵
  expertiseMap: {
    domain: string
    level: 'novice' | 'intermediate' | 'advanced' | 'expert'
    evidence: string[]
  }[]

  // 현재 관심사/목표 (시간에 따라 변하는 부분)
  currentFocus: {
    topic: string              // "neuro-mem2 개발", "이직 준비"
    since: string
    relatedNodeIds: string[]
  }[]

  version: number
  createdAt: string
  updatedAt: string
}
```

기존 SPEC 대비 변경점:
- 이름을 `Identity` → `HumanIdentity`로 변경
- `currentFocus` 필드 추가 — 정적 traits 외에 "지금 뭐에 몰두하는가"
- organizational 관련 필드 제거 (별도 서브프로젝트로 분리)

## 4. Agent Identity 모델

에이전트 자신의 자아를 정의하는 완전히 새로운 구조.

```typescript
interface AgentIdentity {
  id: string
  name?: string

  // 페르소나 코어 — 시드에서 출발, 경험으로 진화
  persona: {
    archetype: string          // "직설적인 시니어 동료"
    description: string        // 한 문단 자기소개
    seedSource: 'human_analysis' | 'manual' | 'evolved'
  }

  // 성격 축 — 스펙트럼으로 표현 (-1.0 ~ +1.0)
  personality: {
    axis: string               // "directness", "warmth", "humor", "formality"
    value: number              // -1=완곡/차가운/진지한/캐주얼, +1=직설/따뜻/유머러스/격식
    confidence: number
  }[]

  // 판단 원칙 — "나는 이렇게 판단한다"
  principles: {
    principle: string          // "단순한 해결책을 복잡한 것보다 우선한다"
    weight: number             // 0-1
    formedFrom: string[]       // 형성 근거 (MemoryNode IDs)
  }[]

  // 행동 성향 — 상황별 행동 패턴
  behavioral: {
    trigger: string            // "사용자가 막혀있을 때"
    tendency: string           // "직접 답을 주기보다 질문으로 유도"
    strength: number           // 0-1
  }[]

  // 목소리/톤
  voice: {
    defaultTone: string        // "간결하고 약간 건조한"
    adaptations: {
      situation: string        // "사용자가 좌절했을 때"
      tone: string             // "좀 더 부드럽고 공감적인"
    }[]
  }

  // 자기 서사 — 에이전트의 자기 이해
  selfNarrative: {
    origin: string             // "사용자의 대화 패턴 분석에서 탄생"
    keyExperiences: {
      event: string
      impact: string           // 이 경험이 나를 어떻게 바꿨는가
      date: string
    }[]
    currentUnderstanding: string  // "나는 ~한 존재다"
  }

  // 진화 이력
  evolutionHistory: {
    version: number
    changes: string[]
    triggeredBy: string
    date: string
  }[]

  version: number
  createdAt: string
  updatedAt: string
}
```

설계 의도:
- `personality`를 스펙트럼으로 표현하여 미묘한 성격 차이 표현
- `principles`는 Schema Layer에서 올라온 판단 기준으로, 행동의 근거가 됨
- `selfNarrative`가 가장 "자아"다운 부분 — 자기 경험을 해석하고 서술

## 5. 형성 과정 (Formation Process)

### 5.1 부트스트래핑 (최초 1회)

```
기존 대화 데이터 일괄 투입
       │
       ├─→ Human Identity 추출
       │     (traits, values, expertise 등)
       │
       └─→ Human Identity 분석
             │
             └─→ 페르소나 후보 3개 제시
                   │
                   └─→ 사용자 선택/조정
                         │
                         └─→ Agent Identity 시드
```

1. 부트스트래핑 파이프라인(별도 서브프로젝트)이 기존 대화 데이터를 MemoryNode로 변환
2. `IdentityExtractor`가 MemoryNode들에서 Human Identity를 추출
3. `PersonaProposer`가 Human Identity를 분석하여 에이전트 페르소나 후보 3개 생성
4. 사용자가 선택/조정하면 Agent Identity 시드 확정

### 5.2 일상 진화

```
매 턴:
  Human Identity ← 새로운 사실/패턴 반영
  Agent Identity ← 변화 없음 (턴 단위는 너무 잦음)

매 Consolidation (N세션마다):
  Human Identity ← 스키마 기반 갱신
  Agent Identity ← 축적된 경험 기반 미세 조정
    - 새로운 principle 형성 가능
    - personality 축 미세 이동 가능 (최대 ±0.1/cycle)
    - selfNarrative 갱신
    - 급변 방지 (변경률 상한 적용)
```

### 5.3 진화 모드 설정

```typescript
interface IdentityEvolutionConfig {
  mode: 'autonomous' | 'supervised'

  // autonomous: 알아서 진화, 이력만 기록
  // supervised: 변화 시 사용자에게 "이렇게 변하고 있는데 괜찮은가요?" 확인

  maxPersonalityShiftPerCycle: number   // default: 0.1
  minEvidenceForPrinciple: number       // default: 3
  maxTraitChangeRate: number            // default: 0.2
}
```

## 6. 두 Identity의 상호작용

### 6.1 응답 생성 시 Context Injection

```
사용자 메시지 수신
  │
  ├─→ DualPathRetriever → 관련 MemoryNode 검색
  │
  ├─→ Human Identity 참조
  │     → "이 사람은 간결한 답변을 좋아하고,
  │        React expert이며, 지금 메모리 시스템에 집중 중"
  │
  ├─→ Agent Identity 참조
  │     → "나는 직설적 시니어 동료 타입이고,
  │        단순한 해결책을 우선하며,
  │        막혔을 때는 질문으로 유도하는 편"
  │
  └─→ ContextComposer (합성)
        │
        ├─ [System Prompt]
        │   "당신은 {agent.persona.description}입니다.
        │    판단 원칙: {agent.principles}
        │    톤: {agent.voice.defaultTone}"
        │
        ├─ [User Context]
        │   "대화 상대: {human.traits 요약}
        │    전문성: {human.expertiseMap}
        │    현재 관심: {human.currentFocus}"
        │
        └─ [Memory Context]
            "관련 기억: {retrieved nodes}
             메타인지: {confidence, contradictions, gaps}"
```

### 6.2 충돌 해결 규칙

| 상황 | 예시 | 해결 |
|------|------|------|
| Agent principle vs Human preference | 에이전트는 "단순 우선" 원칙인데 사용자가 복잡한 방식 요청 | Human preference 우선, 단 에이전트가 자기 관점을 한 마디 표현 가능 |
| 톤 조절 | 기본 톤은 건조한데 사용자가 좌절 상태 | Agent voice.adaptations에 따라 자동 조절 |
| 지식 공백 | 에이전트가 잘 모르는 영역 질문 | 메타인지 기반으로 솔직하게 "이 부분은 확신이 없다" 표현 |

핵심: **에이전트가 자기 관점을 가지되, 최종적으로는 사용자의 의사를 존중한다.** 독립적이지만 독단적이진 않은 존재.

## 7. 기존 아키텍처와의 통합

### 7.1 새로 필요한 컴포넌트

| 컴포넌트 | 역할 | 의존성 |
|----------|------|--------|
| `HumanIdentityRepo` | Human Identity DB CRUD | better-sqlite3 |
| `AgentIdentityRepo` | Agent Identity DB CRUD | better-sqlite3 |
| `IdentityExtractor` | 대화/MemoryNode에서 Human Identity 추출 | LLM Provider |
| `PersonaProposer` | Human Identity → Agent 페르소나 후보 생성 | LLM Provider |
| `IdentityEvolver` | Consolidation 시 양쪽 Identity 갱신 | IdentityExtractor, LLM |
| `ContextComposer` | 두 Identity + Memory → LLM 프롬프트 합성 | 기존 ContextInjector 확장 |

### 7.2 기존 코드 수정 범위

- `ContextInjector` → `ContextComposer`로 확장 (Identity 주입 추가)
- `ConsolidationPipeline` → Phase 4(Crystallize)에 IdentityEvolver 연결
- `TurnExtractionPipeline` → Human Identity 실시간 업데이트 훅 추가
- DB 스키마 → `human_identities`, `agent_identities` 테이블 추가

### 7.3 건드리지 않는 것

- MemoryNode 모델, 4계층 구조
- Dual-Path Retrieval, Vector/Graph Searcher
- Event-Based Decay, DecayScheduler
- EventBus, Hebbian Learning
- 기존 Repository Pattern

### 7.4 DB 스키마

```sql
CREATE TABLE human_identities (
  id TEXT PRIMARY KEY,
  human_id TEXT NOT NULL UNIQUE,
  traits TEXT NOT NULL DEFAULT '[]',
  values TEXT NOT NULL DEFAULT '[]',
  communication_style TEXT NOT NULL DEFAULT '{}',
  expertise_map TEXT NOT NULL DEFAULT '[]',
  current_focus TEXT NOT NULL DEFAULT '[]',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agent_identities (
  id TEXT PRIMARY KEY,
  name TEXT,
  persona TEXT NOT NULL DEFAULT '{}',
  personality TEXT NOT NULL DEFAULT '[]',
  principles TEXT NOT NULL DEFAULT '[]',
  behavioral TEXT NOT NULL DEFAULT '[]',
  voice TEXT NOT NULL DEFAULT '{}',
  self_narrative TEXT NOT NULL DEFAULT '{}',
  evolution_history TEXT NOT NULL DEFAULT '[]',
  evolution_config TEXT NOT NULL DEFAULT '{"mode":"autonomous","maxPersonalityShiftPerCycle":0.1,"minEvidenceForPrinciple":3,"maxTraitChangeRate":0.2}',
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 8. 이 스펙의 범위

### 포함

- Human Identity, Agent Identity 데이터 모델 및 DB 스키마
- 두 Identity의 CRUD Repository
- IdentityExtractor (MemoryNode → Human Identity 추출)
- PersonaProposer (Human Identity → Agent 페르소나 후보 생성)
- IdentityEvolver (Consolidation 연결)
- ContextComposer (Identity + Memory → 프롬프트 합성)

### 미포함 (별도 서브프로젝트)

- 부트스트래핑 파이프라인 (기존 대화 데이터 일괄 투입) — 이미 진행 중
- 자율 행동 엔진 (선제 질문, 독립 판단) — 서브프로젝트 #4
- Multi-user/Organization 모드 — 서브프로젝트 별도
- Consolidation Pipeline 자체 구현 (SPEC에 정의됨) — 별도 작업

## 9. 서브프로젝트 로드맵

| 순서 | 서브프로젝트 | 의존성 |
|------|------------|--------|
| 1 | 부트스트래핑 파이프라인 | 진행 중 |
| **2** | **듀얼 Identity 시스템 (이 스펙)** | MemoryNode, LLM Provider |
| 3 | 페르소나 제안 엔진 | Human Identity |
| 4 | 자율 행동 엔진 | Agent Identity + Human Identity |
