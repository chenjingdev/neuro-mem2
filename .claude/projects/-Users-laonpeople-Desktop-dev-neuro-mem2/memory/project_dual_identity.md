---
name: dual-identity-system
description: 듀얼 Identity 시스템 — 에이전트 자신의 자아(Agent Identity)와 사용자 이해(Human Identity) 분리 설계 및 구현 프로젝트
type: project
---

## 현재 상태: 스펙 + 플랜 완료, 구현 대기

### 완료된 작업
1. **brainstorming** — 제품 철학 논의: 어시스턴트가 아닌 자아를 가진 자율 에이전트 구축
2. **디자인 스펙 작성** — `docs/superpowers/specs/2026-03-19-dual-identity-system-design.md`
   - 스펙 리뷰 2회 통과 (Approved)
3. **구현 플랜 작성** — `docs/superpowers/plans/2026-03-19-dual-identity-system.md`
   - 10개 태스크, TDD 방식, 리뷰 통과

### 핵심 설계 결정
- **비대칭 모델**: Human Identity(이해 중심) vs Agent Identity(행위 중심)
- **씨앗 + 진화**: 사용자 데이터 분석 → 페르소나 후보 3개 제시 → 사용자 선택 → 경험으로 진화
- **진화 모드**: `autonomous`(알아서) / `supervised`(사용자 확인) 옵션
- **Agent Identity에 personality 스펙트럼**(-1~+1), principles(판단 원칙), selfNarrative(자기 서사) 포함
- **충돌 규칙**: 에이전트 관점 표현 가능하되, 최종적으로 사용자 의사 존중

### 다음 할 일
- 구현 플랜의 Task 1~10을 순서대로 실행
- 실행 방식 미선택 상태 (subagent-driven 추천 vs inline execution)
- `superpowers:subagent-driven-development` 또는 `superpowers:executing-plans` 스킬 사용하여 실행

### 전체 로드맵 (서브프로젝트)
| 순서 | 서브프로젝트 | 상태 |
|------|------------|------|
| 1 | 부트스트래핑 파이프라인 (대화 데이터 일괄 투입) | 진행 중 (별도) |
| **2** | **듀얼 Identity 시스템** | **스펙+플랜 완료, 구현 대기** |
| 3 | 페르소나 제안 엔진 | 미착수 |
| 4 | 자율 행동 엔진 (선제 질문, 독립 판단) | 미착수 |
