// 昱恩追蹤工具 — LINE webhook 中繼
// LINE 把訊息打到這支（Vercel 能正常回 200）→ 立刻回 200，再背景轉發給 Apps Script 處理綁定/回覆
// LINE 的 Webhook URL 設為： https://你的網域.vercel.app/api/line

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

  // 先秒回 200 給 LINE（避免逾時）
  res.status(200).send('OK');

  // 再背景轉發給 GAS（不讓 LINE 等）。GAS 慢沒關係，LINE 已經收到回應了。
  try {
    await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // 轉發失敗也無所謂，LINE 端已回 200
  }
}
