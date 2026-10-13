# AI SRE Ops 플랫폼 기획서

- 작성일: 2026-10-13
- 대상: `lineth-l2-gitops` (`lineth-local` 클러스터) — **L2 우선**, L1은 P3
- 상태: 설계 합의 완료 (grill 세션 Q1–Q24)

## 1. 배경과 문제

- 관측 스택(Prometheus/Grafana/Loki/Tempo, alert 21개, SLO 생성기)은 갖춰져 있으나 **운영 흐름**이 비어 있음.
  - alert 이력: `alert-sink` 메모리 200건, 재시작 시 소실
  - 실시간 incident 상태 저장소 없음 — postmortem으로 사후에만 남음
  - `runbook_url` 보유 alert: L2 21개 중 1개, L1 0개
  - 대시보드/alert/SLO가 인프라 매니페스트와 같은 디렉토리에 섞여 있음
- 근거 사례: **INC-2026-10-11-11** — prover OOM 루프 → coordinator backpressure → finalization 27시간 정지. 여러 alert가 따로 울렸고, 진행 중이던 CHG(D3-b)가 중단된 사실이 교대 간 전달 대상이었음.

## 2. 목표 / 비목표

**목표**
1. 글로벌(US/EU/APAC) 근무자가 같은 화면에서 장애 상황, 우선순위, 역할 분담을 공유
2. 컴포넌트·구간별 장애 단계를 **사전 정의된 영향 모델**로 즉시 해석
3. 메트릭·대시보드·alert·runbook·토폴로지를 **코드로 관리**(Detection as Code)
4. 교대·incident 종료 시점의 문서 작업을 AI가 초안 작성

**비목표**
- 시계 동기화 자체(NTP) — 동기화돼 있다고 가정
- AI의 클러스터 직접 변경(kubectl 자동 조치) — 하지 않음
- Grafana 대체 — 깊은 분석은 Grafana/Explore로 넘김

## 3. 사용자

| 사용자 | 주요 작업 |
|---|---|
| On-call SRE (3교대) | 큐 확인, incident 후보 승격, runbook 수행, 인수인계 |
| Incident Lead (IC/Ops/Comms/Planning) | 상황판 갱신, 역할 수행 |
| 탐지 로직 작성자 | alert/SLO/대시보드/catalog/runbook PR |

## 4. 기능 요구사항

### F1. 리전 시간 표시
- 계산·저장 기준: **UTC** (로그 원본 = UTC, DST 없음)
- 상단 바: `UTC │ ET │ 서울 │ CET │ 현재 shift (남은 시간)`, 본인 리전 강조
- DST 전환 7일 이내 ⚠ 배지 (예: EU 10/25, US 11/1 사이 시차 변동)
- 모든 시각 표기: `07:42 UTC (서울 16:42, +9h)`, hover 시 3개 리전
- 구현: 브라우저 `Intl.DateTimeFormat`, 라이브러리 없음

### F2. 메트릭·대시보드 as Code
- 별도 repo **`lineth-observability`**: alert rule, SLO 테이블/생성기, 대시보드 JSON, catalog, runbook
- `lineth-l2-gitops`는 실행 기반(helmrelease)만 유지, `GitRepository`+`Kustomization`으로 tag 고정 참조
- CODEOWNERS = SRE
- CI
  - `promtool check rules` + **`promtool test rules`** (alert 단위 테스트)
  - `dashboard-linter`, 대시보드 `uid` 고정·`${datasource}` 변수 검사
  - `mimirtool analyze`로 참조 메트릭 vs 실제 수집 메트릭 비교 — **깨진 참조 시 실패**
  - 모든 alert에 runbook 연결 필수
- 대시보드 형식: JSON 유지. runtime 대시보드 중복이 실제 고통이 되면 해당 9개만 Jsonnet 전환
- 메트릭 인벤토리 탭: 서비스 / 출처(upstream·자체: 접두어 자동 분류 + `metrics-registry.yaml` 예외) / 참조처 / 상태(사용·미사용·깨짐)

### F3. 인프라 가시화
- 원본: **catalog YAML** (Topology as Code) — `components`, `edges`
- React Flow 벌집형 노드: 단계 색, 핵심 지표 1~2개
- 연결선 = 통신/의존 (`via`: RPC, Engine API, 공유 PVC 등)
- CI: catalog ↔ 실제 k8s 리소스 차이 경고

catalog 예:
```yaml
components:
  - id: prover
    layer: L2/proving
    k8s: {ns: lineth-l2, kind: Deployment, name: prover}
    health:
      metric: lineth_l2_prover_backlog
      baseline: dynamic          # 기본; 아래 tiers로 덮어쓰기 가능
      tiers: {slow: "> 5", degraded: "> 20", down: "absent or up == 0"}
    slo: [settlement-freshness]
    alerts: [LinethL2ProverBacklog, LinethL2ProverFailures, LinethL2ProverLargeRetry]
    logs: '{namespace="lineth-l2", app="prover"} |~ "OOM|retry|large"'
    runbooks: [prover-oom-loop]
edges:
  - from: coordinator
    to: prover
    via: shared PVC (request/response files)
    when_broken:
      symptom: "proof 미생성, coordinator gap backpressure"
      impact: "finalization 정지 → settlement-freshness SLO 소진, 출금 지연"
      check_logs: ['{app="coordinator"} |= "backpressure"']
      precedent: INC-2026-10-11-11
```

### F4. 장애 영향 평가
| 색 | 단계 | 기준 | 알림 |
|---|---|---|---|
| 🟢 | Normal | baseline 범위 내 | – |
| 🟡 | Slow | baseline 이탈, SLO 정상 | 화면만 |
| 🟠 | At risk | burn rate > 1 | ticket |
| 🔴 | Breach | fast-burn / down | page |
| ⚫ | Unknown | 메트릭 부재·exporter stale | 초록 금지 |

- baseline: Prometheus recording rule (7일 평균 ± 2σ), catalog에서 생성. 컴포넌트별 고정 임계값 덮어쓰기
- 노드/연결선 클릭 → **오른쪽 서랍**: 현재 단계와 근거 지표, `when_broken`(증상·영향), 확인할 로그(Loki Explore 딥링크, 시간 범위 포함), 관련 runbook, 과거 사례

### F5. 인수인계
- `shifts.yaml` (UTC): APAC 00–08 / EU 08–16 / US 16–24, 근무자 명단
- 수집 범위(이전 shift): ①열린 incident ②alert(묶음 단위, flapping 강조) ③🟡 이상 단계 변화 ④SLO 예산 변화 ⑤gitops 커밋·진행 중 CHG·Flux reconcile 실패 ⑥silence와 만료 ⑦수동 메모
- AI 출력: "확인할 것" 체크리스트, "주의 깊게 볼 것" + 링크. **모든 항목 근거 링크 필수**
- 흐름: 종료 30분 전 자동 초안 → 나가는 근무자 편집 → 들어오는 근무자 ack → 15분 미 ack 시 알림

### F6. Runbook 관리
- 위치: `lineth-observability/runbooks/*.md`
- frontmatter: `id, alerts, components, severity, impact_slo, owner, last_reviewed, automation_candidate, precedents`
- 필수 섹션(Google SRE 원칙: 완화 우선): **의미 → 영향과 심각도 → 빠른 완화 → 진단 → 근본 해결 → 에스컬레이션**
- 진단의 `promql`/`logql` 블록 = 실행 버튼(읽기 전용), 체크박스 = incident 타임라인 기록
- CI: 섹션 누락, alert 미연결, `last_reviewed` 90일 초과, 쿼리 문법
- incident 종료 시 runbook-agent가 "runbook에 없던 실제 조치" 반영 PR 초안

### F7. Incident 상황판 (Google IMAG)
- 역할 4개: **IC / Ops / Comms / Planning** (Scribe 없음 — 타임라인 자동). 미위임 역할은 IC 겸임 표시
- 구성: 상단 요약(상태·영향·단계·경과·**다음 업데이트 시각**), 역할 칸, Ops 작업 로그, 자동 타임라인, Comms 이력, Planning 후속 조치
- 단일 링크 `/incidents/INC-…`, SSE 실시간
- AI: Comms 공지 초안(30분 주기, 사람 게시), 종료 시 postmortem 초안 PR (`docs/postmortems` 템플릿)

### F8. Alert 묶기 + 우선순위 큐
- 묶기: 10분 창 + catalog `edges`로 연결된 컴포넌트 → **incident 후보**, 최상위 upstream = 원인 후보
- 승격·병합·분리는 사람(IC). 🔴 포함 후보는 상단 고정, 15분 미처리 시 재알림
- 점수(backend 결정적 계산, 근거 표시):
  `SLO 가중치 × 예산 소진도 + 영향 범위(하위 컴포넌트 수) + 지속 시간 + 악화 추세`
- SLO 가중치는 catalog에 정의 (block-production·rpc-availability 높음, settlement-freshness 중간)
- 큐 카드 → F4와 같은 서랍

### F9. Incident 생애주기
- 상태: `candidate → declared → mitigated → resolved → postmortem → closed` (+ `dismissed`). 상태 변경 시각 자동 기록
- `mitigated → resolved`: 관련 SLI 30분 정상 필요. 24시간 내 같은 원인 후보 재발 시 재오픈
- 등급 (큐에서 자동 제안, IC 확정, 변경 시 타임라인 기록)

| SEV | 기준 | page | 공지 주기 | postmortem |
|---|---|---|---|---|
| 1 | 블록 생성 중단, 자금 위험(서명/브릿지) | 즉시 | 30분 | 필수 |
| 2 | 사용자 SLO fast-burn, finalization 1시간+ 정지 | 즉시 | 1시간 | 필수 |
| 3 | slow-burn, 일부 저하 | 근무 시간 | 4시간 | 선택 |
| 4 | 영향 없음 | 없음 | – | – |

### F10. 알림과 호출
- SEV1–2 page: **ntfy**, SEV3·공유: **Slack**. 호출 단계는 플랫폼만 관리 (Alertmanager → 플랫폼 webhook 단일 경로)
- 현재 1인: ntfy → 5분 미 ack 시 ntfy 최고 우선순위 재알림 → 15분 미 ack 시 Slack + 반복. `shifts.yaml`은 다인원 구조 유지 (secondary 추가만으로 확장)
- ack: 웹앱 버튼 또는 ntfy action. ack 시각 = MTTA 원천

### F11. 감시 시스템 감시
- Prometheus/Alertmanager 고장: `Watchdog` 5분 미수신 → 플랫폼이 ntfy 직접 발송
- 웹앱/클러스터/Mac 고장: 웹앱 → healthchecks.io 1분 heartbeat, 3분 끊기면 Slack·ntfy. 전송 내용은 heartbeat뿐
- 계획된 중단: 유지보수 모드로 heartbeat 알림 일시 정지

### F12. 변경 연관
- gitops repo에 Flux `Provider`(generic-hmac → 플랫폼) + `Alert`(전체 Kustomization/HelmRelease) → 타임라인 "변경 이벤트"
- CHG 템플릿에 frontmatter (`id, status, risk, window, components`), CI에서 `components` ↔ catalog 검사. 기존 CHG 백필
- 상단 바 "진행 중 변경" 배너. 후보 발생 시 최근 2시간 내 같은/상위 컴포넌트 변경 → "변경 연관 의심 ⚠" (점수 미반영, 롤백 판단 단서)
- 작업 시간대 alert는 자동 억제하지 않고 "변경 중" 표시만

### F13. 장기 incident 운영
- **IC 체크포인트**: 상태 한 줄 / 가설 / 진행 중 조치와 예상 완료 / **깨우기 조건(PromQL)** / 다음 할 일 / 인수자. AI 초안 → IC 확정
- 깨우기 조건은 incident가 열려 있는 동안만 플랫폼 임시 감시 규칙으로 실행 → ntfy page, 종료 시 삭제 (타임라인 기록)
- F5 인수인계 최상단에 열린 incident의 최신 체크포인트
- 타임라인 "결정" 항목: 결정 / 검토한 대안 / 이유 / 되돌릴 조건 → postmortem "Response and recovery"로 자동 반영

### F14. 사후 관리
- 후속 조치: postmortem Action items 행 → GitHub issue (사람이 버튼으로 생성, 라벨 `incident:*`, `type:prevent|detect|mitigate`). `closed` 전환 조건 = issue 전부 생성. 미해결 수를 인수인계·목록에 표시, 30일 초과 강조
- Reliability 탭: MTTD/MTTA/MTTM/MTTR, 컴포넌트별 incident 수, 재발(30일 내 같은 원인). `/metrics` 노출 → observability repo 대시보드
- **오류 예산 정책**: 28일 예산 소진 SLO 관련 컴포넌트를 건드리는 CHG는 `approved` 불가 (CI에서 CHG `components` ↔ SLO 상태 대조). 예외: 신뢰성 개선·긴급 변경. 정책 문서 `error-budget-policy.md`는 observability repo
  - 참고: INC-10-11(27h)은 settlement-freshness 99% 28일 예산(약 6.7h)의 약 4배

## 5. 아키텍처

```
Alertmanager ──webhook──▶ ai-sre-ops (Next.js, in-cluster) ──▶ ntfy (page) / Slack
Flux notification ──webhook──▶ │ (변경 이벤트)          ──heartbeat──▶ healthchecks.io
Prometheus/Loki/Tempo ◀──query── │  ├ UI: 시계 / 벌집 / 서랍 / 큐 / 상황판 / runbook
                                  │  ├ API + 주기 작업: 묶기, 점수, 인수인계 수집
                                  │  └ Postgres (전용): alert, incident, 타임라인, 인수인계
                                  │──A2A──▶ Kagent (handoff / triage / runbook agent)
                                  │            └ ModelConfig: Ollama @ host.docker.internal:11434
lineth-observability (git) ──read── catalog, runbooks, SLO 가중치
lineth-l2-gitops (git) ──Flux── apps/ai-sre-ops, kagent, observability 참조
```

| 층 | 선택 |
|---|---|
| 웹 | Next.js App Router 단일 앱, SSE, React Flow |
| DB | Postgres 전용 (kagent DB와 분리) |
| 인증 | oauth2-proxy + GitHub OAuth |
| Agent | Kagent CRD (Flux 관리) |
| LLM | **Ollama on Mac host**, `gpt-oss:20b`, `num_ctx` 16k, `KEEP_ALIVE=5m`, `MAX_LOADED_MODELS=1` |

**AI 역할 경계**: LLM은 요약·원인 설명·runbook 매칭·초안 작성만. 큐 점수·묶기·시간 변환은 결정적 로직 — 모델 장애 시에도 핵심 화면 동작. agent 입력은 catalog `when_broken`·runbook·precedent를 먼저 검색해 주입(RAG).

## 6. 보안

- AI 권한 1단계: **읽기 전용**. 2단계: 조치 = gitops PR 제안, 사람 merge. kubectl 직접 조치 없음
- kagent-tools: agent별 `toolNames` 허용 목록 + **ServiceAccount를 읽기 전용 ClusterRole로 교체 (`secrets` 제외)**
- grafana-mcp: Viewer 계정, `vault`·`signing` 로그는 Loki tenant/Alloy 단계에서 분리
- 웹앱: k8s 권한 없음
- LLM 로컬 실행 → 외부 전송 없음

## 7. 단계

| 단계 | 범위 |
|---|---|
| **P0 기반** | observability repo 분리, CI, L2 catalog, 기존 alert runbook 연결, Flux Provider/Alert, CHG frontmatter + 백필, 오류 예산 정책 문서 |
| **P1 MVP (L2, AI 없음)** | F1, F3, F4, F6, F7, F8, F9, F10, F11, F12, F13(수동 작성), F14, F5(원본 수집만) |
| **P2 AI** | Kagent + Ollama, agent 3개, 공지·postmortem·runbook PR·체크포인트 초안, 메트릭 인벤토리 |
| **P3 확장** | L1 catalog, agent 조치 PR 제안, 캘린더/on-call 연동 |

## 8. MVP 완료 기준 — INC-2026-10-11-11 재현

prover 메모리 limit 축소 또는 Prometheus backfill 재생 후:
- [ ] alert 4개 이상이 incident 후보 1건으로 묶이고 원인 후보 = `prover`
- [ ] 벌집: prover 🔴, coordinator 🟠, settlement 🟠, coordinator→prover 연결선 강조
- [ ] 연결선 클릭 → 서랍에 `when_broken`과 `prover-oom-loop` runbook
- [ ] 기존 postmortem "4. Detection" 시점보다 이른 🟡/🟠 감지
- [ ] 시각 UTC + 본인 리전 정확 표시
- [ ] 후보에 SEV2 자동 제안, 승격 시 ntfy page → ack → MTTA 기록
- [ ] 같은 시간대의 CHG-2026-10-12-02가 "변경 연관 의심"으로 표시
- [ ] 체크포인트의 깨우기 조건(backlog 30분 정체)이 조건 충족 시 page
- [ ] Prometheus 중지 시 5분 내 Watchdog 누락 page

## 9. 위험

| 위험 | 대응 |
|---|---|
| **호스트 메모리 경쟁** (48GB에 L1+L2+모니터링+모델, INC 원인이 prover OOM) | 호스트 메모리 감시, 여유 부족 시 agent 호출 지연, 모델 1개·KEEP_ALIVE 5m |
| 20B 모델 추론 품질 | RAG로 catalog·runbook·precedent 주입, 판단 아닌 요약 역할 |
| catalog 노후화 | CI k8s 비교, agent 보강 PR |
| 묶기 오탐 | 자동 incident 생성 안 함, IC가 승격·분리 |
| 시간대/DST 오류 | UTC 단일 기준, DST ⚠ 배지 |
| 감시 시스템 동반 장애 (단일 Mac) | Watchdog + 외부 heartbeat 2단 |
| 1인 운영 피로 (장기 incident) | 체크포인트 + 깨우기 조건으로 수면 중 위임 |

## 10. 결정 기록

| # | 결정 |
|---|---|
| Q1 | 독립 웹앱 + Grafana 혼합 |
| Q2 | 실시간 상태 Postgres, 영구 기록 git |
| Q3 | AI 1단계 읽기 전용, 2단계 PR 제안 |
| Q4 | Kagent, 결정적 로직은 backend |
| Q5 | catalog YAML + CI k8s 비교 |
| Q6 | repo 3개 (gitops / observability / ai-sre-ops) |
| Q7 | 메트릭 접두어 분류 + mimirtool 정적 분석 |
| Q8 | 대시보드 JSON + lint |
| Q9 | 4단계 + Unknown, 동적 baseline + 고정 임계값 덮어쓰기 |
| Q10 | 의존 기반 후보 묶기, IC 승격, 결정적 점수 |
| Q11 | IMAG 4역할, Scribe 없음 |
| Q12 | 3교대 UTC, 자동 초안 → 편집 → ack |
| Q13 | UTC 기준 |
| Q14 | runbook 6섹션, 완화 우선 |
| Q15 | Next.js + SSE + React Flow + Postgres + oauth2-proxy, in-cluster |
| Q16–17 | Ollama 로컬(`gpt-oss:20b`, Mac host) |
| Q18 | P0–P3, INC 재현을 MVP 완료 기준으로 |
| Q19 | 생애주기 상태 흐름 + SEV1–4 (SLO 기준) |
| Q20 | ntfy(page) + Slack, 1인 호출 단계 |
| Q21 | Watchdog + healthchecks.io heartbeat |
| Q22 | Flux 이벤트 + CHG frontmatter, 변경 연관 표시만 |
| Q23 | IC 체크포인트(깨우기 조건) + 결정 기록 |
| Q24 | 조치 항목 issue, MTTx 지표, 오류 예산 정책 B(CHG 승인 동결) |

## 11. 열린 질문

- 실제 클러스터 메모리 사용량 (kubectl context 미설정으로 미확인) → 모델 크기 최종 확정
- SLO 가중치 구체 수치
- 근무자 명단·실제 교대 시간 (현재 1인)
- 현재 settlement-freshness 예산 초과 상태에서 l2-load CHG를 신뢰성 개선 예외로 볼지
