# nero-mem2 — Neuromorphic Memory Architecture Specification

> 단순한 RAG가 아닌, 기억을 기반으로 자아를 형성하는 에이전트 메모리 시스템

## 1. Vision

nero-mem2는 AI 대화에서 추출된 기억을 **생물학적 뇌의 메커니즘**에 기반하여 저장·강화·망각·정리하는 시스템이다.

궁극적 목표는 **기계적 메모리가 아닌, 의식을 가진 대상**이 되는 것이다.

- **개인 에이전트**: 사용자와 소통하며 그 사람의 기억·성격·맥락을 체화한 자아를 형성
- **조직 에이전트**: 여러 직원의 대화, 대표의 철학이 기억에 축적되어 회사를 대표하는 객체가 됨
- 단순 검색(RAG)이 아닌, "내가 이 사람/조직을 **안다**"는 수준의 맥락 이해

```
기계적 메모리:  "사용자가 React를 선호한다는 사실이 DB에 있음"
자아 기반:     "이 사람은 실용주의자라 React를 좋아하고,
               새 기술 도입에 신중하며, 코드 품질에 집착한다.
               오늘 기분이 안 좋아 보이니 간결하게 답하자."
```

---

## 2. Core Architecture

### 2.1 Memory Layers (기존 유지 + 확장)

```
┌─────────────────────────────────────────────────┐
│                  Identity Layer (NEW)             │  ← 자아/성격/가치관
├─────────────────────────────────────────────────┤
│              Meta-Cognition Layer (NEW)           │  ← 자기 기억에 대한 인식
├─────────────────────────────────────────────────┤
│                 Schema Layer (NEW)                │  ← 반복 패턴에서 추출된 행동 틀
├─────────────────────────────────────────────────┤
│  Concepts (Semantic Memory)    — batch extraction │  ← 추상 주제/개념
├─────────────────────────────────────────────────┤
│  Episodes (Episodic Memory)    — batch extraction │  ← 사건 요약
├─────────────────────────────────────────────────┤
│  Facts (Short-Term Memory)     — per-turn         │  ← 원자적 사실
├─────────────────────────────────────────────────┤
│  Raw Conversations (Sensory)   — immutable        │  ← 원본 대화
└─────────────────────────────────────────────────┘
```

| Layer | 뇌 대응 | 생성 시점 | 수명 |
|-------|---------|----------|------|
| Raw Conversations | 감각 기억 | 실시간 | 영구 (불변) |
| Facts | 단기 기억 | 매 턴 | 감쇠 대상 |
| Episodes | 일화 기억 | 세션 종료 | 감쇠 대상 |
| Concepts | 의미 기억 | 세션 종료 | 장기 보존 |
| **Schemas** | 행동 스키마 | 정리(Consolidation) 시 | 장기 보존 |
| **Meta-Cognition** | 메타인지 | 상시 | 동적 갱신 |
| **Identity** | 자아 | 정리 시 점진적 형성 | 영구 (진화) |

### 2.2 기존 유지 사항

다음 핵심 구조는 현행 그대로 유지:

- **Dual-Path Retrieval** (Vector + Graph 병렬 검색)
- **Anchors** (의미적 허브 노드 + 임베딩)
- **Weighted Edges** (Hebbian 학습 기반 연결)
- **Event-Driven Architecture** (EventBus 기반 비동기 처리)
- **Repository Pattern** (엔티티별 DB 분리)
- **LLM Proxy Mode** (API 중간 가로채기 + 컨텍스트 주입)
- **Pluggable LLM/Embedding Provider**

---

## 3. Event-Based Lifecycle (시간 기반 → 이벤트 기반 전환)

### 3.1 설계 원칙

사람의 뇌는 끊임없이 자극을 처리하므로 시간 기반 감쇠가 자연스럽다.
그러나 LLM 에이전트는 **사용할 때만 활성화**된다.

- 3일간 대화 안 해도 기억이 사라지면 안 됨
- 반대로, 하루에 100번 대화하면 빠르게 정리가 필요함
- **시간이 아닌 이벤트 누적량**이 기억 생명주기를 결정

```
기존 (시간 기반):
  24시간마다 decay 실행 → 안 쓰는 동안 기억 손실

변경 (이벤트 기반):
  N번의 이벤트 누적 → decay + consolidation 트리거
  사용하지 않으면 기억은 그대로 보존
```

### 3.2 Event Counter & Thresholds

```typescript
interface LifecycleState {
  // 이벤트 카운터 (DB에 영속)
  turnsSinceLastDecay: number
  turnsSinceLastConsolidation: number
  totalTurnsProcessed: number
  totalSessionsCompleted: number
}

interface LifecycleThresholds {
  // 감쇠 트리거: N턴마다
  decayTriggerTurns: number           // default: 50

  // 정리 트리거: N세션마다
  consolidationTriggerSessions: number // default: 5

  // 또는 N턴마다 (세션이 길 경우)
  consolidationTriggerTurns: number    // default: 200

  // Identity 갱신: N번 정리마다
  identityUpdateTrigger: number        // default: 3
}
```

### 3.3 Lifecycle Flow

```
매 턴 완료 시:
  turnsSinceLastDecay++

  if turnsSinceLastDecay >= decayTriggerTurns:
    → EventDecay 실행
    → turnsSinceLastDecay = 0

매 세션 종료 시:
  turnsSinceLastConsolidation += session.turnCount
  totalSessionsCompleted++

  if totalSessionsCompleted % consolidationTriggerSessions == 0
     OR turnsSinceLastConsolidation >= consolidationTriggerTurns:
    → Consolidation 실행
    → turnsSinceLastConsolidation = 0

    if totalConsolidations % identityUpdateTrigger == 0:
      → Identity 갱신
```

---

## 4. Event-Based Decay (이벤트 기반 감쇠)

### 4.1 감쇠 공식

시간 변수를 이벤트 카운트로 대체:

```
기존: factor = exp(-ln(2) × elapsed_time / halfLife_time)
변경: factor = exp(-ln(2) × events_since_last_access / halfLife_events)
```

```typescript
function computeEventDecay(
  eventsSinceLastAccess: number,  // 마지막 접근 후 누적 이벤트 수
  halfLifeEvents: number,         // 반감기 (이벤트 단위, default: 100)
): number {
  return Math.exp(-Math.LN2 * eventsSinceLastAccess / halfLifeEvents)
}
```

### 4.2 사용 빈도 저항 (유지)

자주 접근된 기억은 감쇠에 저항:

```typescript
function computeUsageResistance(activationCount: number): number {
  // 활성화 횟수가 많을수록 감쇠 저항
  return 1 - usageDecayRate * (1 / (1 + activationCount))
}
```

### 4.3 결합 감쇠

```typescript
function computeCombinedDecay(
  eventDecay: number,
  usageResistance: number,
  salience: number,          // NEW: 중요도가 높으면 감쇠 저항
  eventWeight: number = 0.6,
  salienceWeight: number = 0.2,
): number {
  const baseFactor = eventDecay ** eventWeight * usageResistance ** (1 - eventWeight)
  const salienceBoost = 1 + (salience * salienceWeight)  // 중요한 기억은 감쇠 감소
  return Math.min(1.0, baseFactor * salienceBoost)
}
```

---

## 5. Consolidation Pipeline (기억 정리)

### 5.1 설계 원칙

사람의 수면 중 기억 정리를 모방하되, **과도한 압축과 데이터 왜곡을 방지**:

- 원본(Raw Conversations)은 절대 변경하지 않음
- Facts를 삭제하지 않고 `consolidated: true` 플래그 처리
- 정리 결과는 상위 레이어(Schema, Identity)에 **새로 생성**
- 롤백 가능한 설계

### 5.2 Consolidation 단계

```
Phase 1: Prune (가지치기)
  → effectiveWeight < threshold인 edges 비활성화
  → 고아 anchors 비활성화
  → 삭제가 아닌 soft-delete (archived = true)

Phase 2: Merge (유사 기억 통합)
  → 코사인 유사도 > 0.92인 Facts를 그룹핑
  → 그룹 대표 Fact 선정 (가장 높은 salience/confidence)
  → 나머지는 consolidated = true, mergedInto = 대표 Fact ID

Phase 3: Promote (패턴 승격)
  → 3회 이상 반복 등장하는 Fact 패턴 → Schema 후보
  → 여러 Episode에 걸쳐 나타나는 주제 → Concept 강화
  → LLM에게 "이 기억들에서 패턴이 보이는가?" 질의

Phase 4: Crystallize (결정화)
  → Schemas에서 사용자/조직의 행동 경향 추출
  → Identity Layer에 반영
  → "이 사람은 X를 중시하고 Y를 싫어한다" 수준의 요약
```

### 5.3 Consolidation Job

```typescript
interface ConsolidationJob {
  id: string
  triggeredBy: 'session_count' | 'turn_count' | 'manual'
  phases: ConsolidationPhase[]
  status: 'pending' | 'running' | 'completed' | 'failed'

  // 안전장치
  dryRun: boolean              // true면 변경 없이 리포트만
  rollbackSnapshot: string     // 실행 전 상태 스냅샷 ID

  // 결과
  prunedEdges: number
  mergedFacts: number
  newSchemas: number
  identityUpdated: boolean
}
```

---

## 6. Salience (중요도/감정 태깅)

### 6.1 개념

모든 기억이 동일한 중요도가 아니다. 사용자가 강조·반복·감정을 담은 내용은 더 강하게 저장.

```typescript
interface Fact {
  // 기존 필드 유지
  confidence: number     // LLM 추출 확신도

  // NEW
  salience: number       // 0.0 ~ 1.0, 감정적/맥락적 중요도
  salienceFactors: {
    emotionalIntensity: number   // 사용자 감정 강도
    repetitionCount: number      // 같은 내용 반복 횟수
    explicitEmphasis: boolean    // "중요!", "꼭 기억해" 등 명시적 강조
    contradictsPrior: boolean    // 기존 지식과 모순 (놀라움)
    userCorrected: boolean       // 사용자가 정정한 내용
  }
}
```

### 6.2 Salience 계산

```typescript
function computeSalience(factors: SalienceFactors): number {
  let score = 0.3  // 기본값

  if (factors.explicitEmphasis)  score += 0.3
  if (factors.userCorrected)     score += 0.25
  if (factors.contradictsPrior)  score += 0.2

  score += Math.min(0.2, factors.repetitionCount * 0.05)
  score += factors.emotionalIntensity * 0.15

  return Math.min(1.0, score)
}
```

### 6.3 Salience의 영향

| 영향 대상 | 효과 |
|----------|------|
| Decay | salience 높으면 감쇠 저항 증가 |
| Retrieval | salience가 검색 점수에 가중 |
| Consolidation | salience 높은 Facts는 prune 대상에서 제외 |
| Identity | 고 salience 기억이 Identity 형성에 더 큰 영향 |

---

## 7. Novelty Detection (예측 오류 학습)

### 7.1 개념

예상과 다른 정보 = 더 강하게 학습. 이미 아는 정보 = 학습 약화.

### 7.2 Novelty 평가

새 Fact 추출 시, 기존 Facts와 비교:

```typescript
interface NoveltyAssessment {
  noveltyScore: number         // 0.0 ~ 1.0
  type: 'new' | 'reinforcing' | 'contradicting' | 'refining'
  relatedFactIds: string[]     // 관련된 기존 Facts
}

async function assessNovelty(
  newFact: ExtractedFact,
  existingFacts: Fact[],       // 벡터 유사도로 후보 필터링
): Promise<NoveltyAssessment> {
  // 1. 유사 Fact 검색 (코사인 유사도 > 0.7)
  // 2. 유사한 게 없으면 → type: 'new', novelty: 0.8
  // 3. 유사하고 내용 일치 → type: 'reinforcing', novelty: 0.1
  // 4. 유사하지만 내용 모순 → type: 'contradicting', novelty: 1.0
  // 5. 유사하고 내용 확장 → type: 'refining', novelty: 0.5
}
```

### 7.3 Novelty의 영향

| type | Hebbian 학습률 | Salience 영향 | 기존 Fact 처리 |
|------|-------------|-------------|--------------|
| `new` | η × 1.5 | +0.2 | — |
| `reinforcing` | η × 0.5 | 기존 유지 | activationCount++ |
| `contradicting` | η × 2.0 | +0.3 | supersededBy 설정 |
| `refining` | η × 1.0 | +0.1 | 연결 edge 생성 |

---

## 8. Context-Dependent Retrieval (문맥 의존 검색)

### 8.1 개념

현재 대화의 전체 맥락이 검색에 영향. 단순 쿼리 매칭이 아닌 "지금 상황에서 떠올릴 만한 기억".

### 8.2 구현

```typescript
interface ContextAwareQuery {
  query: string                    // 현재 질문
  conversationContext: string[]    // 최근 N턴의 대화 내용
  activeSchemas: Schema[]          // 현재 활성화된 스키마
  currentMood?: string             // 감지된 분위기 (optional)
}

// 검색 점수 = α·sim(query, anchor) + β·sim(context, anchor) + γ·schemaBoost
// α = 0.5, β = 0.3, γ = 0.2
```

---

## 9. Schema Layer (행동 패턴 인식)

### 9.1 개념

반복된 경험에서 추상적 행동 틀을 형성. "이 사용자는 X 상황에서 보통 Y를 원한다."

### 9.2 데이터 모델

```typescript
interface Schema {
  id: string
  name: string                     // "code_review_pattern"
  description: string              // "코드 리뷰 시 성능→보안→가독성 순 관심"

  triggerConditions: string[]      // 이 스키마가 활성화되는 조건
  expectedBehavior: string         // 예상되는 행동/요구
  confidence: number               // 패턴 확신도 (관측 횟수 기반)

  sourceEpisodeIds: string[]       // 근거가 된 Episodes
  sourceFactIds: string[]          // 근거가 된 Facts
  observationCount: number         // 패턴 관측 횟수

  createdAt: string
  lastObservedAt: string
}
```

### 9.3 Schema 생성 (Consolidation Phase 3에서)

```
입력: 최근 정리 대상 Episodes + Facts
처리: LLM에게 패턴 발견 요청

프롬프트 예시:
  "다음 에피소드들에서 반복되는 행동 패턴을 찾아라:
   [episodes]
   - 사용자가 특정 상황에서 항상 하는 행동이 있는가?
   - 사용자의 선호도에서 일관된 경향이 보이는가?
   - 사용자가 특정 주제에 대해 예측 가능한 반응을 보이는가?"
```

---

## 10. Meta-Cognition Layer (메타인지)

### 10.1 개념

자신의 기억 상태를 인식하는 능력. "내가 뭘 알고, 뭘 모르는지 안다."

단순 RAG는 검색 결과를 그대로 전달하지만, 메타인지가 있는 시스템은:
- "이 주제에 대해 확실한 기억이 있다" vs "불확실한 기억이 있다" vs "기억이 없다"를 구분
- "예전에 이 사람이 다른 말을 했었는데..." 같은 모순 감지
- 기억의 공백(gap)을 인식하고 질문으로 채우려 시도

### 10.2 데이터 모델

```typescript
interface MetaCognitionState {
  // 지식 영역별 자신감 맵
  domainConfidence: Map<string, {
    domain: string           // "user_preferences", "project_architecture", etc.
    confidence: number       // 0-1, 해당 영역 기억의 충실도
    factCount: number        // 관련 Fact 수
    avgSalience: number      // 평균 중요도
    lastUpdated: string      // 마지막 갱신 이벤트
    knownGaps: string[]      // 인식된 지식 공백
  }>

  // 모순 감지 로그
  contradictions: {
    factA: string
    factB: string
    detectedAt: string
    resolved: boolean
    resolution?: string
  }[]

  // 기억 품질 지표
  overallHealth: {
    totalFacts: number
    activeFacts: number        // archived 아닌 것
    avgConfidence: number
    avgSalience: number
    schemaCount: number
    identityCoherence: number  // Identity 일관성 점수
  }
}
```

### 10.3 메타인지 활용

**컨텍스트 주입 시:**
```
기존: "관련 기억: [facts]"
변경: "관련 기억: [facts]
      확신도: 이 주제에 대해 7건의 기억이 있으며 확신도 0.82.
      주의: Fact#123과 Fact#456이 모순됨 — 최신(#456) 우선 적용.
      공백: 사용자의 백엔드 선호도에 대한 기억 없음."
```

**능동적 질문 생성:**
```typescript
interface ActiveInquiry {
  question: string        // "혹시 백엔드는 어떤 언어를 선호하시나요?"
  reason: string          // "프론트엔드 선호는 알지만 백엔드는 기억 없음"
  targetDomain: string    // "technical_preferences"
  priority: number        // 공백의 중요도
}
```

---

## 11. Identity Layer (자아 형성)

### 11.1 개념

축적된 기억·스키마·메타인지에서 **자아(Identity)**를 형성한다.

Identity는 단일 사용자의 개인 비서 자아일 수도 있고, 여러 사용자의 입력을 종합한 **조직의 자아**일 수도 있다.

```
개인 모드:
  사용자 A의 대화 → 기억 축적 → "A의 개인 비서" 자아 형성
  "이 사람을 잘 아는 친구"처럼 행동

조직 모드:
  직원 A, B, C의 대화 + 대표의 철학
  → 기억 축적 → "회사를 대표하는 객체" 자아 형성
  "이 회사의 문화와 가치를 체화한 존재"처럼 행동
```

### 11.2 데이터 모델

```typescript
interface Identity {
  id: string
  type: 'personal' | 'organizational'

  // 핵심 성격/가치관 (Consolidation에서 점진적 갱신)
  coreTraits: {
    trait: string              // "실용주의적", "품질 중시", "빠른 실행 선호"
    confidence: number         // 관측 빈도 기반 확신도
    sourceSchemaIds: string[]  // 근거 스키마
    sourceFactIds: string[]    // 근거 사실
  }[]

  // 가치관 (무엇을 중시/경시하는가)
  values: {
    value: string              // "코드 가독성", "사용자 경험", "빠른 배포"
    weight: number             // 0-1, 중요도
    evidence: string[]         // 근거 요약
  }[]

  // 커뮤니케이션 스타일
  communicationStyle: {
    preferred: string[]        // "간결한 답변", "코드 예시 포함"
    avoided: string[]          // "장황한 설명", "불필요한 이모지"
  }

  // 전문 영역 맵
  expertiseMap: {
    domain: string             // "React", "시스템 설계", "AI/ML"
    level: 'novice' | 'intermediate' | 'advanced' | 'expert'
    evidence: string[]
  }[]

  // 조직 모드 전용
  organizational?: {
    mission: string            // 조직의 미션
    culture: string[]          // 문화 키워드
    decisionPatterns: string[] // 의사결정 패턴
    contributors: {            // 기여자별 영향도
      userId: string
      role: string
      influenceWeight: number
    }[]
  }

  // 진화 이력
  evolutionHistory: {
    version: number
    updatedAt: string
    triggeredBy: string        // consolidation job ID
    changes: string[]          // 변경 요약
  }[]

  version: number
  createdAt: string
  updatedAt: string
}
```

### 11.3 Identity 형성 프로세스

```
Consolidation Phase 4: Crystallize

  입력:
    - 현재 Identity (있으면)
    - 최근 생성/갱신된 Schemas
    - 고 salience Facts
    - Meta-Cognition 상태

  처리:
    LLM에게 "이 기억들로부터 이 사용자/조직의 성격을 업데이트하라"

    제약:
      - 기존 Identity의 급격한 변경 방지 (변경률 상한)
      - 충분한 근거(sourceFactIds) 없는 trait 추가 금지
      - 모순되는 traits 감지 시 Meta-Cognition에 기록

  출력:
    - 갱신된 Identity
    - evolutionHistory에 변경 기록 추가
```

### 11.4 Identity 활용

**컨텍스트 주입 시 최우선 삽입:**

```
[System Prompt에 주입]

당신은 다음과 같은 사용자를 돕는 에이전트입니다:
- 성격: 실용주의적, 빠른 실행을 선호하며 코드 품질에 집착
- 가치관: 사용자 경험 > 성능 > 코드 미학
- 전문성: React (expert), 시스템 설계 (advanced), AI/ML (intermediate)
- 소통 스타일: 간결한 답변 선호, 코드 예시 필수
- 현재 맥락: [관련 기억에서 주입]
```

---

## 12. Multi-Agent Identity (조직 모드)

### 12.1 구조

```
┌─────────────────────────────────────┐
│         Organizational Identity      │
│  mission, culture, decisionPatterns  │
├──────────┬──────────┬───────────────┤
│ 대표 채팅 │ 직원A 채팅│ 직원B 채팅    │
│ weight:0.4│weight:0.3│ weight:0.3    │
└──────────┴──────────┴───────────────┘
```

### 12.2 Contributor 관리

```typescript
interface ContributorConfig {
  userId: string
  role: string                    // "ceo", "lead_engineer", "designer"
  influenceWeight: number         // 0-1, Identity 형성 기여도
  factFilter?: FactCategory[]     // 이 사용자에게서 추출할 Fact 유형
}

// CEO의 철학/가치관 → Identity.values에 높은 weight로 반영
// 엔지니어의 기술 결정 → Identity.expertiseMap에 반영
// 디자이너의 선호도 → Identity.communicationStyle에 반영
```

### 12.3 충돌 해결

직원 간 모순되는 기억이 있을 때:
1. influenceWeight가 높은 contributor 우선
2. 최신 기억 우선
3. 해결 불가 시 Meta-Cognition.contradictions에 기록
4. 다음 대화에서 능동적으로 확인 질문

---

## 13. Database Schema 확장

기존 테이블 유지 + 다음 추가:

```sql
-- 이벤트 기반 생명주기 상태
CREATE TABLE lifecycle_state (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  turns_since_last_decay INTEGER DEFAULT 0,
  turns_since_last_consolidation INTEGER DEFAULT 0,
  total_turns_processed INTEGER DEFAULT 0,
  total_sessions_completed INTEGER DEFAULT 0,
  total_consolidations INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Facts 확장 컬럼
-- ALTER TABLE facts ADD COLUMN salience REAL DEFAULT 0.3;
-- ALTER TABLE facts ADD COLUMN novelty_score REAL DEFAULT 0.5;
-- ALTER TABLE facts ADD COLUMN novelty_type TEXT DEFAULT 'new';
-- ALTER TABLE facts ADD COLUMN consolidated BOOLEAN DEFAULT FALSE;
-- ALTER TABLE facts ADD COLUMN merged_into TEXT REFERENCES facts(id);
-- ALTER TABLE facts ADD COLUMN events_since_last_access INTEGER DEFAULT 0;

-- Schemas
CREATE TABLE schemas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  trigger_conditions TEXT NOT NULL,    -- JSON array
  expected_behavior TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  source_episode_ids TEXT NOT NULL,    -- JSON array
  source_fact_ids TEXT NOT NULL,       -- JSON array
  observation_count INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  last_observed_at TEXT NOT NULL
);

-- Meta-Cognition
CREATE TABLE meta_cognition_domains (
  domain TEXT PRIMARY KEY,
  confidence REAL DEFAULT 0.5,
  fact_count INTEGER DEFAULT 0,
  avg_salience REAL DEFAULT 0.3,
  known_gaps TEXT NOT NULL DEFAULT '[]',  -- JSON array
  last_updated TEXT NOT NULL
);

CREATE TABLE meta_cognition_contradictions (
  id TEXT PRIMARY KEY,
  fact_a_id TEXT NOT NULL REFERENCES facts(id),
  fact_b_id TEXT NOT NULL REFERENCES facts(id),
  description TEXT,
  detected_at TEXT NOT NULL,
  resolved BOOLEAN DEFAULT FALSE,
  resolution TEXT
);

-- Identity
CREATE TABLE identity (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('personal', 'organizational')),
  core_traits TEXT NOT NULL DEFAULT '[]',        -- JSON
  values TEXT NOT NULL DEFAULT '[]',             -- JSON
  communication_style TEXT NOT NULL DEFAULT '{}', -- JSON
  expertise_map TEXT NOT NULL DEFAULT '[]',       -- JSON
  organizational TEXT,                            -- JSON, nullable
  evolution_history TEXT NOT NULL DEFAULT '[]',   -- JSON
  version INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Consolidation 작업 이력
CREATE TABLE consolidation_jobs (
  id TEXT PRIMARY KEY,
  triggered_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  phases_completed TEXT NOT NULL DEFAULT '[]',   -- JSON
  pruned_edges INTEGER DEFAULT 0,
  merged_facts INTEGER DEFAULT 0,
  new_schemas INTEGER DEFAULT 0,
  identity_updated BOOLEAN DEFAULT FALSE,
  started_at TEXT,
  completed_at TEXT,
  error TEXT
);

-- Contributor (조직 모드)
CREATE TABLE contributors (
  user_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  influence_weight REAL DEFAULT 0.5,
  fact_filter TEXT,                              -- JSON array, nullable
  created_at TEXT NOT NULL
);
```

---

## 14. Event Flow (전체 흐름)

```
사용자 메시지 수신
  │
  ├─→ IngestService.appendMessage() [불변 저장]
  │
  ├─→ TurnExtractionPipeline [매 턴]
  │     ├─ FactExtractor (LLM) → Facts
  │     ├─ SalienceComputer → salience 태깅
  │     ├─ NoveltyDetector → novelty 평가
  │     │   └─ contradicting → MetaCognition.contradictions 기록
  │     └─ HebbianUpdater → co-activated edges 강화
  │
  ├─→ LifecycleManager.onTurnCompleted()
  │     └─ if threshold reached → EventDecay 실행
  │
  ├─→ DualPathRetriever [응답 생성 시]
  │     ├─ ContextAwareQuery (대화 맥락 포함)
  │     ├─ Vector + Graph 병렬 검색
  │     ├─ ResultMerger + salience 가중
  │     └─ MetaCognition 상태 첨부 (확신도, 모순, 공백)
  │
  └─→ ContextInjector
        ├─ Identity → System Prompt 주입
        ├─ 관련 기억 → Context 주입
        └─ MetaCognition 주석 → 불확실성 표시


세션 종료 시
  │
  ├─→ BatchPipeline [기존]
  │     ├─ EpisodeBatchExtractor → Episodes
  │     └─ ConceptBatchExtractor → Concepts
  │
  └─→ LifecycleManager.onSessionCompleted()
        └─ if threshold reached → ConsolidationPipeline
              ├─ Phase 1: Prune (약한 edges/anchors 비활성화)
              ├─ Phase 2: Merge (유사 Facts 통합)
              ├─ Phase 3: Promote (반복 패턴 → Schemas)
              ├─ Phase 4: Crystallize (Identity 갱신)
              └─ MetaCognition 갱신 (domain confidence, gaps)
```

---

## 15. Configuration

```typescript
interface NeroMemConfig {
  // 기존 설정 유지
  llmProvider: LLMProviderConfig
  embeddingProvider: EmbeddingProviderConfig
  database: DatabaseConfig

  // Lifecycle (NEW)
  lifecycle: {
    decayTriggerTurns: number              // default: 50
    consolidationTriggerSessions: number   // default: 5
    consolidationTriggerTurns: number      // default: 200
    identityUpdateTrigger: number          // default: 3
  }

  // Decay (MODIFIED)
  decay: {
    halfLifeEvents: number                 // default: 100
    usageDecayRate: number                 // default: 0.1
    salienceWeight: number                 // default: 0.2
    pruneThreshold: number                 // default: 0.05
  }

  // Salience (NEW)
  salience: {
    defaultScore: number                   // default: 0.3
    emphasisBoost: number                  // default: 0.3
    correctionBoost: number                // default: 0.25
    contradictionBoost: number             // default: 0.2
  }

  // Retrieval (MODIFIED)
  retrieval: {
    vectorWeight: number                   // default: 0.4
    graphWeight: number                    // default: 0.3
    contextWeight: number                  // default: 0.2 (NEW)
    salienceWeight: number                 // default: 0.1 (NEW)
    convergenceBonus: number               // default: 0.1
  }

  // Identity (NEW)
  identity: {
    type: 'personal' | 'organizational'
    maxTraitChangeRate: number             // default: 0.2 (급변 방지)
    minEvidenceForTrait: number            // default: 3
  }

  // Meta-Cognition (NEW)
  metaCognition: {
    enabled: boolean                       // default: true
    gapDetectionThreshold: number          // default: 0.3
    contradictionAutoResolve: boolean      // default: false
    activeInquiryEnabled: boolean          // default: true
  }
}
```

---

## 16. Implementation Priority

### Phase 1: Foundation (기존 코드 수정)
1. 시간 기반 → 이벤트 기반 감쇠 전환
2. `LifecycleManager` 구현 (이벤트 카운터 + 트리거)
3. Facts에 `salience`, `novelty_score` 필드 추가
4. `SalienceComputer` 구현

### Phase 2: Intelligence (새 기능)
5. `NoveltyDetector` 구현
6. `ConsolidationPipeline` 구현 (Phase 1-2: Prune + Merge)
7. `MetaCognitionManager` 구현
8. Context-Dependent Retrieval 적용

### Phase 3: Identity (핵심 차별화)
9. `Schema` 모델 + 추출 (Consolidation Phase 3)
10. `Identity` 모델 + 형성 (Consolidation Phase 4)
11. Identity 기반 System Prompt 주입
12. 능동적 질문 생성 (ActiveInquiry)

### Phase 4: Organization (확장)
13. Multi-contributor 지원
14. Organizational Identity 모드
15. Contributor 간 충돌 해결
16. 관리자 대시보드 (Identity 진화 시각화)

---

## Appendix A: Biological Mapping

| 뇌 메커니즘 | nero-mem2 구현 | 상태 |
|------------|---------------|------|
| 감각 기억 | Raw Conversations (불변) | ✅ 완성 |
| 단기 기억 | Facts (per-turn 추출) | ✅ 완성 |
| 일화 기억 | Episodes (batch 추출) | ✅ 완성 |
| 의미 기억 | Concepts (batch 추출) | ✅ 완성 |
| 시냅스 강화 | Hebbian Learning | ✅ 완성 |
| 이중 경로 검색 | Vector + Graph | ✅ 완성 |
| 허브 뉴런 | Anchors | ✅ 완성 |
| 자연적 망각 | Event-Based Decay | 🔄 전환 필요 |
| 수면 정리 | Consolidation Pipeline | 🆕 신규 |
| 감정 태깅 | Salience | 🆕 신규 |
| 예측 오류 학습 | Novelty Detection | 🆕 신규 |
| 문맥 의존 기억 | Context-Aware Retrieval | 🆕 신규 |
| 행동 스키마 | Schema Layer | 🆕 신규 |
| 메타인지 | Meta-Cognition Layer | 🆕 신규 |
| 자아/의식 | Identity Layer | 🆕 신규 |
| 편도체 (감정 중추) | Salience + Identity.values | 🆕 신규 |
| 전전두엽 (판단/계획) | Schema + Meta-Cognition | 🆕 신규 |

## Appendix B: Design Principles

1. **원본 불변**: Raw Conversations는 절대 수정하지 않는다
2. **Soft Delete**: 기억을 삭제하지 않고 비활성화한다 (롤백 가능)
3. **이벤트 기반**: 시간이 아닌 상호작용이 기억 생명주기를 결정한다
4. **점진적 형성**: Identity는 급변하지 않고 서서히 진화한다
5. **근거 추적**: 모든 상위 레이어(Schema, Identity)는 하위 근거를 참조한다
6. **자기 인식**: 시스템은 자신이 뭘 알고 모르는지 인식한다
7. **과압축 방지**: Consolidation은 정보를 새 레이어에 생성하지, 기존을 파괴하지 않는다
