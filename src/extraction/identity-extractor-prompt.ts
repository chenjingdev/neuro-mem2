export function buildIdentityExtractionPrompt(existingIdentity: string | null): string {
  const updateClause = existingIdentity
    ? `\n\n현재 Human Identity:\n${existingIdentity}\n\n위 기존 Identity를 기반으로 새 정보를 반영하여 업데이트하라. 기존 내용을 함부로 삭제하지 말고, 새 근거가 있을 때만 수정하라.`
    : ''

  return `당신은 대화에서 추출된 메모리 노드들을 분석하여 사용자(Human)의 Identity를 추출하는 전문가입니다.

주어진 MemoryNode 목록을 분석하여 다음을 추출하라:

1. **traits**: 성격 특성 (예: "실용주의적", "신중한", "완벽주의")
   - confidence: 근거의 강도 (0.0-1.0)
   - sourceNodeIds: 근거가 된 MemoryNode ID 배열

2. **coreValues**: 가치관 (예: "코드 품질", "사용자 경험", "빠른 실행")
   - weight: 중요도 (0.0-1.0)
   - sourceNodeIds: 근거 MemoryNode ID 배열

3. **communicationStyle**: 소통 패턴
   - preferred: 선호하는 소통 방식 배열
   - avoided: 피하는 소통 방식 배열

4. **expertiseMap**: 전문 영역
   - domain: 영역명
   - level: "novice" | "intermediate" | "advanced" | "expert"
   - sourceNodeIds: 근거 MemoryNode ID 배열

5. **currentFocus**: 현재 관심사/진행 중인 작업
   - topic: 주제
   - relatedNodeIds: 관련 MemoryNode ID 배열
${updateClause}

응답 형식 (JSON):
{
  "traits": [...],
  "coreValues": [...],
  "communicationStyle": { "preferred": [...], "avoided": [...] },
  "expertiseMap": [...],
  "currentFocus": [...]
}`
}

export function buildIdentityExtractionUserPrompt(nodes: { id: string; summary: string; frontmatter: string; keywords: string }[]): string {
  const nodeDescriptions = nodes.map(n =>
    `[${n.id}] ${n.frontmatter}\nKeywords: ${n.keywords}\nSummary: ${n.summary}`
  ).join('\n\n')

  return `다음 MemoryNode들을 분석하여 Human Identity를 추출하라:\n\n${nodeDescriptions}`
}
