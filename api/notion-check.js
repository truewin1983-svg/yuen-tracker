// 昱恩追蹤工具 — Notion 連線檢查（唯讀）
//
// GET /api/notion-check
//
// 這支只做一件事：問 Notion「這個 Database 長什麼樣」，把結果印出來。
// 不會建立、不會修改、不會刪除任何 Notion 內容。
//
// 為什麼需要它：
//   Notion 的屬性名稱必須一字不差。「Tracker ID」和「TrackerID」是兩個
//   不同的東西，猜錯了 API 不會報錯，只會靜靜地寫不進去。
//   與其用眼睛看截圖去抄，不如讓程式把真實名稱印出來——這樣不可能對錯。
//
// 同時也驗證三件事：token 有效嗎、Database 授權了嗎、ID 對嗎。
// 這三個任何一個沒過，直接寫同步都會卡在很難懂的錯誤上。

const NOTION_VER = '2022-06-28';   // Notion API 版本，寫死才不會哪天被改壞

export default async function handler(req, res) {
  // 沿用 track.js 那組通行碼。這支會吐出 Database 結構，不該公開
  const want = (process.env.TRACK_SECRET || '').trim();
  if (want) {
    const got = String(req.headers['x-track-key'] || req.query.key || '').trim();
    if (got !== want) return res.status(401).json({ error: '通行碼不正確' });
  }

  const token = (process.env.NOTION_TOKEN || '').trim();
  const dbid  = (process.env.NOTION_DB_ID || '').trim().replace(/-/g, '');

  const out = {
    'NOTION_TOKEN': token ? '有設定（' + token.slice(0, 4) + '…）' : '❌ 沒有設定',
    'NOTION_DB_ID': dbid || '❌ 沒有設定',
  };
  if (!token || !dbid) {
    out['結論'] = '環境變數缺一個，先去 Vercel 補上並重新 Redeploy';
    return res.status(200).json(out);
  }

  try {
    const r = await fetch('https://api.notion.com/v1/databases/' + dbid, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Notion-Version': NOTION_VER,
      },
    });
    const j = await r.json();

    if (!r.ok) {
      out['連線結果'] = '❌ HTTP ' + r.status;
      out['Notion說'] = j.message || JSON.stringify(j).slice(0, 300);
      // 這兩種錯誤最常見，直接給出對應的處理方式，不要讓人去 Google
      if (r.status === 404) {
        out['怎麼辦'] = 'Database 沒有授權給這個 integration，或 ID 不對。'
          + '去 Notion 開啟「翔哥｜待辦中控台」→ 右上 ⋯ → 連接 → 選「昱恩追蹤同步」。';
      } else if (r.status === 401) {
        out['怎麼辦'] = 'NOTION_TOKEN 不正確，或改過之後沒有 Redeploy。';
      }
      return res.status(200).json(out);
    }

    out['連線結果'] = '✅ 通了';
    out['資料庫名稱'] = (j.title || []).map(t => t.plain_text).join('') || '(沒有標題)';

    // 把每個屬性的真實名稱與型別列出來，Select 類的把選項也帶出來
    const props = j.properties || {};
    out['屬性一覽'] = Object.keys(props).map(name => {
      const p = props[name];
      const row = { '名稱': name, '型別': p.type };
      if (p.type === 'select')       row['選項'] = (p.select?.options || []).map(o => o.name);
      if (p.type === 'multi_select') row['選項'] = (p.multi_select?.options || []).map(o => o.name);
      if (p.type === 'status')       row['選項'] = (p.status?.options || []).map(o => o.name);
      return row;
    });

    // 提前指出對應不到的欄位，免得寫完同步才發現
    const need = ['待辦事項', 'Status', 'Deadline', 'Owner', '類型', '專案', 'Tracker ID', '優先度', '來源'];
    const missing = need.filter(n => !props[n]);
    out['預期欄位是否齊全'] = missing.length ? '❌ 找不到：' + missing.join('、') : '✅ 全部對得上';

    return res.status(200).json(out);
  } catch (e) {
    out['連線結果'] = '❌ 呼叫失敗';
    out['錯誤'] = String(e.message || e);
    return res.status(200).json(out);
  }
}
