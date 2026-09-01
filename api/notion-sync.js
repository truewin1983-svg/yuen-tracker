// 昱恩追蹤工具 — tk_task → Notion「翔哥｜待辦中控台」同步
//
// GET  /api/notion-sync?key=…            試跑：只回報「會做什麼」，不動 Notion
// POST /api/notion-sync?key=…&limit=50    實際執行，一次處理 50 筆
//
// ⚠️ 一定要分批。Notion API 大約每秒只能 3 個請求，而 tk_task 有 385 筆未完成，
//    一次全推要跑四分多鐘，Vercel function 撐不到就會被砍在半路，
//    造成「一部分建好、一部分沒有」而且不知道斷在哪。
//    改成每次跑一批、把還沒同步的排前面，重複按幾次就會全部完成。
//
// ── 設計重點 ──────────────────────────────────────────
// 1. 靠 tk_task.notion_page_id 認人，不靠標題。有值就更新那一頁，
//    沒值就先用 Tracker ID 去 Notion 找，再找不到才建立新頁。
//    這是「不會產生重複」的關鍵——標題會被人改，id 不會。
//
// 2. 收錄條件：狀態不是「完成」也不是「取消/終止」，且（進行中 或 有設截止日）。
//    ⚠️ 資料庫裡的完成狀態是「完成」不是「已完成」。一開始寫錯字，
//       結果 310 筆已完成的任務全部被撈進來，總數變成 385。
//       改狀態值時記得回來看這裡——這個條件是寫死字串比對，錯了不會報錯，
//       只會默默多推或少推。
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

// Vercel 預設 10 秒不夠跑一批。Hobby 方案最多可以到 60 秒
export const config = { maxDuration: 60 };

const BATCH  = 50;    // 一次處理幾筆
const GAP_MS = 340;   // 每筆之間喘一下，避開 Notion 每秒 3 次的限制
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

/* 一次把 Notion 現有頁面全撈回來，建成 Tracker ID → 頁面 的索引。
   原本是每筆任務查一次，50 筆就要多 50 個請求，速率限制下等於慢一倍。
   改成開頭撈一次（每 100 筆一個請求），之後查記憶體就好。
   這份索引同時也是防重複的依據：頁面建過但 notion_page_id 沒寫回資料庫時，
   靠它認得出來，不會再建一頁。 */
async function loadExisting(dbid) {
  const map = new Map();
  let cursor;
  do {
    const j = await notion('/databases/' + dbid + '/query', 'POST',
      { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    for (const pg of (j.results || [])) {
      const tid = (pg.properties?.['Tracker ID']?.rich_text || [])
        .map(x => x.plain_text).join('').trim();
      if (!tid) continue;
      map.set(tid, {
        pageId: pg.id,
        sources: (pg.properties?.['來源']?.multi_select || []).map(o => o.name),
      });
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return map;
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
  // GET 一律當試跑，避免有人在網址列不小心觸發寫入
  const dry   = req.method === 'GET' || String(req.query.dry || '') === '1';
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || BATCH));

  try {
    /* 收錄條件：未完成，且（進行中 或 有截止日）。
       兩個條件取聯集——狀態在動的、有期限在跑的，都算活著的事。 */
    const tasks = await sql`
      select id::text, title, category, member, priority, status,
             to_char(due,'YYYY-MM-DD') as due, notion_page_id
      from tk_task
      where coalesce(status,'') not in ('完成', '已完成', '取消/終止', '取消', '終止')
        and (status = '進行中' or due is not null)
      order by (notion_page_id is not null), id`;
    // 排序把「還沒同步的」放前面，重複跑幾次就會逐批做完

    const pending = tasks.filter(t => !t.notion_page_id).length;

    if (dry) {
      return res.status(200).json({
        模式: '試跑（沒有動到 Notion）',
        符合條件的任務: tasks.length,
        其中還沒同步: pending,
        這次會處理: Math.min(limit, tasks.length),
        大約要跑幾輪: Math.ceil(tasks.length / limit),
        前十筆預覽: tasks.slice(0, 10).map(t => ({
          id: t.id, 標題: t.title,
          動作: t.notion_page_id ? '更新' : '新增',
          類型: t.notion_page_id ? '（不變更）' : typeOf(t.member),
        })),
      });
    }

    const existing = await loadExisting(dbid);
    const batch = tasks.slice(0, limit);
    const done = [], failed = [];

    for (const t of batch) {
      const hit = existing.get(String(t.id));
      let pageId = t.notion_page_id || (hit && hit.pageId) || null;
      const action = pageId ? '更新' : '新增';
      try {
        if (pageId) {
          /* 「來源」是併進去不是取代，所以更新前一定要知道那頁現在有哪些來源。
             索引裡查得到就用索引；查不到（例如那頁的 Tracker ID 是空的）
             一定要單獨讀一次，不能當成空陣列——那會把 Sandy整理／GPT 洗掉。 */
          let sources = hit && hit.sources;
          if (!sources) {
            const cur = await notion('/pages/' + pageId, 'GET');
            sources = (cur.properties?.['來源']?.multi_select || []).map(o => o.name);
          }
          await notion('/pages/' + pageId, 'PATCH',
            { properties: propsOf(t, false, sources) });
        } else {
          const created = await notion('/pages', 'POST', {
            parent: { database_id: dbid },
            properties: propsOf(t, true),
          });
          pageId = created.id;
        }
        // 寫回 page id。這步失敗也不會產生重複，下次靠 Tracker ID 索引認得出來
        if (t.notion_page_id !== pageId) {
          await sql`update tk_task set notion_page_id=${pageId} where id=${Number(t.id)}`;
        }
        done.push({ id: t.id, 標題: t.title, 動作: action });
      } catch (e) {
        failed.push({ id: t.id, 標題: t.title, 原因: String(e.message || e) });
      }
      await sleep(GAP_MS);
    }

    const left = pending - done.filter(x => x.動作 === '新增').length;
    return res.status(200).json({
      模式: '實際執行',
      這批處理: batch.length,
      成功: done.length,
      失敗: failed.length,
      還沒同步的剩下: Math.max(0, left),
      下一步: left > 0 ? '再按一次同一個網址，會接著處理下一批' : '✅ 全部完成',
      明細: done,
      失敗明細: failed,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
