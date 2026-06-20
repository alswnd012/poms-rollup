// poms_rollup.js
// POMS (공통 템플릿) - 최신Ver. 상위 상태 자동 롤업
// 하위 태스크 상태 조합 → 규칙(이슈>지연>완료(전부)>진행>진행예정) → 상위 「그룹 이동」 자동 결정
// Node 18+ (내장 fetch 사용). 의존성: express
//
// 사용:
//   node poms_rollup.js                         → 웹훅 서버 실행(상시 자동)
//   node poms_rollup.js backfill                → 현재 전체를 규칙대로 1회 동기화
//   node poms_rollup.js register-webhook <URL>  → 하위 보드에 웹훅 등록

import express from 'express';

// ===== 설정 (이 보드 전용) =====
const TOKEN = process.env.MONDAY_TOKEN;            // 황기남 계정 API 토큰
const PARENT_BOARD = 5029342095;                  // 상위 보드
const SUB_BOARD = 5029342096;                     // 하위(서브아이템) 보드
const PARENT_STATUS_COL = 'color_mm1b2wwc';       // 상위 「그룹 이동」
const SUB_STATUS_COL = 'status';                  // 하위 「상태」
const PROTECTED_GROUP = 'group_mm29jb8c';         // 고객 일정 — 절대 변경 금지
const API = 'https://api.monday.com/v2';

// ===== 규칙 함수 =====
function categorize(text) {
  if (!text) return 'wait';
  if (text.includes('이슈')) return 'issue';
  if (text.includes('지연')) return 'delay';
  if (text.includes('완료')) return 'done';
  if (text.includes('진행')) return 'progress';
  return 'wait'; // 1. 대기 또는 빈값
}
function rollup(subStatusTexts) {
  const cats = subStatusTexts.map(categorize);
  if (cats.length === 0) return null;                 // 하위 없음 → 변경 안 함
  if (cats.includes('issue')) return '이슈';           // 1순위
  if (cats.includes('delay')) return '지연';           // 2순위
  if (cats.every(c => c === 'done')) return '완료';     // 3순위(전부 완료)
  if (cats.some(c => c !== 'wait')) return '진행 중';   // 4순위(하나라도 진행/완료)
  return '진행예정';                                    // 5순위(전부 대기)
}

// ===== Monday API =====
async function gql(query, variables = {}) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: TOKEN, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
}

async function setParentStatus(itemId, label) {
  await gql(
    `mutation ($b: ID!, $i: ID!, $v: JSON!) {
       change_column_value(board_id: $b, item_id: $i, column_id: "${PARENT_STATUS_COL}", value: $v) { id }
     }`,
    { b: String(PARENT_BOARD), i: String(itemId), v: JSON.stringify({ label }) }
  );
}

async function recomputeParent(parentItemId) {
  const data = await gql(
    `query ($id: [ID!]) {
       items(ids: $id) {
         id
         group { id }
         column_values(ids: ["${PARENT_STATUS_COL}"]) { text }
         subitems { column_values(ids: ["${SUB_STATUS_COL}"]) { text } }
       }
     }`,
    { id: [String(parentItemId)] }
  );
  const item = data.items?.[0];
  if (!item) return;
  if (item.group?.id === PROTECTED_GROUP) return;             // 고객 일정 보호
  const subTexts = (item.subitems || []).map(s => s.column_values?.[0]?.text || '');
  const target = rollup(subTexts);
  if (!target) return;
  const current = item.column_values?.[0]?.text || '';
  if (current === target) return;                             // 이미 일치
  await setParentStatus(parentItemId, target);
  console.log(`[rollup] ${parentItemId}: ${current} -> ${target}`);
}

async function parentOfSubitem(subId) {
  const data = await gql(`query ($id:[ID!]){ items(ids:$id){ parent_item { id } } }`, { id: [String(subId)] });
  return data.items?.[0]?.parent_item?.id || null;
}

// ===== 백필(전체 1회 동기화) =====
async function backfill() {
  let cursor = null, changed = 0;
  do {
    const data = await gql(
      `query ($cursor: String) {
         boards(ids: ${PARENT_BOARD}) {
           items_page(limit: 100, cursor: $cursor) {
             cursor
             items {
               id
               group { id }
               column_values(ids: ["${PARENT_STATUS_COL}"]) { text }
               subitems { column_values(ids: ["${SUB_STATUS_COL}"]) { text } }
             }
           }
         }
       }`,
      { cursor }
    );
    const page = data.boards[0].items_page;
    for (const it of page.items) {
      if (it.group?.id === PROTECTED_GROUP) continue;
      const subTexts = (it.subitems || []).map(s => s.column_values?.[0]?.text || '');
      const target = rollup(subTexts);
      if (!target) continue;
      const current = it.column_values?.[0]?.text || '';
      if (current === target) continue;
      await setParentStatus(it.id, target);
      changed++;
      console.log(`[backfill] ${it.id}: ${current} -> ${target}`);
    }
    cursor = page.cursor;
  } while (cursor);
  console.log(`[backfill] done. ${changed} item(s) changed.`);
}

// ===== 웹훅 등록 =====
async function registerWebhook(url) {
  if (!url) throw new Error('usage: node poms_rollup.js register-webhook <https://.../webhook>');
  const data = await gql(
    `mutation ($board: ID!, $url: String!, $config: JSON!) {
       create_webhook(board_id: $board, url: $url, event: change_column_value, config: $config) { id board_id }
     }`,
    { board: String(SUB_BOARD), url, config: JSON.stringify({ columnId: SUB_STATUS_COL }) }
  );
  console.log('webhook created:', JSON.stringify(data.create_webhook));
}

// ===== 웹훅 서버 =====
function server() {
  const app = express();
  app.use(express.json());
  app.post('/webhook', async (req, res) => {
    if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge }); // 등록 핸드셰이크
    res.status(200).send(''); // Monday는 빠른 200 응답을 기대 → 먼저 응답
    try {
      const subId = req.body?.event?.pulseId; // 변경된 하위 아이템 id
      if (!subId) return;
      const parentId = await parentOfSubitem(subId);
      if (parentId) await recomputeParent(parentId);
    } catch (e) { console.error('[webhook]', e.message); }
  });
  app.get('/', (_, res) => res.send('POMS rollup running'));
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log('listening on ' + port));
}

// ===== 진입점 =====
if (!TOKEN) { console.error('환경변수 MONDAY_TOKEN 이 필요합니다.'); process.exit(1); }
const mode = process.argv[2];
if (mode === 'backfill') backfill().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
else if (mode === 'register-webhook') registerWebhook(process.argv[3]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
else server();
