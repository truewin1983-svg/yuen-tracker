// 昱恩追蹤工具 — LINE webhook 中繼
// LINE 打到這支 → ① 記下群組 ID（給昱恩系統的推播站用）
//                ② 轉給 Apps Script 處理成員綁定 → 回 200 給 LINE
// LINE 的 Webhook URL： https://你的網域.vercel.app/api/line
//
// ⚠️ 為什麼兩件事都在這裡做：
//    一隻 LINE 機器人只能設「一個」Webhook URL。
//    原本這支只轉給 GAS（成員綁定），所以昱恩系統記不到群組 ID。
//    直接把網址改成昱恩系統的話，綁定功能就會壞掉。
//    因此改成這支同時做兩件事，兩邊功能都保留。
import { neon } from '@neondatabase/serverless';

const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

let _ready = false;
async function ensureTable() {
  if (!sql || _ready) return;
  try {
    await sql`create table if not exists line_group (
      group_id   text primary key,
      name       text,
      note       text,
      active     boolean default true,
      last_seen  timestamptz default now(),
      created_at timestamptz default now()
    )`;
  } catch (e) {}
  try { await sql`alter table line_group add column if not exists bot text default 'yuen'`; } catch (e) {}
  /* 收件記錄。用途是分辨兩種「沒反應」：
     ① LINE 根本沒打進來（一筆都沒有）→ 後台開關或 Webhook 網址的問題
     ② 有打進來但沒有群組事件 → 訊息是私訊，或機器人還沒真的在群組裡
     只留最近 200 筆，不會無限長大。 */
  try {
    await sql`create table if not exists line_hook_log (
      id bigserial primary key,
      source_type text,
      group_id    text,
      event_type  text,
      text        text,
      created_at  timestamptz default now()
    )`;
  } catch (e) {}
  _ready = true;
}

// 群組名稱拿不到也沒關係，之後可以在推播站自己命名
async function fetchGroupName(groupId) {
  const token = process.env.LINE_TOKEN;
  if (!token) return null;
  try {
    const r = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/summary`, {
      headers: { Authorization: 'Bearer ' + token },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.groupName || null;
  } catch (e) { return null; }
}

// 記下機器人被加進哪些群組。失敗不影響後面轉給 GAS。
async function recordGroups(body) {
  if (!sql) return;
  const events = Array.isArray(body && body.events) ? body.events : [];
  if (!events.length) return;
  await ensureTable();
  for (const ev of events) {
    const src = ev.source || {};
    // 先記收件（含私訊），這樣才看得出 LINE 有沒有打進來
    try {
      await sql`insert into line_hook_log (source_type, group_id, event_type, text)
                values (${src.type || '?'}, ${src.groupId || null}, ${ev.type || '?'},
                        ${(ev.message && ev.message.text) ? String(ev.message.text).slice(0, 60) : null})`;
      await sql`delete from line_hook_log where id < (
        select coalesce(max(id), 0) - 200 from line_hook_log)`;
    } catch (e) {}

    if (src.type !== 'group' || !src.groupId) continue;
    const gid = src.groupId;
    if (ev.type === 'leave') {
      try { await sql`update line_group set active=false where group_id=${gid}`; } catch (e) {}
      continue;
    }
    const name = await fetchGroupName(gid);
    try {
      await sql`insert into line_group (group_id, name, bot, active, last_seen)
                values (${gid}, ${name}, 'yuen', true, now())
                on conflict (group_id) do update set
                  name = coalesce(excluded.name, line_group.name),
                  bot = 'yuen', active = true, last_seen = now()`;
    } catch (e) {}
  }
}

const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 一頁純 HTML，手機也看得懂。群組 ID 有「複製」按鈕，貼到推播站很方便。
function debugPage(groups, logs) {
  const g = groups.length
    ? groups.map(x => `<tr>
        <td><code id="g${esc(x.group_id)}">${esc(x.group_id)}</code>
            <button onclick="cp('${esc(x.group_id)}')">複製</button></td>
        <td>${esc(x.name || '（沒抓到名稱）')}</td>
        <td>${esc(x.bot || '')}</td>
        <td>${x.active === false ? '已離開' : '在群組中'}</td>
        <td>${esc(x.last_seen || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="none">還沒有記到任何群組</td></tr>';

  const l = logs.length
    ? logs.map(x => `<tr>
        <td>${esc(x.at)}</td>
        <td>${x.source_type === 'group' ? '群組' : (x.source_type === 'user' ? '私訊' : esc(x.source_type))}</td>
        <td><code>${esc(x.group_id || '—')}</code></td>
        <td>${esc(x.event_type)}</td>
        <td>${esc(x.text || '')}</td></tr>`).join('')
    : '<tr><td colspan="5" class="none">完全沒有收到 LINE 的訊息</td></tr>';

  const hint = logs.length
    ? (groups.length
        ? '<p class="ok">✅ 一切正常。上面的群組 ID 可以直接複製到推播站使用。</p>'
        : `<p class="warn">⚠️ LINE 有打進來，但沒有群組事件。<br>
             請確認：機器人已經在群組裡，而且是在<b>群組內</b>發訊息（私訊不算）。</p>`)
    : `<p class="warn">⚠️ 完全沒有收到 LINE 的訊息，代表 webhook 沒被呼叫。<br>
         請到 <b>manager.line.biz</b> 確認三項：回應模式的「聊天」<b>關閉</b>、
         Webhook <b>開啟</b>、自動回應訊息<b>停用</b>。</p>`;

  return `<!DOCTYPE html><html lang="zh-Hant-TW"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LINE 群組 ID</title>
<style>
 body{font-family:system-ui,"Noto Sans TC",sans-serif;background:#f4f5f7;color:#1c2230;
   margin:0;padding:18px;line-height:1.6;font-size:14px}
 h1{font-size:19px;margin:0 0 4px} h2{font-size:15px;margin:22px 0 8px}
 .sub{color:#8a93a3;font-size:12.5px;margin-bottom:14px}
 table{width:100%;border-collapse:collapse;background:#fff;font-size:13px;
   box-shadow:0 1px 3px rgba(0,0,0,.06);border-radius:8px;overflow:hidden}
 th,td{border-bottom:1px solid #e4e7ec;padding:9px 10px;text-align:left;vertical-align:top}
 th{background:#eef1f5;color:#5a6473;font-size:12px;white-space:nowrap}
 code{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
 button{font:inherit;font-size:11.5px;border:1px solid #cfd6de;background:#fff;
   border-radius:6px;padding:2px 9px;margin-left:6px;cursor:pointer}
 .none{color:#8a93a3;text-align:center;padding:22px}
 .ok{background:#e8f6ef;border:1px solid #bfe3ce;color:#137a48;padding:11px 14px;border-radius:9px}
 .warn{background:#fdf3e1;border:1px solid #f0dcb4;color:#8a5a0b;padding:11px 14px;border-radius:9px}
 .re{display:inline-block;margin-top:16px;color:#3f5e8c}
</style></head><body>
<h1>LINE 群組 ID</h1>
<div class="sub">在群組裡發一則訊息，再重新整理這一頁。</div>
${hint}
<h2>已記錄的群組（${groups.length}）</h2>
<table><tr><th>群組 ID</th><th>名稱</th><th>機器人</th><th>狀態</th><th>最後訊息</th></tr>${g}</table>
<h2>最近收到的訊息（${logs.length}）</h2>
<table><tr><th>時間</th><th>來源</th><th>群組 ID</th><th>事件</th><th>內容</th></tr>${l}</table>
<a class="re" href="?debug=1">↻ 重新整理</a>
<script>
function cp(t){ navigator.clipboard.writeText(t).then(
  ()=>alert('已複製：'+t), ()=>prompt('請手動複製：', t)); }
</script>
</body></html>`;
}

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbyrdi1iyX4342FwLl2c_SyrSH9dY4yVlqDToXS34yJEDeI1bDn8mfYwB-brn8yZFdPANg/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // 用瀏覽器打開這個網址就能看到群組 ID 與收件記錄，
    // 不必去翻資料庫。?debug=1 才輸出，避免無意間外流群組 ID。
    if (String(req.query.debug || '') === '1' && sql) {
      try {
        await ensureTable();
        const groups = await sql`select group_id, name, bot, active,
            to_char(last_seen at time zone 'Asia/Taipei','MM/DD HH24:MI') as last_seen
          from line_group order by last_seen desc limit 50`;
        const logs = await sql`select source_type, group_id, event_type, text,
            to_char(created_at at time zone 'Asia/Taipei','MM/DD HH24:MI:SS') as at
          from line_hook_log order by id desc limit 30`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(debugPage(groups, logs));
      } catch (e) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send('<p>查詢失敗：' + esc(String(e.message || e)) + '</p>');
      }
    }
    res.status(200).send('LINE relay OK');
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // 先記群組。包 try 是因為這件事失敗不該影響成員綁定。
  try { await recordGroups(body); } catch (e) {}

  /* 只把「私訊」轉給 GAS。
     GAS 那支是成員綁定用的，收到不認得的名字就會回
     「找不到這個名字…」。綁定本來就該私訊做，
     在群組裡回這種訊息只是干擾大家。
     群組事件在上面記完 groupId 就夠了，不需要再轉。 */
  const events = Array.isArray(body && body.events) ? body.events : [];
  const dmEvents = events.filter(ev => (ev.source || {}).type === 'user');
  if (!dmEvents.length) {
    return res.status(200).send('OK');   // 全是群組事件，不轉給 GAS
  }
  body = { ...body, events: dmEvents };

  // 確實把訊息轉給 GAS，並等它送出（最多等 8 秒，避免無限卡住）
  // fetch 會自動跟隨 GAS 的 302，所以 GAS 會真的被執行到
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (e) {
    // 即使逾時或失敗，仍回 200 給 LINE，避免它重送造成重複
  }

  res.status(200).send('OK');
}
