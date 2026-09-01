// 昱恩追蹤工具 — 資料 API（Neon Postgres）
// 取代原本的 Google Apps Script：載入從數十秒降到 1 秒內。
//
// GET  /api/track?action=all          一次取回所有資料（前端開啟時用）
// GET  /api/track?action=getTasks     單獨取某一類
// POST /api/track                     新增／更新／刪除，body: { action, ... }
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

const s  = v => (v === null || v === undefined) ? null : String(v).trim() || null;
const d  = v => { const x = s(v); return x ? x.slice(0, 10) : null; };   // YYYY-MM-DD
const bo = v => (v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1');
const id = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

/* ── 身分驗證 ─────────────────────────────────────────
   這支 API 一直是完全公開的：知道網址就能讀寫、甚至刪光所有任務與成員。
   主系統的 middleware.js 保護不到這裡（不同 repo、不同網域），所以自己擋。

   密鑰只存在 Vercel 環境變數 TRACK_SECRET，不進 GitHub、不寫在前端。
   前端 index.html 把它放在 x-track-key header 送過來。

   ⚠️ 沒設定 TRACK_SECRET 時直接放行。這是刻意的：
      萬一環境變數掉了或新環境忘了設，結果是「回到以前沒鎖的狀態」，
      而不是「全公司突然打不開追蹤工具、也沒人知道為什麼」。
      設定與否請以 Vercel 後台為準。 */
function checkAuth(req) {
  const want = (process.env.TRACK_SECRET || '').trim();
  if (!want) return true;                       // 沒設密鑰＝不啟用驗證
  const got = String(req.headers['x-track-key'] || '').trim();
  return got === want;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

// ── LINE 推播 ──────────────────────────────────────────
// 註：前端一直有送 notify:true（新增任務視窗那個開關），但後端從來沒有處理，
//     所以負責人和協助者都收不到通知。此處補上。
// 需要環境變數 LINE_TOKEN（LINE Official Account 的 Channel access token）
const SEP = /[、,，\/｜|]+/;
const people2arr = v => String(v || '').split(SEP).map(x => x.trim()).filter(Boolean);

async function pushLine(uid, text) {
  const token = (process.env.LINE_TOKEN || '').trim();
  if (!token || !uid) return false;
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ to: uid, messages: [{ type: 'text', text }] }),
    });
    return r.ok;
  } catch { return false; }
}

// 通知任務的負責人與協助者。回傳結果讓前端可以顯示「誰收到了、誰沒有」
async function notifyTask(task, kind) {
  if (!(process.env.LINE_TOKEN || '').trim()) {
    return { ok: false, reason: '未設定 LINE_TOKEN 環境變數' };
  }
  const owner = s(task.member);
  const helpers = people2arr(task.executor);
  const names = [...new Set([owner, ...helpers].filter(Boolean))];
  if (!names.length) return { ok: true, sent: [], skipped: [], note: '這筆任務沒有指定負責人或協助者' };

  const rows = await sql`select name, user_id, notify from tk_member where name = any(${names})`;
  const byName = {};
  rows.forEach(r => { byName[r.name] = r; });

  const sent = [], skipped = [];
  for (const n of names) {
    const m = byName[n];
    if (!m)               { skipped.push({ name: n, why: '成員名冊裡沒有這個人' }); continue; }
    if (!m.user_id)       { skipped.push({ name: n, why: '還沒綁定 LINE' });        continue; }
    if (m.notify === false) { skipped.push({ name: n, why: '本人關閉了通知' });      continue; }
    const role = (n === owner) ? '負責人' : '協助者';
    const text = `📋 ${kind === 'new' ? '新任務' : '任務有異動'}\n\n`
      + `${task.title}\n`
      + `你的角色：${role}\n`
      + (task.category ? `專案：${task.category}\n` : '')
      + (task.priority ? `優先度：${task.priority}\n` : '')
      + (task.due ? `截止：${task.due}\n` : '')
      + (owner && n !== owner ? `負責人：${owner}\n` : '')
      + (helpers.length ? `協助者：${helpers.join('、')}\n` : '')
      + (task.note ? `\n備註：${task.note}` : '');
    if (await pushLine(m.user_id, text)) sent.push(n);
    else skipped.push({ name: n, why: 'LINE 推播失敗（可能是額度或 token 問題）' });
  }
  return { ok: true, sent, skipped };
}

/* ── 主任務／子任務的合法性檢查 ────────────────────────────
   第一版只支援兩層：主任務 → 子任務。不做孫任務。
   資料庫層已經擋掉「自己是自己的父親」（tk_task_no_self_parent），
   但兩層限制與循環沒辦法用 check 表達，只能在這裡驗。

   回傳 null 代表合法；回傳字串代表錯誤訊息，呼叫端要拒絕寫入。
   ⚠️ 不合法時一定要回錯誤，不要默默寫入或默默忽略。 */
async function checkParent(parentId, selfId) {
  if (parentId === null || parentId === undefined) return null;   // 解除父子關係，一定合法
  const pid = id(parentId);
  if (!pid) return '上層任務的 id 不正確';
  if (selfId && pid === Number(selfId)) return '不能把任務指定為自己的上層任務';

  const rows = await sql`select id::text, parent_task_id::text as pp
                         from tk_task where id=${pid} limit 1`;
  if (!rows.length) return '找不到指定的上層任務（id ' + pid + '）';
  if (rows[0].pp) return '「' + pid + '」本身已經是別人的子任務，不能再當上層任務（只支援兩層）';

  // 自己底下已經有子任務的話，自己就不能再變成別人的子任務，否則會變三層
  if (selfId) {
    const kids = await sql`select count(*)::int as n from tk_task
                           where parent_task_id=${Number(selfId)}`;
    if (kids[0].n > 0) return '這筆任務底下已經有子任務，不能再掛到別人底下（只支援兩層）';
  }
  return null;
}

// ── 讀取 ────────────────────────────────────────────────
async function getTasks() {
  // ⚠️ 這裡是列舉欄位，加欄位一定要同時改這行，否則前端永遠拿不到
  // parent_task_id 也轉字串輸出，跟 id 一致——前端全部用字串比對，
  // 混用 number/string 會出現「看起來一樣卻比不到」的鬼問題
  return sql`select id::text, title, category, member, executor, priority, status,
                    to_char(due,'YYYY-MM-DD') as due, note,
                    parent_task_id::text as "parentTaskId"
             from tk_task order by
               case status when '待處理' then 0 when '進行中' then 1 else 2 end,
               due nulls last, id desc`;
}
async function getHistory() {
  return sql`select id::text, task_id::text as "taskId", change,
                    to_char(date,'YYYY-MM-DD HH24:MI') as date
             from tk_history order by date desc, id desc`;
}
async function getMeetings() {
  const rows = await sql`select id::text, title, to_char(date,'YYYY-MM-DD') as date,
                                summary, doc_url as "docUrl"
                         from tk_meeting order by date desc nulls last, id desc`;
  const acts = await sql`select id::text, meeting_id::text as mid, text, member, done
                         from tk_action order by meeting_id, sort, id`;
  const by = {};
  acts.forEach(a => { (by[a.mid] = by[a.mid] || []).push({ id: a.id, text: a.text, member: a.member, done: a.done }); });
  rows.forEach(m => { m.actions = by[m.id] || []; });
  return rows;
}
async function getMembers() {
  return sql`select id::text, name, user_id as "userId", notify
             from tk_member order by name`;
}

export default async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: '尚未設定 DATABASE_URL 環境變數' });
    }

    // 讀寫都要驗。只擋 GET 不擋 POST 等於沒擋——刪除才是最嚴重的
    if (!checkAuth(req)) {
      return res.status(401).json({ error: '通行碼不正確' });
    }

    // ── GET：讀取 ──
    if (req.method === 'GET') {
      const action = String(req.query.action || 'all');

      if (action === 'all') {
        const [tasks, histories, meetings, members] = await Promise.all([
          getTasks(), getHistory(), getMeetings(), getMembers(),
        ]);
        return res.status(200).json({ tasks, histories, meetings, members });
      }
      const map = { getTasks, getHistory, getMeetings, getMembers };
      if (!map[action]) return res.status(400).json({ error: '未知的 action: ' + action });
      return res.status(200).json(await map[action]());
    }

    // ── POST：寫入 ──
    if (req.method === 'POST') {
      const b = parseBody(req);
      const a = String(b.action || '');
      const row = b.row || {};
      // 前端有些表單把欄位放在 row 裡，有些直接平放在最外層；兩種都要吃得下
      const F = (k) => (row && row[k] !== undefined) ? row[k] : b[k];

      if (a === 'addTask') {
        if (!s(F('title'))) return res.status(400).json({ error: '請填任務名稱' });
        const task = {
          title:    s(F('title')),   category: s(F('category')),
          member:   s(F('member')),  executor: s(F('executor')),
          priority: s(F('priority')) || '中',
          status:   s(F('status'))   || '待處理',
          due:      d(F('due')),     note:     s(F('note')),
        };
        // 階層不合法就整筆拒絕，不要建立出錯誤的父子關係之後再來收拾
        const pRaw = F('parentTaskId');
        const bad = await checkParent(pRaw, null);
        if (bad) return res.status(400).json({ error: bad });
        const parentId = (pRaw === null || pRaw === undefined || pRaw === '') ? null : id(pRaw);

        const r = await sql`insert into tk_task (title,category,member,executor,priority,status,due,note,parent_task_id)
          values (${task.title},${task.category},${task.member},${task.executor},
                  ${task.priority},${task.status},${task.due},${task.note},${parentId})
          returning id::text`;
        // 通知失敗不能讓新增跟著失敗——任務已經寫進去了
        let notify = null;
        if (bo(b.notify)) {
          try { notify = await notifyTask(task, 'new'); }
          catch (e) { notify = { ok: false, reason: String(e.message || e) }; }
        }
        return res.status(200).json({ ok: true, id: r[0].id, notify });
      }
      if (a === 'updateTask') {
        const tid = id(b.id); if (!tid) return res.status(400).json({ error: '缺少 id' });
        const f = row;
        // 只更新有送來的欄位（前端一次改一格）
        if ('title'    in f) await sql`update tk_task set title=${s(f.title)},       updated_at=now() where id=${tid}`;
        if ('category' in f) await sql`update tk_task set category=${s(f.category)}, updated_at=now() where id=${tid}`;
        if ('member'   in f) await sql`update tk_task set member=${s(f.member)},     updated_at=now() where id=${tid}`;
        if ('executor' in f) await sql`update tk_task set executor=${s(f.executor)}, updated_at=now() where id=${tid}`;
        if ('priority' in f) await sql`update tk_task set priority=${s(f.priority)}, updated_at=now() where id=${tid}`;
        if ('status'   in f) await sql`update tk_task set status=${s(f.status)},     updated_at=now() where id=${tid}`;
        if ('due'      in f) await sql`update tk_task set due=${d(f.due)},           updated_at=now() where id=${tid}`;
        if ('note'     in f) await sql`update tk_task set note=${s(f.note)},         updated_at=now() where id=${tid}`;
        /* parentTaskId 沿用同樣的 partial update 規則：
           有送才動，沒送就不要碰原本的值。
           送 null 代表「解除父子關係，變回主任務」，這是有意義的值，不是沒送。 */
        if ('parentTaskId' in f) {
          const bad = await checkParent(f.parentTaskId, tid);
          if (bad) return res.status(400).json({ error: bad });
          const pv = (f.parentTaskId === null || f.parentTaskId === undefined || f.parentTaskId === '')
            ? null : id(f.parentTaskId);
          await sql`update tk_task set parent_task_id=${pv}, updated_at=now() where id=${tid}`;
        }
        return res.status(200).json({ ok: true });
      }
      if (a === 'deleteTask') {
        await sql`delete from tk_task where id=${id(b.id)}`;
        return res.status(200).json({ ok: true });
      }
      if (a === 'addHistory') {
        await sql`insert into tk_history (task_id, change) values (${id(b.taskId)}, ${s(b.change)})`;
        return res.status(200).json({ ok: true });
      }

      if (a === 'addMeeting') {
        if (!s(F('title'))) return res.status(400).json({ error: '請填會議名稱' });
        const r = await sql`insert into tk_meeting (title,date,summary,doc_url)
          values (${s(F('title'))},${d(F('date'))},${s(F('summary'))},${s(F('docUrl'))}) returning id::text`;
        const acts = Array.isArray(b.actions) ? b.actions : [];
        let i = 0;
        for (const x of acts) {
          const txt = s(x && (x.text || x));
          if (!txt) continue;
          await sql`insert into tk_action (meeting_id,text,member,sort)
            values (${id(r[0].id)},${txt},${s(x && x.member)},${i++})`;
        }
        return res.status(200).json({ ok: true, id: r[0].id });
      }
      if (a === 'toggleAction') {
        await sql`update tk_action set done=${bo(b.done)} where id=${id(b.actionId)}`;
        return res.status(200).json({ ok: true });
      }

      if (a === 'addMember') {
        if (!s(F('name'))) return res.status(400).json({ error: '請填成員姓名' });
        const r = await sql`insert into tk_member (name) values (${s(F('name'))}) returning id::text`;
        return res.status(200).json({ ok: true, id: r[0].id });
      }
      if (a === 'updateMember') {
        const mid = id(b.id); if (!mid) return res.status(400).json({ error: '缺少 id' });
        if ('name'   in row) await sql`update tk_member set name=${s(row.name)}     where id=${mid}`;
        if ('userId' in row) await sql`update tk_member set user_id=${s(row.userId)} where id=${mid}`;
        if ('notify' in row) await sql`update tk_member set notify=${bo(row.notify)} where id=${mid}`;
        return res.status(200).json({ ok: true });
      }
      if (a === 'deleteMember') {
        await sql`delete from tk_member where id=${id(b.id)}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: '未知的 action: ' + a });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
