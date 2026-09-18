/**
 * VSOL V1600D8 Standalone Telegram Bot - 24/7 Monitoring & Control
 */
import https from "https";
import http from "http";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const CONFIG = {
  TELEGRAM_BOT_TOKEN: "8856323035:AAFp63whjEKxy4EQkdIFHkX9vDruaIdCuiI",
  ADMIN_TELEGRAM_IDS: ["6439581798"],
  OLT_HOST: "103.150.19.132",
  OLT_PORT: 16237,
  OLT_USER: "admin",
  OLT_PASS: "Mohon321@",
  POLL_INTERVAL_MS: 30000,
};

const BASE_URL = `https://${CONFIG.OLT_HOST}:${CONFIG.OLT_PORT}`;
const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

let cachedCookie = null;
let lastLoginTime = 0;
const trackedOnus = new Map([["EPON0/1:1", "MR@259"]]);
let lastTelegramUpdateId = 0;

async function loginOlt() {
  if (cachedCookie && Date.now() - lastLoginTime < 120000) {
    return cachedCookie;
  }
  const formData = new URLSearchParams();
  formData.append("user", CONFIG.OLT_USER);
  formData.append("pass", CONFIG.OLT_PASS);
  formData.append("who", "100");

  const res = await fetch(`${BASE_URL}/action/main.html`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Referer": `${BASE_URL}/action/login.html`,
      "User-Agent": "Mozilla/5.0",
    },
    body: formData.toString(),
    redirect: "manual",
  });

  let rawCookie = null;
  if (typeof res.headers.getSetCookie === "function") {
    const list = res.headers.getSetCookie();
    if (list && list.length > 0) rawCookie = list[0];
  }
  if (!rawCookie) rawCookie = res.headers.get("set-cookie");

  if (rawCookie) {
    cachedCookie = rawCookie.split(";")[0];
    lastLoginTime = Date.now();
    return cachedCookie;
  }
  throw new Error("Failed to extract session cookie from OLT");
}

async function fetchOltPage(path, method = "GET", body = null) {
  let cookie = await loginOlt();
  const headers = {
    Cookie: cookie,
    Referer: `${BASE_URL}/action/main.html`,
    "User-Agent": "Mozilla/5.0",
  };
  if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";

  let res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  if (res.status === 302 || res.status === 401) {
    cachedCookie = null;
    cookie = await loginOlt();
    headers.Cookie = cookie;
    res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  }
  return await res.text();
}

async function getOfflineOnus() {
  const html = await fetchOltPage("/action/onustatusinfo.html", "POST", "select=254&port_refresh=Refresh");
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const list = [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (cells.length >= 9 && cells[0].startsWith("EPON0/")) {
      if ((cells[1] || "").toLowerCase().includes("offline")) {
        list.push({ id: cells[0], name: cells[3] || "N/A", mac: cells[2] || "", dist: cells[4] || "0", reason: cells[8] || "N/A", deregTime: cells[7] || "N/A" });
      }
    }
  }
  const powerOff = list.filter((o) => o.reason.toLowerCase().includes("power"));
  const wireDown = list.filter((o) => o.reason.toLowerCase().includes("wire"));
  return { total: list.length, powerOff, wireDown, list };
}

async function getOpticalPower() {
  const html = await fetchOltPage("/action/onuopmdiag.html");
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const list = [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (cells.length >= 9 && cells[0].startsWith("EPON0/")) {
      const rx = parseFloat(cells[8]);
      list.push({ id: cells[0], name: cells[2] || "N/A", dist: cells[3] || "0", txPower: cells[7] || "N/A", rxPower: isNaN(rx) ? null : rx });
    }
  }
  return list;
}

async function telegramCall(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const b = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyMarkup) b.reply_markup = replyMarkup;
  return await telegramCall("sendMessage", b);
}

function getMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "🔴 অফলাইন ONU (ডাউন লাইন)", callback_data: "menu:offline" }, { text: "⚡ অপটিক্যাল সিগন্যাল", callback_data: "menu:optical" }],
      [{ text: `🔔 অ্যালার্ট ওয়াচলিস্ট (${trackedOnus.size})`, callback_data: "menu:watchlist" }, { text: "💾 OLT কনফিগ সেভ", callback_data: "menu:save" }],
      [{ text: "🔄 রিফ্রেশ মেনু", callback_data: "menu:main" }]
    ]
  };
}

async function pollTelegram() {
  try {
    const data = await telegramCall("getUpdates", { offset: lastTelegramUpdateId + 1, timeout: 10 });
    if (data.ok && data.result) {
      for (const u of data.result) {
        lastTelegramUpdateId = u.update_id;
        if (u.message) {
          const text = (u.message.text || "").trim();
          const chatId = u.message.chat.id;
          if (text === "/start" || text === "/menu") {
            await sendMessage(chatId, "📡 <b>VSOL V1600D8 OLT কন্ট্রোল</b>\n\nনিচের বাটন চেপে কাজ করুন:", getMainMenuKeyboard());
          }
        }
        if (u.callback_query) {
          const q = u.callback_query;
          const chatId = q.message.chat.id;
          await telegramCall("answerCallbackQuery", { callback_query_id: q.id });
          if (q.data === "menu:offline") {
            const off = await getOfflineOnus();
            let msg = `🚨 <b>মোট অফলাইন: ${off.total} টি</b>\n🔌 বিদ্যুৎ বন্ধ: ${off.powerOff.length} | ✂️ তার কাটা: ${off.wireDown.length}\n\n`;
            off.list.slice(0, 10).forEach((o, i) => {
              msg += `${i + 1}. <b>${o.id}</b> | <code>${o.name}</code> (${o.reason})\n`;
            });
            await sendMessage(chatId, msg, getMainMenuKeyboard());
          } else if (q.data === "menu:optical") {
            const opt = await getOpticalPower();
            const weak = opt.filter(o => o.rxPower !== null && o.rxPower < -25);
            let msg = `⚡ <b>দুর্বল সিগন্যাল লাইন: ${weak.length} টি</b>\n\n`;
            weak.slice(0, 10).forEach((o, i) => {
              msg += `${i + 1}. <b>${o.id}</b> | <code>${o.name}</code> (Rx: ${o.rxPower} dBm)\n`;
            });
            await sendMessage(chatId, msg, getMainMenuKeyboard());
          } else if (q.data === "menu:main") {
            await sendMessage(chatId, "📡 <b>VSOL V1600D8 মেইন মেনু</b>", getMainMenuKeyboard());
          }
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
  setTimeout(pollTelegram, 2000);
}

// Keep Render Port alive (Dummy Web Server)
http.createServer((req, res) => res.end("VSOL Telegram Bot 24/7 is Live!")).listen(process.env.PORT || 3000);

console.log("Bot started successfully 24/7!");
pollTelegram();
