// 昱恩追蹤工具 — LINE webhook 中繼
// LINE 打到這支 → 確實把訊息轉給 Apps Script 處理綁定/回覆 → 回 200 給 LINE
// LINE 的 Webhook URL： https://你的網域.vercel.app/api/line

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
