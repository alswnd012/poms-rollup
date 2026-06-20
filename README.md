# POMS 상위 상태 자동 롤업 — 배포 가이드

하위 태스크 상태가 바뀌면, 규칙으로 상위 「그룹 이동」을 자동 계산해 갱신합니다.
**규칙:** 이슈(하나라도) > 지연(하나라도) > 완료(전부) > 진행 중(하나라도 진행/완료) > 진행예정(전부 대기).
**보호:** 「고객 일정」 그룹(`group_mm29jb8c`)은 절대 변경하지 않음.

| 설정값 | 값 |
|---|---|
| 상위 보드 | 5029342095 |
| 하위 보드 | 5029342096 |
| 상위 상태 컬럼 | color_mm1b2wwc (그룹 이동) |
| 하위 상태 컬럼 | status |
| 보호 그룹 | group_mm29jb8c (고객 일정) |

---

## 0. 사전 준비 (PC)
- Node.js 18+ 설치
- 이 폴더에서: `npm install`

## 1. 토큰 발급 — 황기남 계정 (Monday 웹)
1. 황기남 계정으로 monday.com 로그인
2. 우상단 **프로필 아바타 → 개발자(Developers)** 클릭 → 개발자 센터
3. 좌측 **My Access Tokens(내 액세스 토큰)** → 토큰 복사
   - (또는 **관리자 → API** 메뉴에서 토큰 확인)
4. PC 환경변수로 설정
   - Windows PowerShell: `setx MONDAY_TOKEN "복사한_토큰"` (새 터미널부터 적용)
   - 임시: `$env:MONDAY_TOKEN="복사한_토큰"`

> ⚠️ 반드시 **황기남 계정 토큰**으로 돌리세요. 그래야 만들어지는 자동 변경/웹훅이 관리자 소유로 귀속되어 추후 관리가 됩니다.

## 2. 백필(전체 1회 동기화) — 먼저 현재 상태부터 규칙대로 정렬
```
node poms_rollup.js backfill
```
- 콘솔에 변경된 항목이 출력됩니다. 고객 일정 4개는 건너뜁니다.

## 3. 호스팅 (상시 자동화의 핵심 — 공개 URL이 필요)
웹훅을 받으려면 코드가 인터넷에서 항상 돌아야 합니다. 둘 중 택1.

### 옵션 A) Render (가장 쉬움, 권장)
1. 이 폴더를 GitHub 저장소에 푸시
2. render.com 가입 → **New → Web Service** → 그 저장소 연결
3. Build Command: `npm install` / Start Command: `npm start`
4. **Environment → MONDAY_TOKEN** 환경변수 추가(1단계 토큰)
5. 배포되면 공개 URL 발급 (예: `https://poms-rollup.onrender.com`)

### 옵션 B) monday-code (Monday 내부 호스팅, 통합형)
1. 황기남 계정 → 개발자 센터 → **Create app** → 앱 생성
2. PC: `npm i -g @mondaycom/apps-cli` → `mapps init` → `mapps code:push`
3. 배포 후 발급되는 앱 URL 사용
> 앱 생성·CLI 인증이 필요해 A보다 단계가 많습니다. 빠르게 쓰려면 A 추천.

## 4. 웹훅 등록 (하위 보드 → 내 서버)
호스팅 URL 뒤에 `/webhook` 을 붙여 등록합니다.
```
node poms_rollup.js register-webhook https://poms-rollup.onrender.com/webhook
```
- 성공하면 `webhook created: {...}` 출력.
- (대안) 하위 보드 UI에서 **통합(Integrations) → Webhooks → "When a column changes, send a webhook"** 로 같은 URL을 등록해도 됩니다. (컬럼 = 상태)

## 5. 기존 충돌 자동화 끄기 (황기남 UI)
코드가 상위 상태의 단일 기준이 되려면, 같은 일을 하던 전환쌍 자동화를 꺼야 충돌이 없습니다.
- 상위 보드 → ⚡ 자동화(Automate) → 관리하기 → 아래 자동화 **토글 OFF**
- 끌 것: `1940007372`, `1940007373`, `1940007375`, `1940007376`, `1940007377`, `1940007378`, `1940007379`
- 정리 권장: `1940009968`
- 유지(충돌 없음): `1940007374`(지연 표시), `1940007380`(완료 그룹이동), `1940007385`(진행중 그룹이동)

## 6. 동작 확인
- 하위 태스크 상태를 바꿔보고 몇 초 뒤 상위 「그룹 이동」이 규칙대로 바뀌는지 확인.
- 서버 로그(Render Logs)에 `[rollup] ... -> ...` 가 찍히면 정상.
- 고객 일정 그룹 항목은 하위를 바꿔도 상위가 안 바뀌어야 정상.

---

## 규칙 변경이 필요하면
`poms_rollup.js` 의 `rollup()` 함수만 고치면 됩니다. (라벨 추가/우선순위 변경 등)
