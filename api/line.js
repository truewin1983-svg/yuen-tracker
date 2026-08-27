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

/* ⚠️ 這支曾經被上傳到錯的 repo，導致「看起來有改、其實沒生效」查了很久。
   版本號會印在 ?debug=1 那一頁，改版時把日期往後推，
   就能一眼確認眼前這個網址跑的是哪一版。 */
const LINE_VER = '2026-08-27a';

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
/* 直接問 LINE：這組 token 到底是哪一隻機器人的？
   兩隻機器人的 token 長得一模一樣，肉眼分不出來，
   填錯的話 fetchGroupName 與 replyText 會一起靜靜失敗。 */
async function whoAmI() {
  const token = (process.env.LINE_TOKEN || '').trim();
  if (!token) return { ok: false, msg: '沒有設定 LINE_TOKEN' };
  try {
    const r = await fetch('https://api.line.me/v2/bot/info',
      { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) return { ok: false, msg: 'LINE 回 ' + r.status + '（token 無效或已重新產生）' };
    const j = await r.json();
    return { ok: true, msg: (j.displayName || '?') + '（' + (j.basicId || '?') + '）' };
  } catch (e) { return { ok: false, msg: String(e.message || e) }; }
}

function debugPage(groups, logs, env) {
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
        <td>${x.source_type === 'group' ? '群組'
              : x.source_type === 'user' ? '私訊'
              : x.source_type === 'bind' ? '🔗 綁定' : esc(x.source_type)}</td>
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

  const envBox = `<h2>這個網址的身分</h2>
<table>
  <tr><th>網域</th><td><code>${esc(env.host)}</code></td></tr>
  <tr><th>程式版本</th><td><code>${esc(env.ver)}</code></td></tr>
  <tr><th>LINE_TOKEN 屬於</th><td>${env.bot.ok
      ? '<b>' + esc(env.bot.msg) + '</b>'
      : '<span style="color:#b3261e">⚠️ ' + esc(env.bot.msg) + '</span>'}</td></tr>
</table>
<div class="sub" style="margin-top:6px">
  「LINE_TOKEN 屬於」必須是<b>這個 Webhook 對應的那一隻</b>機器人。
  拿到另一隻的 token，回覆訊息與抓群組名稱都會失敗。</div>`;

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
${envBox}
${hint}
<h2>已記錄的群組（${groups.length}）</h2>
<table><tr><th>群組 ID</th><th>名稱</th><th>機器人</th><th>狀態</th><th>最後訊息</th></tr>${g}</table>
<h2>最近收到的訊息（最新 ${logs.length} 筆）</h2>
<table><tr><th>時間</th><th>來源</th><th>群組 ID</th><th>事件</th><th>內容</th></tr>${l}</table>
<a class="re" href="?debug=1">↻ 重新整理</a>
<script>
function cp(t){ navigator.clipboard.writeText(t).then(
  ()=>alert('已複製：'+t), ()=>prompt('請手動複製：', t)); }
</script>
</body></html>`;
}

/* ── 成員綁定（原本在 GAS，2026/08 搬進來）──────────────
   為什麼要搬：成員名冊早就存在 Neon 的 tk_member，
   但 GAS 查的是它自己的 Google 試算表，兩份資料對不起來——
   在網頁上新增的人，私訊綁定時會回「找不到這個名字」。      */

// 回覆使用者。用 replyToken 不算推播額度，比 push 省。
async function replyText(replyToken, text) {
  const token = (process.env.LINE_TOKEN || '').trim();
  if (!token || !replyToken) return false;
  try {
    const r = await fetch('https://api.line.me/v2/bot/message/reply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: String(text).slice(0, 4900) }] }),
    });
    return r.ok;
  } catch (e) { return false; }
}

// 全形轉半形、去掉所有空白，讓「林 家禾」「家禾 」都比對得到
const norm = s => String(s || '')
  .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/\s+/g, '')
  .trim();

/* 把綁定的處理結果也寫進 line_hook_log。
   以前這裡每一條失敗路徑都是 return 或 catch 吞掉，
   結果「私訊有進來但沒綁上」完全查不出卡在哪一步。
   現在 ?debug=1 就看得到 bind 這種事件與它的結論。 */
async function logBind(text) {
  if (!sql) return;
  try {
    await sql`insert into line_hook_log (source_type, group_id, event_type, text)
              values ('bind', null, 'bind', ${String(text).slice(0, 60)})`;
  } catch (e) {}
}

async function handleBinding(ev) {
  if (!sql) { await logBind('沒有 DATABASE_URL'); return; }
  if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
  const userId = (ev.source || {}).userId;
  if (!userId) { await logBind('事件裡沒有 userId'); return; }

  const raw = String(ev.message.text || '').trim();
  if (!raw) return;
  const key = norm(raw);

  let rows = [];
  try { rows = await sql`select id, name, user_id from tk_member`; }
  catch (e) { await logBind('查 tk_member 失敗：' + String(e.message || e)); return; }
  await logBind('讀到 ' + rows.length + ' 位成員，比對「' + raw + '」');

  // 先找完全一樣的，找不到再放寬成「去掉空白後相同」
  let hit = rows.find(r => String(r.name).trim() === raw)
         || rows.find(r => norm(r.name) === key);

  if (!hit) {
    // 猜可能想打的名字：包含關係雙向都算（打「家禾」也要找得到「林家禾」）
    const guess = rows
      .filter(r => norm(r.name).includes(key) || key.includes(norm(r.name)))
      .map(r => r.name).slice(0, 5);
    await replyText(ev.replyToken,
      `找不到「${raw}」這個名字 🤔\n` +
      (guess.length
        ? `你是不是要打：\n${guess.map(x => '・' + x).join('\n')}\n\n直接把上面的名字貼過來就可以綁定。`
        : '請確認與系統中的姓名完全一致，或請管理員先到「成員」頁面新增你。'));
    return;
  }

  // 已經綁在別人身上就別默默覆蓋，講清楚讓人找管理員
  if (hit.user_id && hit.user_id !== userId) {
    await replyText(ev.replyToken,
      `「${hit.name}」已經綁定過另一個 LINE 帳號了。\n` +
      '如果那是你的舊帳號，請找管理員解除後再綁一次。');
    return;
  }
  if (hit.user_id === userId) {
    await replyText(ev.replyToken, `「${hit.name}」已經綁定完成了 ✅\n有新任務時會在這裡通知你。`);
    return;
  }

  try {
    await sql`update tk_member set user_id=${userId} where id=${hit.id}`;
    // 先確定資料真的寫進去了，再談有沒有回覆——這兩件事會各自失敗
    const ok = await replyText(ev.replyToken,
      `綁定完成 ✅\n${hit.name}，之後有指派給你的任務，我會在這裡通知你。`);
    await logBind(`已寫入 ${hit.name}` + (ok ? '，並已回覆' : '，但回覆失敗（token 可能不對）'));
  } catch (e) {
    await logBind('寫入失敗：' + String(e.message || e));
    await replyText(ev.replyToken, '綁定時發生錯誤，請稍後再試一次，或聯絡管理員。');
  }
}

// 註：原本這裡會把訊息轉給 Google Apps Script 處理綁定。
//     2026/08 綁定改由本檔的 handleBinding 直接查 tk_member，
//     GAS 那條線已不再使用，可以停用其觸發器。

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
          from line_hook_log order by id desc limit 10`;   // 只看最新 10 筆就夠了，再多反而難掃
        const env = {
          host: String(req.headers.host || '（不明）'),
          ver: LINE_VER,
          bot: await whoAmI(),
        };
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(debugPage(groups, logs, env));
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

  /* 私訊＝成員綁定，直接在這裡處理，不再轉給 GAS。
     GAS 查的是它自己的 Google 試算表，跟系統的 tk_member 是兩份資料，
     在網頁上新增的人會綁不到。搬進來之後只有一份名單。
     群組訊息只記 groupId，不做任何回覆，才不會干擾群組。 */
  const events = Array.isArray(body && body.events) ? body.events : [];
  const dmEvents = events.filter(ev => (ev.source || {}).type === 'user');
  for (const ev of dmEvents) {
    try { await handleBinding(ev); } catch (e) {}
  }
  return res.status(200).send('OK');
}
