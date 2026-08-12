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

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

// ── 讀取 ────────────────────────────────────────────────
async function getTasks() {
  return sql`select id::text, title, category, member, executor, priority, status,
                    to_char(due,'YYYY-MM-DD') as due, note
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
async function getDocs(kind) {
  return sql`select id::text, title, to_char(date,'YYYY-MM-DD') as date,
                    summary, doc_url as "docUrl"
             from tk_doc where kind=${kind} order by date desc nulls last, id desc`;
}
async function getMembers() {
  return sql`select id::text, name, user_id as "userId", notify
             from tk_member order by name`;
}
async function getEvents() {
  return sql`select id::text, title, to_char(date,'YYYY-MM-DD') as date, color, note
             from tk_event order by date, id`;
}

export default async function handler(req, res) {
  try {
    if (!process.env.DATABASE_URL) {
      return res.status(500).json({ error: '尚未設定 DATABASE_URL 環境變數' });
    }

    // ── GET：讀取 ──
    if (req.method === 'GET') {
      const action = String(req.query.action || 'all');

      if (action === 'all') {
        const [tasks, histories, meetings, analytics, reports, members, events] = await Promise.all([
          getTasks(), getHistory(), getMeetings(),
          getDocs('analytics'), getDocs('report'), getMembers(), getEvents(),
        ]);
        return res.status(200).json({ tasks, histories, meetings, analytics, reports, members, events });
      }
      const map = {
        getTasks, getHistory, getMeetings, getMembers, getEvents,
        getAnalytics: () => getDocs('analytics'),
        getReports:   () => getDocs('report'),
        getTrainings: () => getDocs('training'),
      };
      if (!map[action]) return res.status(400).json({ error: '未知的 action: ' + action });
      return res.status(200).json(await map[action]());
    }

    // ── POST：寫入 ──
    if (req.method === 'POST') {
      const b = parseBody(req);
      const a = String(b.action || '');
      const row = b.row || {};

      if (a === 'addTask') {
        const r = await sql`insert into tk_task (title,category,member,executor,priority,status,due,note)
          values (${s(row.title)},${s(row.category)},${s(row.member)},${s(row.executor)},
                  ${s(row.priority) || '中'},${s(row.status) || '待處理'},${d(row.due)},${s(row.note)})
          returning id::text`;
        return res.status(200).json({ ok: true, id: r[0].id });
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
        const r = await sql`insert into tk_meeting (title,date,summary,doc_url)
          values (${s(row.title)},${d(row.date)},${s(row.summary)},${s(row.docUrl)}) returning id::text`;
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

      if (a === 'addAnalytics' || a === 'addReport' || a === 'addTraining') {
        const kind = a === 'addAnalytics' ? 'analytics' : a === 'addReport' ? 'report' : 'training';
        const r = await sql`insert into tk_doc (kind,title,date,summary,doc_url)
          values (${kind},${s(b.title)},${d(b.date)},${s(b.summary)},${s(b.docUrl)}) returning id::text`;
        return res.status(200).json({ ok: true, id: r[0].id });
      }

      if (a === 'addMember') {
        const r = await sql`insert into tk_member (name) values (${s(row.name || b.name)}) returning id::text`;
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

      if (a === 'addEvent') {
        const r = await sql`insert into tk_event (title,date,color,note)
          values (${s(row.title)},${d(row.date)},${s(row.color)},${s(row.note)}) returning id::text`;
        return res.status(200).json({ ok: true, id: r[0].id });
      }
      if (a === 'updateEvent') {
        const eid = id(b.id); if (!eid) return res.status(400).json({ error: '缺少 id' });
        if ('title' in row) await sql`update tk_event set title=${s(row.title)} where id=${eid}`;
        if ('date'  in row) await sql`update tk_event set date=${d(row.date)}   where id=${eid}`;
        if ('color' in row) await sql`update tk_event set color=${s(row.color)} where id=${eid}`;
        if ('note'  in row) await sql`update tk_event set note=${s(row.note)}   where id=${eid}`;
        return res.status(200).json({ ok: true });
      }
      if (a === 'deleteEvent') {
        await sql`delete from tk_event where id=${id(b.id)}`;
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: '未知的 action: ' + a });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
