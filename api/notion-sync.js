// 昱恩追蹤工具 — tk_task → Notion「翔哥｜待辦中控台」同步
//
// GET  /api/notion-sync?key=…&dry=1   試跑：只回報「會做什麼」，不動 Notion
// POST /api/notion-sync               實際執行
//
// ── 設計重點 ──────────────────────────────────────────
// 1. 靠 tk_task.notion_page_id 認人，不靠標題。有值就更新那一頁，
//    沒值就先用 Tracker ID 去 Notion 找，再找不到才建立新頁。
//    這是「不會產生重複」的關鍵——標題會被人改，id 不會。
//
// 2. 只推「未完成」的任務（status <> '已完成'）。
//
// 3. 「類型」只在【建立新頁】時寫入，更新時不碰。
//    因為翔哥／Sandy 會在 Notion 上手動把某些任務改成「待翔哥決策」，
//    每次同步都覆蓋回去的話，那個調整永遠留不住。
//
// 4. 「來源」用 multi_select，更新時把「昱恩系統」併進去而不是取代。
//    同一件事可能同時由 Sandy 或 GPT 提出，不能把別人的來源洗掉。
//
// 5. 這支只寫 Notion，不會改 tk_task 的任何業務欄位，
//    唯一會寫回的是 notion_page_id。

import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const NOTION_VER = '2022-06-28';
const API = 'https://api.notion.com/v1';

// 依負責人決定類型。「待翔哥決策」推不出來——那是「等他拍板」，
// 跟「誰執行」是兩回事，只能人工在 Notion 上調，所以這裡不產生。
const typeOf = member => (String(member || '').trim() === '翔哥') ? '翔哥待辦' : '團隊追蹤';

const txt  = v => [{ text: { content: String(v ?? '').slice(0, 2000) } }];
const sel  = v => { const x = String(v ?? '').trim(); return x ? { name: x } : null; };

async function notion(path, method, body) {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Authorization': 'Bearer ' + (process.env.NOTION_TOKEN || '').trim(),
      'Notion-Version': NOTION_VER,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Notion ' + r.status + '：' + (j.message || '').slice(0, 200));
  return j;
}

// 組 Notion 屬性。isNew 決定要不要寫「類型」與「來源」
function propsOf(t, isNew, existingSources) {
  const p = {
    '待辦事項':   { title: txt(t.title) },
    'Tracker ID': { rich_text: txt(t.id) },
  };
  // 空值也要送出（null），否則在昱恩系統清空的欄位，Notion 這邊會留著舊值
  p['Status']   = { status: sel(t.status) || { name: '待處理' } };
  p['Deadline'] = { date: t.due ? { start: t.due } : null };
  p['Owner']    = { select: sel(t.member) };
  p['專案']     = { select: sel(t.category) };
  p['優先度']   = { select: sel(t.priority) };

  if (isNew) {
    p['類型'] = { select: { name: typeOf(t.member) } };
    p['來源'] = { multi_select: [{ name: '昱恩系統' }] };
  } else {
    // 併進去，不是取代——同一件事可能也由 Sandy 或 GPT 提出過
    const names = new Set([...(existingSources || []), '昱恩系統']);
    p['來源'] = { multi_select: [...names].map(n => ({ name: n })) };
  }
  return p;
}

// 用 Tracker ID 在 Notion 裡找。給「頁面被建過但 notion_page_id 沒存回來」的情況補救
async function findByTrackerId(dbid, id) {
  const j = await notion('/databases/' + dbid + '/query', 'POST', {
    filter: { property: 'Tracker ID', rich_text: { equals: String(id) } },
    page_size: 1,
  });
  return (j.results || [])[0] || null;
}

export default async function handler(req, res) {
  const want = (process.env.TRACK_SECRET || '').trim();
  if (want) {
    const got = String(req.headers['x-track-key'] || req.query.key || '').trim();
    if (got !== want) return res.status(401).json({ error: '通行碼不正確' });
  }

  const token = (process.env.NOTION_TOKEN || '').trim();
  const dbid  = (process.env.NOTION_DB_ID || '').trim().replace(/-/g, '');
  if (!token || !dbid) {
    return res.status(200).json({ error: 'NOTION_TOKEN 或 NOTION_DB_ID 沒設定' });
  }

  // GET 一律當試跑，避免有人在網址列不小心觸發寫入
  const dry = req.method === 'GET' || String(req.query.dry || '') === '1';

  try {
    const tasks = await sql`
      select id::text, title, category, member, priority, status,
             to_char(due,'YYYY-MM-DD') as due, notion_page_id
      from tk_task
      where coalesce(status,'') <> '已完成'
      order by id`;

    const plan = [], done = [], failed = [];

    for (const t of tasks) {
      let pageId = t.notion_page_id;
      let existingSources = [];

      // notion_page_id 沒有的話，先用 Tracker ID 找找看，避免重複建立
      if (!pageId) {
        try {
          const hit = await findByTrackerId(dbid, t.id);
          if (hit) {
            pageId = hit.id;
            existingSources = (hit.properties?.['來源']?.multi_select || []).map(o => o.name);
          }
        } catch (e) { /* 查不到就當作新的 */ }
      }

      const action = pageId ? '更新' : '新增';
      plan.push({ id: t.id, 標題: t.title, 動作: action,
                  類型: pageId ? '（不變更）' : typeOf(t.member) });
      if (dry) continue;

      try {
        if (pageId) {
          if (!existingSources.length) {
            const cur = await notion('/pages/' + pageId, 'GET');
            existingSources = (cur.properties?.['來源']?.multi_select || []).map(o => o.name);
          }
          await notion('/pages/' + pageId, 'PATCH',
            { properties: propsOf(t, false, existingSources) });
        } else {
          const created = await notion('/pages', 'POST', {
            parent: { database_id: dbid },
            properties: propsOf(t, true),
          });
          pageId = created.id;
        }
        // 寫回 page id。這一步失敗的話下次會靠 Tracker ID 找回來，不會產生重複
        if (t.notion_page_id !== pageId) {
          await sql`update tk_task set notion_page_id=${pageId} where id=${Number(t.id)}`;
        }
        done.push({ id: t.id, 標題: t.title, 動作: action });
      } catch (e) {
        failed.push({ id: t.id, 標題: t.title, 原因: String(e.message || e) });
      }
    }

    return res.status(200).json({
      模式: dry ? '試跑（沒有動到 Notion）' : '實際執行',
      未完成任務數: tasks.length,
      ...(dry ? { 預計動作: plan }
              : { 成功: done.length, 失敗: failed.length, 明細: done, 失敗明細: failed }),
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
