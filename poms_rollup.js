// poms_rollup.js  (board-agnostic)
// POMS 템플릿 계열 보드 공용:
//  (1) 상위 상태 자동 롤업: 하위 상태 조합 → 규칙 → 상위 「그룹 이동」
//  (2) 지연 전파: 하위 「지연일」에 N 입력 → 그 이후 하위 「계획 일정」 +N일 → 지연일 0
// 보드 ID를 하드코딩하지 않고, 웹훅 이벤트의 하위 아이템에서 보드를 자동 도출.
// → 어느 복사본이든 "웹훅만 등록"하면 동작 (컬럼 ID는 복사본 간 동일 가정).
// Node 18+ (내장 fetch). 의존성: express

import express from 'express';

// ===== 설정 (컬럼/그룹 ID는 복사본 공통) =====
const TOKEN = process.env.MONDAY_TOKEN;
const VERSION = 'v4-chain';
const PARENT_STATUS_COL = 'color_mm1b2wwc';   // 상위 「그룹 이동」
const SUB_STATUS_COL = 'status';              // 하위 「상태」
const SUB_PLAN_COL = 'timerange_mm19wjn0';    // 하위 「계획 일정」
const SUB_DELAY_COL = 'numeric_mm4gccsa';     // 하위 「지연일」
const SUB_CHAIN_COL = 'color_mm4gnck6';       // 하위 「계열」(Mold/Press…) — 같은 계열만 밀기
const PROTECTED_GROUP = 'group_mm29jb8c';     // 고객 일정 — 상태 롤업 제외
const API = 'https://api.monday.com/v2';

// ===== 규칙 =====
function categorize(t) {
  if (!t) return 'wait';
  if (t.includes('이슈')) return 'issue';
  if (t.includes('지연')) return 'delay';
  if (t.includes('완료')) return 'done';
  if (t.includes('진행')) return 'progress';
  return 'wait';
}
function rollup(texts) {
  const c = texts.map(categorize);
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

// 하위 아이템에서 보드 컨텍스트 도출 (board-agnostic 핵심)
async function ctxOf(subId) {
  const d = await gql(`query ($id:[ID!]){ items(ids:$id){ board{id} parent_item{ id board{id} } } }`, { id: [String(subId)] });
  const it = d.items?.[0];
  if (!it) return null;
  return { subBoard: it.board?.id, parentId: it.parent_item?.id, parentBoard: it.parent_item?.board?.id };
}

// ===== (1) 상태 롤업 =====
async function recomputeParent(parentId, parentBoard) {
  if (!parentId || !parentBoard) return;
  const d = await gql(`query ($id:[ID!]){ items(ids:$id){ group{id} column_values(ids:["${PARENT_STATUS_COL}"]){text} subitems{ column_values(ids:["${SUB_STATUS_COL}"]){text} } } }`, { id: [String(parentId)] });
  const item = d.items?.[0];
  if (!item || item.group?.id === PROTECTED_GROUP) return;
  const target = rollup((item.subitems || []).map(s => s.column_values?.[0]?.text || ''));
  if (!target || (item.column_values?.[0]?.text || '') === target) return;
  await gql(`mutation ($b:ID!,$i:ID!,$v:JSON!){ change_column_value(board_id:$b,item_id:$i,column_id:"${PARENT_STATUS_COL}",value:$v){id} }`,
    { b: String(parentBoard), i: String(parentId), v: JSON.stringify({ label: target }) });
  console.log(`[rollup] ${parentId} -> ${target}`);
}

// ===== (2) 지연 전파 =====
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
async function readDelay(subId) {
  const d = await gql(`query ($id:[ID!]){ items(ids:$id){ column_values(ids:["${SUB_DELAY_COL}"]){text} } }`, { id: [String(subId)] });
  return asNumber(d.items?.[0]?.column_values?.[0]?.text || 0);
}
async function clearDelay(subId, subBoard) {
  await gql(`mutation ($b:ID!,$i:ID!){ change_simple_column_value(board_id:$b,item_id:$i,column_id:"${SUB_DELAY_COL}",value:""){id} }`,
    { b: String(subBoard), i: String(subId) });
}
// 지연일 입력 하위의 계획 종료일 이후(≥) 시작하면서 「계열」이 같은 하위들만 +days
// (계열 미지정=빈값끼리 한 묶음. 단일 체인 상위는 태깅 없이 그대로 동작)
async function cascadeDelay(subId, days, subBoard) {
  if (days <= 0 || !subBoard) return;
  const me = await gql(`query ($id:[ID!]){ items(ids:$id){ column_values(ids:["${SUB_PLAN_COL}","${SUB_CHAIN_COL}"]){id text} } }`, { id: [String(subId)] });
  const mv = me.items?.[0]?.column_values || [];
  const myEnd = (mv.find(c => c.id === SUB_PLAN_COL)?.text || '').split(' - ')[1];
  const myChain = mv.find(c => c.id === SUB_CHAIN_COL)?.text || '';
  if (!myEnd) return;
  const data = await gql(`query ($b:ID!){ boards(ids:[$b]){ items_page(limit:200){ items{ id column_values(ids:["${SUB_PLAN_COL}","${SUB_CHAIN_COL}"]){id text} } } } }`, { b: String(subBoard) });
  let moved = 0;
  for (const it of data.boards[0].items_page.items) {
    if (String(it.id) === String(subId)) continue;
    const cv = it.column_values || [];
    const chain = cv.find(c => c.id === SUB_CHAIN_COL)?.text || '';
    if (chain !== myChain) continue;            // 같은 계열만 밀기
    const [s, e] = (cv.find(c => c.id === SUB_PLAN_COL)?.text || '').split(' - ');
    if (!s || !e) continue;
    if (s >= myEnd) {
      await gql(`mutation ($b:ID!,$i:ID!,$v:JSON!){ change_column_value(board_id:$b,item_id:$i,column_id:"${SUB_PLAN_COL}",value:$v){id} }`,
        { b: String(subBoard), i: String(it.id), v: JSON.stringify({ from: addDays(s, days), to: addDays(e, days) }) });
      moved++;
    }
  }
  console.log(`[cascade] sub ${subId} +${days}d chain="${myChain}" -> ${moved} shifted`);
}

// ===== 웹훅 등록 (CLI) =====
async function registerWebhook(board, url) {
  if (!board || !url) throw new Error('usage: node poms_rollup.js register-webhook <parentBoardId> <https://.../webhook>');
  const data = await gql(`mutation ($board: ID!, $url: String!){ create_webhook(board_id:$board, url:$url, event: change_subitem_column_value){ id board_id } }`,
    { board: String(board), url });
  console.log('webhook created:', JSON.stringify(data.create_webhook));
}

// ===== 서버 =====
function server() {
  const app = express();
  app.use(express.json());
  app.post('/webhook', async (req, res) => {
    if (req.body?.challenge) return res.status(200).json({ challenge: req.body.challenge });
    res.status(200).send('');
    try {
      const subId = req.body?.event?.pulseId;
      if (!subId) return;
      const ctx = await ctxOf(subId);
      if (!ctx) return;
      const delay = await readDelay(subId);
      if (delay > 0) {
        await clearDelay(subId, ctx.subBoard);
        await cascadeDelay(subId, delay, ctx.subBoard);
      } else {
        await recomputeParent(ctx.parentId, ctx.parentBoard);
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
if (mode === 'register-webhook') registerWebhook(process.argv[3], process.argv[4]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
else server();
