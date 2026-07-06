# 리서치: 오케스트레이터 모델 격차(Fable ↔ Opus)를 줄이는 방법

프롬프팅(보정·오버라이드·ultrathink)은 v0.6.x에서 소진했다. 이 문서는 그 **바깥**의 레버들 —
테스트타임 컴퓨트, 검증자 스케일링, 라우팅 — 을 연구 근거와 함께 우리 시스템에 매핑한다.

## 연구 근거 요약

1. **검증자(verifier)가 있으면 약한 생성자가 강한 생성자를 따라잡는다.**
   같은 검증자를 쓰면 약한 모델의 best-of-N이 14배 큰 모델 단발 성능을 넘어설 수 있고,
   compute-optimal 전략은 단순 best-of-N 대비 4배 효율적이다. 단, 검증자 이득은
   난이도 중간 구간에서 가장 크고, 아주 쉽거나 아주 어려운 문제에선 줄어든다.
2. **캐스케이드/에스컬레이션 라우팅**: 질의의 15–35%만 프론티어 모델로 올려도
   품질의 95–97%를 유지하며 비용을 45–85% 절감한 사례가 반복 보고됨.
   → "전부 Fable"이 아니라 "어디에 Fable을 쓰는가"의 문제.
3. **다중 에이전트 토론(MAD)은 과대평가**: 단일 에이전트 정확도가 45%를 넘는 영역에선
   증가분이 없거나 음수라는 결과가 반복됨. 단 **비대칭 maker–checker**(싼 생성자 +
   강한 검증자)는 유효 — 우리의 적대적 리뷰가 이미 이 형태다.

## 우리 시스템 매핑 (우선순위순)

### P0 — Fable을 워커 모델로 (에스컬레이션 라우팅) ✅ v0.6.3 구현
A/B에서 확인된 격차는 전부 **설계(계약 해상도)와 검증 공격성**에서 나왔다. 그렇다면
Fable을 메인에 앉힐 필요 없이, **Opus 오케스트레이터가 설계 자문·적대 리뷰 태스크만
`model: claude-fable-5`로 dispatch**하면 된다:

```
Opus 메인 (풍부한 쿼터) ── 분해·통합·검증 실행
   ├─ 계약 초안/리뷰 → Fable 워커 (주간 쿼터를 외과적으로만 소모)
   └─ 구현 태스크들 → Opus/Sonnet 워커
```

- 전제: 해당 워커 계정 플랜에 Fable 접근 권한 (Max 등)
- Fable 주간 쿼터는 별도 풀이므로, 설계 자문 1–2회/빌드 정도는 지속 가능
- 검증자 연구와도 정합: 이득이 가장 큰 "중~상 난이도" 지점(계약 설계)에 강한 모델을 배치

### P1 — 계약 토너먼트 (best-of-N + judge)
가장 근거가 강한 기법을 격차의 근원에 직접 적용: 어려운 빌드에서 **독립 계약 초안
2–3개를 병렬 dispatch(ultrathink) → 판정자(가능하면 Fable 워커)가 병합**.
현재 도구(dispatch_tasks)만으로 정책 수준에서 실행 가능 — v0.6.3 정책에 패턴 추가.
추후 전용 도구(`dispatch_contest`: 초안 N + 자동 judge 단계)로 승격 검토.

### P1 — 비대칭 maker–checker 강화
적대적 리뷰(이미 존재)의 **checker 모델을 maker보다 높게**: Opus가 만든 것은
Fable(가능 시) 또는 다른 계정의 Opus가 리뷰. 연구상 40–60% 비용으로 품질 개선.

### P2 — 크로스 세션 lessons 스토어
Reflexion 계열: `.orchestrator/plan.md`의 lessons를 워크스페이스 횡단
`~/.fable-orchestrator/lessons.md`로 승격, 브리핑 응답에 최근 lessons 요약을 동봉
→ 실패가 조직 기억으로 누적. (구현 간단, 효과는 누적형)

### P2 — 난이도 기반 에스컬레이션 자동화
지금은 정책이 "언제 Fable 워커를 쓸지"를 오케스트레이터 판단에 맡긴다.
추후: 실패/재dispatch 발생 시 자동으로 다음 시도를 상위 모델로 올리는
캐스케이드 규칙을 서버에 내장 (에스컬레이션 15–35% 대역 유지).

### 채택하지 않음
- **대칭 다중 토론(MAD)**: 근거 부족 + 토큰 비용. 비대칭 리뷰로 대체.
- **동일 태스크 단순 N회 반복 후 다수결**: 코드 산출물엔 병합 비용이 커서 계약
  단계(텍스트 산출물)에만 토너먼트로 한정.

## 남는 격차 (정직한 한계)
검증자·라우팅으로 좁혀지는 것은 "결과물 품질"이다. Fable의 **탐색 중 실시간 예지**
(문제를 풀다가 옆의 함정을 알아채는 것)는 구조로 근사할 뿐 복제되지 않는다 —
그 부분이 진짜 필요한 작업은 메인을 Fable로 돌리는 게 맞다.

## 출처
- [Scaling LLM Test-Time Compute Optimally (arXiv:2408.03314)](https://arxiv.org/abs/2408.03314)
- [Variation in Verification (arXiv:2509.17995)](https://arxiv.org/html/2509.17995v2)
- [Cluster, Route, Escalate: Cascaded Framework for Cost-Aware LLM Serving (arXiv:2606.27457)](https://arxiv.org/abs/2606.27457)
- [Is Escalation Worth It? Decision-Theoretic Characterization of LLM Cascades (arXiv:2605.06350)](https://arxiv.org/pdf/2605.06350)
- [LLM Routing and Model Cascades (tianpan.co)](https://tianpan.co/blog/2025-11-03-llm-routing-model-cascades)
- [Multi-LLM-Agents Debate — Performance, Efficiency, and Scaling (ICLR Blogposts 2025)](https://d2jud02ci9yv69.cloudfront.net/2025-04-28-mad-159/blog/mad/)
- [Beyond the Strongest LLM: Multi-Turn Multi-Agent Orchestration (arXiv:2509.23537)](https://arxiv.org/pdf/2509.23537)
- [Multi-Agent Orchestration Patterns for Production (beam.ai)](https://beam.ai/agentic-insights/multi-agent-orchestration-patterns-production)
