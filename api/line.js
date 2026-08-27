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

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbyrdi1iyX4342FwLl2c_SyrSH9dY4yVlqDToXS34yJEDeI1bDn8mfYwB-brn8yZFdPANg/exec';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
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
