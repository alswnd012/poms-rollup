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
const VERSION = 'v6-poll';
const WORKSPACE_ID = 3026437;                 // 영업기획팀 — 이 워크스페이스의 POMS 보드 전체를 폴링
const SUBTASKS_COL = 'subtasks_mm19mc0g';     // 상위 「하위 아이템」 컬럼 → 하위 보드 ID 추출
const PARENT_STATUS_COL = 'color_mm1b2wwc';   // 상위 「그룹 이동」 (이 컬럼 보유 = POMS 보드로 식별)
const SUB_STATUS_COL = 'status';              // 하위 「상태」
const SUB_PLAN_COL = 'timerange_mm19wjn0';    // 하위 「계획 일정」
const SUB_DELAY_COL = 'numeric_mm4gccsa';     // 하위 「지연일」
const SUB_DEP_COL = 'dependency_mm4h7x2';     // 하위 「선행 작업(종속성)」 — 전파 그래프의 선행 링크
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
function dayDiff(a, b) {                       // b - a (일수, YYYY-MM-DD)
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
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
// 「선행 작업(종속성)」 그래프를 읽어, 트리거를 +days 밀고 후행들을 수렴 규칙으로 전파.
// 각 후행 S의 이동량 = max(0, max(선행 새 종료) - max(선행 옛 종료)).
//  → 간격·기간 보존, "늦게 끝나는 선행" 기준(병렬 케이스가 합쳐지는 조립 T0 등 수렴 정확).
async function cascadeByDependency(triggerId, days, subBoard) {
  if (days <= 0 || !subBoard) return;
  const data = await gql(`query ($b:ID!){ boards(ids:[$b]){ items_page(limit:300){ items{ id column_values(ids:["${SUB_PLAN_COL}","${SUB_DEP_COL}"]){ id text ... on DependencyValue { linked_item_ids } } } } } }`, { b: String(subBoard) });
  const items = data.boards?.[0]?.items_page?.items || [];
  const oldStart = {}, oldEnd = {}, preds = {};
  for (const it of items) {
    const id = String(it.id);
    const tv = it.column_values.find(c => c.id === SUB_PLAN_COL);
    const dv = it.column_values.find(c => c.id === SUB_DEP_COL);
    const [s, e] = (tv?.text || '').split(' - ');
    if (s && e) { oldStart[id] = s; oldEnd[id] = e; }
    preds[id] = (dv?.linked_item_ids || []).map(String);
  }
  const T = String(triggerId);
  const shift = { [T]: days };                  // 트리거는 +days 고정
  const curEnd = id => (oldEnd[id] ? addDays(oldEnd[id], shift[id] || 0) : null);
  // 반복 완화(임의 DAG에서 수렴까지)
  for (let pass = 0, changed = true; changed && pass < 100; pass++) {
    changed = false;
    for (const id in oldStart) {
      if (id === T) continue;
      const ps = (preds[id] || []).filter(p => oldEnd[p]);
      if (!ps.length) continue;
      let oldB = null, newB = null;
      for (const p of ps) {
        if (oldB === null || oldEnd[p] > oldB) oldB = oldEnd[p];   // 옛 선행 max 종료
        const ce = curEnd(p);
        if (newB === null || ce > newB) newB = ce;                 // 새 선행 max 종료
      }
      const sh = Math.max(0, dayDiff(oldB, newB));
      if ((shift[id] || 0) !== sh) { shift[id] = sh; changed = true; }
    }
  }
  let moved = 0;
  for (const id in shift) {
    const sh = shift[id];
    if (!sh || !oldStart[id]) continue;
    await gql(`mutation ($b:ID!,$i:ID!,$v:JSON!){ change_column_value(board_id:$b,item_id:$i,column_id:"${SUB_PLAN_COL}",value:$v){id} }`,
      { b: String(subBoard), i: id, v: JSON.stringify({ from: addDays(oldStart[id], sh), to: addDays(oldEnd[id], sh) }) });
    moved++;
  }
  console.log(`[cascade-dep] trigger ${T} +${days}d -> ${moved} shifted`);
}

// ===== 폴링(스캔) — 워크스페이스의 POMS 보드 전체 처리 =====
// 워크스페이스 내 「그룹 이동(color_mm1b2wwc)」 컬럼을 가진 보드 = POMS 프로젝트로 식별
async function findPomsBoards(workspaceId) {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const d = await gql(`query ($ws:[ID!],$p:Int!){ boards(workspace_ids:$ws, state:active, limit:100, page:$p){ id columns{ id } } }`, { ws: [String(workspaceId)], p: page });
    const boards = d.boards || [];
    if (!boards.length) break;
    for (const b of boards) if (b.columns?.some(c => c.id === PARENT_STATUS_COL)) out.push(String(b.id));
    if (boards.length < 100) break;
  }
  return out;
}
// 상위 보드 → 하위(subitem) 보드 ID
async function subBoardOf(parentBoardId) {
  const d = await gql(`query ($id:[ID!]){ boards(ids:$id){ columns(ids:["${SUBTASKS_COL}"]){ settings_str } } }`, { id: [String(parentBoardId)] });
  const s = d.boards?.[0]?.columns?.[0]?.settings_str;
  if (!s) return null;
  try { return String(JSON.parse(s).boardIds?.[0] || '') || null; } catch { return null; }
}
// 새 템플릿 식별: 하위 보드에 「선행 작업(종속성)」 컬럼이 있어야 진짜 POMS 프로젝트(레거시/테스트 제외)
async function subBoardHasDep(subBoard) {
  const d = await gql(`query ($id:[ID!]){ boards(ids:$id){ columns(ids:["${SUB_DEP_COL}"]){ id } } }`, { id: [String(subBoard)] });
  return (d.boards?.[0]?.columns?.length || 0) > 0;
}
// 하위 보드에서 지연일>0 인 것 처리(클리어 + 종속성 전파)
async function processDelays(subBoard) {
  const d = await gql(`query ($b:ID!){ boards(ids:[$b]){ items_page(limit:300){ items{ id column_values(ids:["${SUB_DELAY_COL}"]){text} } } } }`, { b: String(subBoard) });
  const items = d.boards?.[0]?.items_page?.items || [];
  let n = 0;
  for (const it of items) {
    const delay = asNumber(it.column_values?.[0]?.text || 0);
    if (delay > 0) {
      await clearDelay(it.id, subBoard);
      await cascadeByDependency(it.id, delay, subBoard);
      n++;
    }
  }
  return n;
}
// 상위 보드 전체 롤업 재계산(고객일정 그룹 제외)
async function rollupBoard(parentBoardId) {
  const d = await gql(`query ($id:[ID!]){ boards(ids:$id){ items_page(limit:200){ items{ id group{id} column_values(ids:["${PARENT_STATUS_COL}"]){text} subitems{ column_values(ids:["${SUB_STATUS_COL}"]){text} } } } } }`, { id: [String(parentBoardId)] });
  const items = d.boards?.[0]?.items_page?.items || [];
  let n = 0;
  for (const it of items) {
    if (it.group?.id === PROTECTED_GROUP || !it.subitems?.length) continue;
    const target = rollup(it.subitems.map(s => s.column_values?.[0]?.text || ''));
    const cur = it.column_values?.[0]?.text || '';
    if (target && cur !== target) {
      await gql(`mutation ($b:ID!,$i:ID!,$v:JSON!){ change_column_value(board_id:$b,item_id:$i,column_id:"${PARENT_STATUS_COL}",value:$v){id} }`,
        { b: String(parentBoardId), i: String(it.id), v: JSON.stringify({ label: target }) });
      n++;
    }
  }
  return n;
}
async function processBoard(parentBoardId) {
  const subBoard = await subBoardOf(parentBoardId);
  if (!subBoard) return { board: parentBoardId, skipped: 'no-subboard' };
  if (!(await subBoardHasDep(subBoard))) return { board: parentBoardId, skipped: 'not-poms-template' };
  const delays = await processDelays(subBoard);
  const rolled = await rollupBoard(parentBoardId);
  return { board: parentBoardId, subBoard, delays, rolled };
}
async function scanWorkspace(workspaceId) {
  const boards = await findPomsBoards(workspaceId);
  const results = [];
  for (const b of boards) {
    try { results.push(await processBoard(b)); }
    catch (e) { results.push({ board: b, error: e.message }); }
  }
  const delays = results.reduce((s, r) => s + (r.delays || 0), 0);
  const rolled = results.reduce((s, r) => s + (r.rolled || 0), 0);
  console.log(`[scan] boards=${boards.length} delays=${delays} rolled=${rolled}`);
  return { boards: boards.length, delays, rolled, results };
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
        await cascadeByDependency(subId, delay, ctx.subBoard);
      } else {
        await recomputeParent(ctx.parentId, ctx.parentBoard);
      }
    } catch (e) { console.error('[webhook]', e.message); }
  });
  app.get('/', (_, res) => res.send('POMS rollup running'));
  app.get('/version', (_, res) => res.send(VERSION));
  // 폴링: 스케줄러(외부 cron)가 주기적으로 호출 → 워크스페이스 POMS 보드 전체 스캔·처리
  app.get('/scan', async (_, res) => {
    try { const r = await scanWorkspace(WORKSPACE_ID); res.json({ ok: true, version: VERSION, ...r }); }
    catch (e) { console.error('[scan]', e.message); res.status(500).json({ ok: false, error: e.message }); }
  });
  const port = process.env.PORT || 8080;
  app.listen(port, () => console.log('listening on ' + port));
}

// ===== 진입점 =====
if (!TOKEN) { console.error('환경변수 MONDAY_TOKEN 이 필요합니다.'); process.exit(1); }
const mode = process.argv[2];
if (mode === 'register-webhook') registerWebhook(process.argv[3], process.argv[4]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
else if (mode === 'scan') scanWorkspace(WORKSPACE_ID).then(r => { console.log(JSON.stringify(r, null, 2)); process.exit(0); }).catch(e => { console.error(e); process.exit(1); });
else server();
