// 昱恩追蹤工具 — LINE webhook 中繼
// LINE 把訊息打到這支（Vercel 能正常回 200）→ 這支把訊息原封不動轉給你的 Apps Script 處理綁定/回覆
// 部署後，LINE 的 Webhook URL 改成： https://你的網域.vercel.app/api/line

const GAS_URL =
  'https://script.google.com/macros/s/AKfycbyrdi1iyX4342FwLl2c_SyrSH9dY4yVlqDToXS34yJEDeI1bDn8mfYwB-brn8yZFdPANg/exec';

export default async function handler(req, res) {
  // 健康檢查 / 瀏覽器打開時
  if (req.method !== 'POST') {
    res.status(200).send('LINE relay OK');
    return;
  }

  // 取得 LINE 傳來的內容（Vercel 會自動把 JSON 解析到 req.body）
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') body = {};

  // 轉發給 Apps Script（fetch 會自動跟隨 GAS 的 302，所以 GAS 會真的被執行到）
  try {
    await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    // 就算轉發失敗，仍回 200 給 LINE，避免它一直重試
  }

  res.status(200).send('OK');
}
