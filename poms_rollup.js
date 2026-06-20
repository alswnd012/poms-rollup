// poms_rollup.js
// POMS (공통 템플릿) - 최신Ver.
//  (1) 상위 상태 자동 롤업: 하위 상태 조합 → 규칙 → 상위 「그룹 이동」
//  (2) 지연 전파(cascade): 하위 「지연일」에 N 입력 → 그 이후 하위 「계획 일정」 +N일 → 지연일 0으로 비움(명령형, 누적 가능)
// Node 18+ (내장 fetch). 의존성: express

import express from 'express';

// ===== 설정 =====
const TOKEN = process.env.MONDAY_TOKEN;
const VERSION = 'v2-cascade-5029373827';      // 배포 확인용
const PARENT_BOARD = 5029373827;              // POMS - 복합구조 자동화 완료
const SUB_BOARD = 5029373834;                 // 그 하위 보드
const PARENT_STATUS_COL = 'color_mm1b2wwc';   // 상위 「그룹 이동」
const SUB_STATUS_COL = 'status';              // 하위 「상태」
const SUB_PLAN_COL = 'timerange_mm19wjn0';    // 하위 「계획 일정」
const SUB_DELAY_COL = 'numeric_mm4gccsa';     // 하위 「지연일」(명령 입력 칸)
const PROTECTED_GROUP = 'group_mm29jb8c';     // 고객 일정 — 상태 롤업 제외
const API = 'https://api.monday.com/v2';

// ===== 규칙 (상태 롤업) =====
function categorize(text) {
  if (!text) return 'wait';
  if (text.includes('이슈')) return 'issue';
  if (text.includes('지연')) return 'delay';
  if (text.includes('완료')) return 'done';
  if (text.includes('진행')) return 'progress';
  return 'wait';
}
function rollup(subStatusTexts) {
  const c = subStatusTexts.map(categorize);
  if (c.length === 0) return null;
  if (c.includes('issue')) return '이슈';
  if (c.includes('delay')) return '지연';
  if (c.every(x => x === 'done')) return '완료';
  if (c.some(x => x !== 'wait')) return '진행 중';
  return '진행예정';
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

// ===== (1) 상태 롤업 =====
async function setParentStatus(itemId, label) {
  await gql(`mutation ($b: ID!, $i: ID!, $v: JSON!) { change_column_value(board_id: $b, item_id: $i, column_id: "${PARENT_STATUS_COL}", value: $v) { id } }`,
    { b: String(PARENT_BOARD), i: String(itemId), v: JSON.stringify({ label }) });
}
async function recomputeParent(parentItemId) {
  const data = await gql(`query ($id: [ID!]) { items(ids: $id) { id group { id } column_values(ids: ["${PARENT_STATUS_COL}"]) { text } subitems { column_values(ids: ["${SUB_STATUS_COL}"]) { text } } } }`,
    { id: [String(parentItemId)] });
  const item = data.items?.[0];
  if (!item || item.group?.id === PROTECTED_GROUP) return;
  const target = rollup((item.subitems || []).map(s => s.column_values?.[0]?.text || ''));
  if (!target || (item.column_values?.[0]?.text || '') === target) return;
  await setParentStatus(parentItemId, target);
  console.log(`[rollup] ${parentItemId} -> ${target}`);
}
async function parentOfSubitem(subId) {
  const data = await gql(`query ($id:[ID!]){ items(ids:$id){ parent_item { id } } }`, { id: [String(subId)] });
  return data.items?.[0]?.parent_item?.id || null;
}

// ===== (2) 지연 전파(cascade) — 명령형 =====
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function asNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'object') v = v.value ?? v.number ?? '';
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
// 규칙: 지연일 입력 하위의 「계획 일정」 종료일 이후(≥)에 시작하는 모든 하위의 계획 일정을 +N일.
async function cascadeDelay(subId, days) {
  if (days <= 0) return;
  const me = await gql(`query ($id:[ID!]){ items(ids:$id){ column_values(ids:["${SUB_PLAN_COL}"]){ text } } }`, { id: [String(subId)] });
  const myEnd = (me.items?.[0]?.column_values?.[0]?.text || '').split(' - ')[1];
  if (!myEnd) return; // 기준 태스크에 계획 일정 없으면 전파 불가
  const data = await gql(`query { boards(ids: ${SUB_BOARD}) { items_page(limit: 200) { items { id column_values(ids: ["${SUB_PLAN_COL}"]) { text } } } } }`);
  let moved = 0;
  for (const it of data.boards[0].items_page.items) {
    if (String(it.id) === String(subId)) continue;
    const [s, e] = (it.column_values?.[0]?.text || '').split(' - ');
    if (!s || !e) continue;
    if (s >= myEnd) { // YYYY-MM-DD 사전식 = 날짜 비교
      await gql(`mutation ($b:ID!,$i:ID!,$v:JSON!){ change_column_value(board_id:$b,item_id:$i,column_id:"${SUB_PLAN_COL}",value:$v){id} }`,
        { b: String(SUB_BOARD), i: String(it.id), v: JSON.stringify({ from: addDays(s, days), to: addDays(e, days) }) });
      moved++;
    }
  }
  console.log(`[cascade] sub ${subId} +${days}d -> ${moved} task(s) shifted`);
}
// 지연일을 0으로 비움(명령 소비)
async function clearDelay(subId) {
  await gql(`mutation ($b:ID!,$i:ID!){ change_simple_column_value(board_id:$b,item_id:$i,column_id:"${SUB_DELAY_COL}",value:""){id} }`,
    { b: String(SUB_BOARD), i: String(subId) });
}
// 하위의 현재 「지연일」 값 읽기 (웹훅 payload 형식에 의존하지 않으려고 직접 조회)
async function readDelay(subId) {
  const d = await gql(`query ($id:[ID!]){ items(ids:$id){ column_values(ids:["${SUB_DELAY_COL}"]){ text } } }`, { id: [String(subId)] });
  return asNumber(d.items?.[0]?.column_values?.[0]?.text || 0);
}

// ===== 백필(상위 상태 1회 동기화) =====
async function backfill() {
  let cursor = null, changed = 0;
  do {
    const data = await gql(`query ($cursor: String) { boards(ids: ${PARENT_BOARD}) { items_page(limit: 100, cursor: $cursor) { cursor items { id group { id } column_values(ids: ["${PARENT_STATUS_COL}"]) { text } subitems { column_values(ids: ["${SUB_STATUS_COL}"]) { text } } } } } }`, { cursor });
    const page = data.boards[0].items_page;
    for (const it of page.items) {
      if (it.group?.id === PROTECTED_GROUP) continue;
      const target = rollup((it.subitems || []).map(s => s.column_values?.[0]?.text || ''));
      if (!target || (it.column_values?.[0]?.text || '') === target) continue;
      await setParentStatus(it.id, target);
      changed++;
    }
    cursor = page.cursor;
  } while (cursor);
  console.log(`[backfill] done. ${changed} changed.`);
}

// ===== 웹훅 등록 =====
async function registerWebhook(url) {
  if (!url) throw new Error('usage: node poms_rollup.js register-webhook <https://.../webhook>');
  const data = await gql(`mutation ($board: ID!, $url: String!) { create_webhook(board_id: $board, url: $url, event: change_subitem_column_value) { id board_id } }`,
    { board: String(PARENT_BOARD), url });
  console.log('webhook created:', JSON.stringify(data.create_webhook));
}

// ===== 웹훅 서버 =====
function server() {
  const app = express();
  app.use(express.json());
  app.post('/webhook', async (req, res) => {
    if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });
    res.status(200).send('');
    try {
      const ev = req.body?.event;
      const subId = ev?.pulseId;
      if (!subId) return;
      // payload 필드명에 의존하지 않고, 바뀐 하위의 현재 「지연일」을 직접 읽어 판단
      const delay = await readDelay(subId);
      if (delay > 0) {
        // (2) 지연일 입력(>0) → 0으로 먼저 비우고(중복 발동 방지) → 이후 계획 일정 +N
        await clearDelay(subId);
        await cascadeDelay(subId, delay);
      } else {
        // (1) 지연일 없음 → 상위 상태 롤업 재계산
        const parentId = await parentOfSubitem(subId);
        if (parentId) await recomputeParent(parentId);
      }
    } catch (e) { console.error('[webhook]', e.message); }
  });
  app.get('/', (_, res) => res.send('POMS rollup running'));
  app.get('/version', (_, res) => res.send(VERSION));
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log('listening on ' + port));
}

// ===== 진입점 =====
if (!TOKEN) { console.error('환경변수 MONDAY_TOKEN 이 필요합니다.'); process.exit(1); }
const mode = process.argv[2];
if (mode === 'backfill') backfill().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
else if (mode === 'register-webhook') registerWebhook(process.argv[3]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
else server();
