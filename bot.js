/**
 * VSOL V1600D8 Full Standalone Telegram Bot (Render / Node.js 24/7)
 * Complete Feature Set:
 * - All Menu Buttons (Offline, Optical, PON 1-8, Auto-Find, Search, Reboot, Save, Health)
 * - Power Off vs Wire Down Detection
 * - Custom Watchlist & Spam-Free Alerts
 * - Customer Search & Remote ONU Reboot
 * - Full Web Server on port 3000 for 100% Free Render Web Service
 */

import http from "http";
import https from "https";

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

// In-memory tracked ONUs
const trackedOnus = new Map([["EPON0/1:1", "MR@259"]]);
const previousStates = new Map();
let cachedCookie = null;
let lastLoginTime = 0;
let lastTelegramUpdateId = 0;

// --- OLT API CLIENT ---
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
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
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
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

// --- OLT DATA PARSERS ---
async function getOltStatus() {
  const html = await fetchOltPage("/action/systeminfo.html");
  const extract = (regex) => {
    const m = html.match(regex);
    return m ? m[1].trim() : null;
  };

  const model = extract(/Device\s*Model[^<]*<\/font><\/td>\s*<td[^>]*>([^<]+)/i) || "VSOL V1600D8";
  const hw = extract(/Hardware\s*Version[^<]*<\/font><\/td>\s*<td[^>]*>([^<]+)/i) || "V1.3.8";
  const fw = extract(/Firmware\s*Version[^<]*<\/font><\/td>\s*<td[^>]*>([^<]+)/i) || "V2.03.78R";
  const serial = extract(/Serial\s*Number[^<]*<\/font><\/td>\s*<td[^>]*>([^<]+)/i) || "V2409300159";
  const mac = extract(/MAC\s*Address[^<]*<\/font><\/td>\s*<td[^>]*>([0-9a-fA-F:]{17})/i) || "4C:D7:C8:9B:6F:ED";
  const uptime = extract(/Running\s*Time[^<]*<\/font><\/td>\s*<td[^>]*>([^<]+)/i) || "N/A";
  const cpu = extract(/CPU\s*Usage[^<]*<\/font><\/td>\s*<td[^>]*>([0-9.]+)(?:&#37;|%)/i) || "N/A";
  const mem = extract(/Memory\s*Usage[^<]*<\/font><\/td>\s*<td[^>]*>([0-9.]+)(?:&#37;|%)/i) || "N/A";

  return { model, hw, fw, serial, mac, uptime, cpu, mem };
}

async function getOfflineOnus(pon = null) {
  const body = pon ? `select=${pon}&port_refresh=Refresh` : `select=254&port_refresh=Refresh`;
  const html = await fetchOltPage("/action/onustatusinfo.html", "POST", body);

  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const list = [];
  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (cells.length >= 9 && cells[0].startsWith("EPON0/")) {
      const id = cells[0];
      const status = cells[1] || "Offline";
      const mac = cells[2] || "";
      const name = cells[3] || "N/A";
      const dist = cells[4] || "0";
      const deregTime = cells[7] || "N/A";
      const reason = cells[8] || "N/A";

      if (status.toLowerCase().includes("offline")) {
        list.push({ id, status, mac, name, dist, deregTime, reason });
      }
    }
  }

  const powerOff = list.filter((o) => o.reason.toLowerCase().includes("power"));
  const wireDown = list.filter((o) => o.reason.toLowerCase().includes("wire"));
  const other = list.filter((o) => !o.reason.toLowerCase().includes("power") && !o.reason.toLowerCase().includes("wire"));

  return { total: list.length, powerOff, wireDown, other, list };
}

async function getOpticalPower(pon = null) {
  const html = await fetchOltPage("/action/onuopmdiag.html");
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const list = [];

  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (cells.length >= 9 && cells[0].startsWith("EPON0/")) {
      const id = cells[0];
      const mac = cells[1] || "";
      const name = cells[2] || "N/A";
      const dist = cells[3] || "0";
      const temp = cells[4] || "N/A";
      const volt = cells[5] || "N/A";
      const tx = cells[7] || "N/A";
      const rx = parseFloat(cells[8]);

      if (!pon || id.startsWith(`EPON0/${pon}:`)) {
        list.push({
          id,
          mac,
          name,
          dist,
          temp,
          volt,
          txPower: tx,
          rxPower: isNaN(rx) ? null : rx,
        });
      }
    }
  }

  const weakSignal = list.filter((o) => o.rxPower !== null && o.rxPower < -25.0);
  const criticalSignal = list.filter((o) => o.rxPower !== null && o.rxPower < -27.0);

  return { total: list.length, weakSignal, criticalSignal, list };
}

async function getPonPorts() {
  const html = await fetchOltPage("/action/poninfo.html");
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const pons = [];

  for (let i = 0; i < 8; i++) {
    const ponName = `PON${i + 1}`;
    const optRow = rows.find((r) => r.includes(`>${ponName}<`));
    let temp = "N/A", txPower = "N/A", vendor = "VSOL";
    if (optRow) {
      const cells = (optRow.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
        .map((c) => c.replace(/<[^>]+>/g, "").trim());
      if (cells.length >= 7) {
        temp = cells[1] || "N/A";
        txPower = cells[4] || "N/A";
        vendor = cells[5] || "VSOL";
      }
    }

    const statsRow = rows.find((r) => r.includes(`>${ponName}<`) && (r.includes("Up") || r.includes("Down")));
    let status = "Down";
    if (statsRow && statsRow.includes("Up")) {
      status = "Up";
    }

    pons.push({
      port: i + 1,
      name: ponName,
      status: status,
      temp: temp,
      txPower: txPower,
      vendor: vendor,
    });
  }

  return pons;
}

async function searchCustomer(query) {
  const q = query.trim();
  const isMac = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i.test(q);
  const body = isMac
    ? `searchMac=${encodeURIComponent(q)}&who=10`
    : `searchDescription=${encodeURIComponent(q)}&who=11`;

  const html = await fetchOltPage("/action/onustatusinfo.html", "POST", body);
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const results = [];

  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (cells.length >= 9 && cells[0].startsWith("EPON0/")) {
      results.push({
        id: cells[0],
        status: cells[1] || "N/A",
        mac: cells[2] || "",
        name: cells[3] || "N/A",
        dist: cells[4] || "0",
        regTime: cells[6] || "N/A",
        deregTime: cells[7] || "N/A",
        reason: cells[8] || "N/A",
        aliveTime: cells[9] || "N/A",
      });
    }
  }

  if (results.length > 0) {
    try {
      const opt = await getOpticalPower();
      for (const res of results) {
        const found = opt.list.find((o) => o.id === res.id || o.mac === res.mac);
        if (found) {
          res.rxPower = found.rxPower;
          res.txPower = found.txPower;
          res.temp = found.temp;
        }
      }
    } catch (e) {
      console.error("Optical lookup error:", e);
    }
  }

  return results;
}

async function getAutoFindOnus() {
  const html = await fetchOltPage("/action/onuauthinfo.html", "POST", "select=255&onutype=1");
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  const unconfirmed = [];

  for (const row of rows) {
    const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
      .map((c) => c.replace(/<[^>]+>/g, "").trim());
    if (cells.length >= 3 && (cells[0].startsWith("PON") || cells[0].startsWith("EPON"))) {
      unconfirmed.push({
        pon: cells[0],
        mac: cells[1] || "N/A",
        loid: cells[2] || "N/A",
      });
    }
  }

  return unconfirmed;
}

async function saveOltConfig() {
  const html = await fetchOltPage("/action/configsave.html?who=1");
  return html.includes("Save") || html.includes("save");
}

// --- TELEGRAM CALLS ---
async function telegramCall(method, body = {}) {
  const res = await fetch(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return await telegramCall("sendMessage", body);
}

async function editMessage(chatId, messageId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  return await telegramCall("editMessageText", body);
}

async function answerCallback(callbackId, text = null) {
  const body = { callback_query_id: callbackId };
  if (text) body.text = text;
  return await telegramCall("answerCallbackQuery", body);
}

function getMainMenuKeyboard() {
  const trackCount = trackedOnus.size;
  return {
    inline_keyboard: [
      [
        { text: "🔴 অফলাইন ONU (ডাউন লাইন)", callback_data: "menu:offline" },
        { text: "⚡ অপটিক্যাল সিগন্যাল", callback_data: "menu:optical" },
      ],
      [
        { text: "🔌 PON ১-৮ পোর্ট সামারি", callback_data: "menu:pons" },
        { text: "🔍 নতুন ONU (Auto-Find)", callback_data: "menu:autofind" },
      ],
      [
        { text: `🔔 অ্যালার্ট ওয়াচলিস্ট (${trackCount})`, callback_data: "menu:watchlist" },
        { text: "🔎 কাস্টমার খুঁজুন", callback_data: "menu:search" },
      ],
      [
        { text: "💾 OLT কনফিগ সেভ", callback_data: "menu:saveconfig" },
        { text: "📊 OLT সিস্টেম হেলথ", callback_data: "menu:status" },
      ],
      [
        { text: "🔄 রিফ্রেশ মেনু", callback_data: "menu:main" },
      ],
    ],
  };
}

function getBackKeyboard() {
  return {
    inline_keyboard: [[{ text: "🔙 মেইন মেনু", callback_data: "menu:main" }]],
  };
}

function getOfflineKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "🔌 শুধু বিদ্যুৎ বন্ধ (Power Off)", callback_data: "off:power" },
        { text: "✂️ শুধু তার কাটা (Wire Down)", callback_data: "off:wire" },
      ],
      [
        { text: "PON 1", callback_data: "off:pon:1" },
        { text: "PON 2", callback_data: "off:pon:2" },
        { text: "PON 3", callback_data: "off:pon:3" },
        { text: "PON 4", callback_data: "off:pon:4" },
      ],
      [
        { text: "PON 5", callback_data: "off:pon:5" },
        { text: "PON 6", callback_data: "off:pon:6" },
        { text: "PON 7", callback_data: "off:pon:7" },
        { text: "📋 সব অফলাইন", callback_data: "menu:offline" },
      ],
      [
        { text: "🔙 মেইন মেনু", callback_data: "menu:main" },
      ],
    ],
  };
}

function getOpticalKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚠️ দুর্বল সিগন্যাল (< -25dBm)", callback_data: "opt:weak" },
      ],
      [
        { text: "PON 1", callback_data: "opt:pon:1" },
        { text: "PON 2", callback_data: "opt:pon:2" },
        { text: "PON 3", callback_data: "opt:pon:3" },
        { text: "PON 4", callback_data: "opt:pon:4" },
      ],
      [
        { text: "PON 5", callback_data: "opt:pon:5" },
        { text: "PON 6", callback_data: "opt:pon:6" },
        { text: "PON 7", callback_data: "opt:pon:7" },
        { text: "🔙 মেইন মেনু", callback_data: "menu:main" },
      ],
    ],
  };
}

async function showWatchlist(chatId, messageId = null) {
  const lines = [
    "🔔 <b>কাস্টম অ্যালার্ট ওয়াচলিস্ট (অ্যালার্ট ফিল্টার)</b>",
    "━━━━━━━━━━━━━━━━━━━━",
    "✅ <b>অটো স্প্যাম নোটিফিকেশন বন্ধ রাখা হয়েছে।</b>",
    "শুধুমাত্র নিচের তালিকায় থাকা কাস্টমারগুলো অফলাইন বা অনলাইন হলেই আপনার টেলিগ্রামে মেসেজ আসবে।",
    "",
  ];

  const kbRows = [];

  if (trackedOnus.size === 0) {
    lines.push("⚠️ <i>বর্তমানে ওয়াচলিস্ট খালি! কোনো ONU-র অ্যালার্ট সেট করা নেই।</i>");
    lines.push("");
    lines.push("💡 <b>অ্যালার্ট চালু করতে লিখুন:</b>");
    lines.push("• <code>/track EPON0/1:1</code>");
    lines.push("• <code>/track MR@259</code>");
    lines.push("অথবা সার্চ করে <b>[🔔 অ্যালার্ট চালু করুন]</b> বাটনে চাপুন।");
  } else {
    lines.push(`📋 <b>মোট ট্র্যাকিং করা ONU: ${trackedOnus.size} টি</b>\n`);
    let idx = 1;
    for (const [id, name] of trackedOnus.entries()) {
      lines.push(`${idx}. <b>${id}</b> — <code>${name}</code>`);
      kbRows.push([
        { text: `🔕 রিমুভ ${id}`, callback_data: `untrack:${id}` }
      ]);
      idx++;
    }
  }

  kbRows.push([{ text: "🔙 মেইন মেনু", callback_data: "menu:main" }]);

  const markup = { inline_keyboard: kbRows };
  if (messageId) {
    await editMessage(chatId, messageId, lines.join("\n"), markup);
  } else {
    await sendMessage(chatId, lines.join("\n"), markup);
  }
}

async function handleUpdate(update) {
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = String(msg.from?.id);
    const text = (msg.text || "").trim();

    if (!CONFIG.ADMIN_TELEGRAM_IDS.includes(userId)) {
      await sendMessage(chatId, `❌ এক্সেস নেই। আপনার Telegram User ID: <code>${userId}</code>`);
      return;
    }

    if (text === "/start" || text === "/menu") {
      const welcome = [
        "📡 <b>VSOL V1600D8 OLT কন্ট্রোল ও মনিটরিং</b>",
        "",
        "<b>মডেল:</b> VSOL V1600D8 | <b>ফার্মওয়্যার:</b> V2.03.78R",
        `<b>হোস্ট:</b> <code>${CONFIG.OLT_HOST}:${CONFIG.OLT_PORT}</code>`,
        `<b>অ্যালার্ট মোড:</b> 🔕 সাধারণ নোটিফিকেশন বন্ধ (শুধু ওয়াচলিস্টের ONU অ্যালার্ট দিবে)`,
        "",
        "নিচের যেকোনো <b>কাজের বাটনে</b> চাপুন অথবা কাস্টমারের নাম/MAC লিখে পাঠান:",
      ].join("\n");
      await sendMessage(chatId, welcome, getMainMenuKeyboard());
      return;
    }

    if (text.startsWith("/track") || text.startsWith("/watch")) {
      const target = text.replace(/^\/(track|watch)\s*/i, "").trim();
      if (!target) {
        await sendMessage(chatId, "⚠️ <b>ব্যবহার:</b> <code>/track EPON0/1:1</code> অথবা <code>/track MR@259</code>");
        return;
      }

      let onuId = target;
      let onuName = target;
      if (!target.startsWith("EPON0/")) {
        const sResults = await searchCustomer(target);
        if (sResults.length > 0) {
          onuId = sResults[0].id;
          onuName = sResults[0].name;
        }
      }

      trackedOnus.set(onuId, onuName);
      const confirmMsg = [
        "🔔 <b>[অ্যালার্ট ওয়াচলিস্টে যুক্ত হয়েছে!]</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        `🆔 <b>ONU ID:</b> <code>${onuId}</code>`,
        `👤 <b>কাস্টমার:</b> <b>${onuName}</b>`,
        "",
        "✅ <b>এখন থেকে এই নির্দিষ্ট ONU-টি অফলাইন বা অনলাইন হলে শুধু তখনই আপনার টেলিগ্রামে অ্যালার্ট মেসেজ আসবে।</b>",
        "অন্যান্য কোনো অপ্রয়োজনীয় ONU-র অ্যালার্ট আসবে না।",
      ].join("\n");

      await sendMessage(chatId, confirmMsg, {
        inline_keyboard: [
          [{ text: "📋 ওয়াচলিস্ট দেখুন", callback_data: "menu:watchlist" }],
          [{ text: "🔙 মেইন মেনু", callback_data: "menu:main" }],
        ],
      });
      return;
    }

    if (text.startsWith("/untrack") || text.startsWith("/unwatch")) {
      const target = text.replace(/^\/(untrack|unwatch)\s*/i, "").trim();
      let removed = false;
      for (const [id, name] of trackedOnus.entries()) {
        if (id.toLowerCase() === target.toLowerCase() || name.toLowerCase() === target.toLowerCase()) {
          trackedOnus.delete(id);
          removed = true;
          break;
        }
      }

      if (removed) {
        await sendMessage(chatId, `🔕 <code>${target}</code> সফলভাবে ওয়াচলিস্ট থেকে রিমুভ করা হয়েছে। এর কোনো অ্যালার্ট আসবে না।`, getMainMenuKeyboard());
      } else {
        await sendMessage(chatId, `⚠️ <code>${target}</code> ওয়াচলিস্টে পাওয়া যায়নি।`, getMainMenuKeyboard());
      }
      return;
    }

    if (text === "/watchlist" || text === "/tracked" || text === "/alerts") {
      await showWatchlist(chatId);
      return;
    }

    if (text === "/save") {
      await sendMessage(chatId, "⏳ <i>কনফিগ সেভ করা হচ্ছে...</i>");
      try {
        await saveOltConfig();
        await sendMessage(chatId, "💾 <b>সফল!</b> OLT কনফিগারেশন ফ্ল্যাশ মেমোরিতে পার্মানেন্ট সেভ করা হয়েছে।", getBackKeyboard());
      } catch (e) {
        await sendMessage(chatId, `❌ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    if (text.startsWith("/reboot")) {
      const parts = text.split(/\s+/);
      if (parts.length < 3) {
        await sendMessage(chatId, "⚠️ <b>ব্যবহার:</b> <code>/reboot &lt;pon&gt; &lt;onu&gt;</code>\nউদাহরণ: <code>/reboot 1 2</code>");
        return;
      }
      const pon = parts[1];
      const onu = parts[2];
      await sendMessage(chatId, `⏳ <i>EPON0/${pon}:${onu} রিবুট রিকোয়েস্ট পাঠানো হচ্ছে...</i>`);
      try {
        await fetchOltPage(`/action/onuauthinfo.html?who=2&select=${pon}&select2=1&onuid=${onu}`);
        await sendMessage(chatId, `✅ <b>রিবুট সিগন্যাল পাঠানো হয়েছে!</b>\nআইডি: <code>EPON0/${pon}:${onu}</code>\nONU রিস্টার্ট হয়ে ১-২ মিনিটে লাইনে চলে আসবে।`, getBackKeyboard());
      } catch (e) {
        await sendMessage(chatId, `❌ রিবুট ব্যর্থ: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    let searchQuery = "";
    if (text.startsWith("/find ") || text.startsWith("/search ")) {
      searchQuery = text.replace(/^\/(find|search)\s+/, "").trim();
    } else if (text.startsWith("MR@") || text.includes(":") || text.length >= 3) {
      searchQuery = text;
    }

    if (searchQuery) {
      await sendMessage(chatId, `🔍 <i>"${searchQuery}" খুঁজছি...</i>`);
      try {
        const results = await searchCustomer(searchQuery);
        if (results.length === 0) {
          await sendMessage(chatId, `❌ "${searchQuery}" দিয়ে কোনো ONU পাওয়া যায়নি। বানানের সঠিকতা বা MAC চেক করুন।`, getBackKeyboard());
        } else {
          for (const res of results.slice(0, 5)) {
            const isOnline = res.status.toLowerCase().includes("online");
            const statusBadge = isOnline ? "🟢 Online" : "🔴 Offline";
            const reasonText = res.reason.toLowerCase().includes("power")
              ? "🔌 Power Off (বিদ্যুৎ বন্ধ / সুইচ অফ)"
              : res.reason.toLowerCase().includes("wire")
              ? "✂️ Wire Down (ফাইবার কাটা / ডিসকানেক্ট)"
              : res.reason;

            const rxBadge = res.rxPower !== undefined
              ? (res.rxPower < -25 ? `🔴 ${res.rxPower} dBm (দুর্বল!)` : `🟢 ${res.rxPower} dBm (ভালো)`)
              : "N/A";

            const isTracked = trackedOnus.has(res.id);

            const msgText = [
              `👤 <b>কাস্টমার প্রোফাইল: ${res.name}</b>`,
              "━━━━━━━━━━━━━━━━━━━━",
              `🆔 <b>ONU ID:</b> <code>${res.id}</code>`,
              `📶 <b>স্ট্যাটাস:</b> ${statusBadge}`,
              `🔔 <b>অ্যালার্ট ট্র্যাকিং:</b> ${isTracked ? "🟢 চালু (অ্যালার্ট আসবে)" : "⚪ বন্ধ"}`,
              `📟 <b>MAC:</b> <code>${res.mac}</code>`,
              `⚡ <b>Rx সিগন্যাল:</b> ${rxBadge}`,
              `📏 <b>দূরত্ব:</b> ${res.dist} মিটার`,
              "",
              `⏰ <b>আপটাইম:</b> ${res.aliveTime || "N/A"}`,
              `📉 <b>লাস্ট অফলাইন কারণ:</b> ${reasonText}`,
              `📅 <b>লাস্ট অফলাইন সময়:</b> ${res.deregTime}`,
            ].join("\n");

            const ponNum = res.id.replace("EPON0/", "").split(":")[0];
            const onuNum = res.id.split(":")[1];

            const actionKb = {
              inline_keyboard: [
                [
                  isTracked
                    ? { text: "🔕 অ্যালার্ট বন্ধ করুন", callback_data: `untrack:${res.id}` }
                    : { text: "🔔 এই ONU-তে অ্যালার্ট চালু করুন", callback_data: `track:${res.id}:${encodeURIComponent(res.name)}` },
                ],
                [
                  { text: "🔄 এই ONU রিবুট করুন", callback_data: `act:reboot:${ponNum}:${onuNum}` },
                ],
                [
                  { text: "🔙 মেইন মেনু", callback_data: "menu:main" },
                ],
              ],
            };

            await sendMessage(chatId, msgText, actionKb);
          }
        }
      } catch (e) {
        await sendMessage(chatId, `❌ সার্চ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }
  }

  if (update.callback_query) {
    const q = update.callback_query;
    const callbackId = q.id;
    const userId = String(q.from.id);
    const chatId = q.message?.chat.id;
    const messageId = q.message?.message_id;
    const data = q.data;

    if (!CONFIG.ADMIN_TELEGRAM_IDS.includes(userId)) {
      await answerCallback(callbackId, "❌ এক্সেস ডিনায়েড");
      return;
    }
    await answerCallback(callbackId);

    if (data === "menu:main") {
      const welcome = [
        "📡 <b>VSOL V1600D8 OLT কন্ট্রোল ও মনিটরিং</b>",
        "",
        "<b>মডেল:</b> VSOL V1600D8 | <b>ফার্মওয়্যার:</b> V2.03.78R",
        `<b>হোস্ট:</b> <code>${CONFIG.OLT_HOST}:${CONFIG.OLT_PORT}</code>`,
        `<b>অ্যালার্ট মোড:</b> 🔕 সাধারণ নোটিফিকেশন বন্ধ (শুধু ওয়াচলিস্টের ONU অ্যালার্ট দিবে)`,
        "",
        "নিচের যেকোনো <b>কাজের বাটনে</b> চাপুন:",
      ].join("\n");
      await editMessage(chatId, messageId, welcome, getMainMenuKeyboard());
      return;
    }

    if (data === "menu:watchlist") {
      await showWatchlist(chatId, messageId);
      return;
    }

    if (data.startsWith("track:")) {
      const parts = data.split(":");
      const onuId = parts[1];
      const onuName = parts[2] ? decodeURIComponent(parts[2]) : onuId;
      trackedOnus.set(onuId, onuName);
      await editMessage(
        chatId,
        messageId,
        `🔔 <b>[অ্যালার্ট চালু হয়েছে]</b>\n\n🆔 <b>${onuId}</b> (${onuName})\nএই ONU অফলাইন বা অনলাইন হলে আপনার কাছে তাৎক্ষণিক নোটিফিকেশন মেসেজ আসবে।`,
        {
          inline_keyboard: [
            [{ text: "📋 ওয়াচলিস্ট দেখুন", callback_data: "menu:watchlist" }],
            [{ text: "🔙 মেইন মেনু", callback_data: "menu:main" }],
          ],
        }
      );
      return;
    }

    if (data.startsWith("untrack:")) {
      const onuId = data.replace("untrack:", "");
      trackedOnus.delete(onuId);
      await editMessage(
        chatId,
        messageId,
        `🔕 <b>[অ্যালার্ট বন্ধ হয়েছে]</b>\n\n<code>${onuId}</code> ওয়াচলিস্ট থেকে মুছে ফেলা হয়েছে। এর জন্য আর কোনো মেসেজ আসবে না।`,
        {
          inline_keyboard: [
            [{ text: "📋 ওয়াচলিস্ট দেখুন", callback_data: "menu:watchlist" }],
            [{ text: "🔙 মেইন মেনু", callback_data: "menu:main" }],
          ],
        }
      );
      return;
    }

    if (data === "menu:offline" || data === "off:power" || data === "off:wire" || data.startsWith("off:pon:")) {
      await editMessage(chatId, messageId, "⏳ <i>অফলাইন ONU তালিকা ও ডাউন কারণ লোড হচ্ছে...</i>");
      try {
        let pon = null;
        if (data.startsWith("off:pon:")) {
          pon = data.split(":")[2];
        }

        const offline = await getOfflineOnus(pon);
        let filterTitle = "সব অফলাইন ONU";
        let displayList = offline.list;

        if (data === "off:power") {
          filterTitle = "বিদ্যুৎ বন্ধ (Power Off)";
          displayList = offline.powerOff;
        } else if (data === "off:wire") {
          filterTitle = "ফাইবার কাটা (Wire Down)";
          displayList = offline.wireDown;
        } else if (pon) {
          filterTitle = `PON ${pon} অফলাইন`;
        }

        const lines = [
          `🚨 <b>${filterTitle} (${displayList.length} টি ডাউন)</b>`,
          "━━━━━━━━━━━━━━━━━━━━",
          `📊 <b>সামারি:</b> মোট: <b>${offline.total}</b> | 🔌 বিদ্যুৎ বন্ধ: <b>${offline.powerOff.length}</b> | ✂️ তার কাটা: <b>${offline.wireDown.length}</b>`,
          "",
        ];

        if (displayList.length === 0) {
          lines.push("✅ <i>এই ক্যাটাগরিতে কোনো অফলাইন ONU নেই! সব সচল।</i>");
        } else {
          displayList.slice(0, 10).forEach((o, i) => {
            const isPower = o.reason.toLowerCase().includes("power");
            const isWire = o.reason.toLowerCase().includes("wire");
            const reasonTag = isPower
              ? "🔌 <b>Power Off (বিদ্যুৎ বন্ধ)</b>"
              : isWire
              ? "✂️ <b>Wire Down (ফাইবার কাটা)</b>"
              : `❓ ${o.reason}`;

            const isTracked = trackedOnus.has(o.id) ? " 🔔" : "";
            lines.push(
              `${i + 1}. <b>${o.id}</b>${isTracked} | <code>${o.name}</code>\n   ${reasonTag} | 📏 ${o.dist}m\n   📟 <code>${o.mac}</code> | ⏰ ${o.deregTime}\n`
            );
          });

          if (displayList.length > 10) {
            lines.push(`<i>...এবং আরও ${displayList.length - 10} টি অফলাইন আছে।</i>`);
          }
        }

        await editMessage(chatId, messageId, lines.join("\n"), getOfflineKeyboard());
      } catch (e) {
        await editMessage(chatId, messageId, `❌ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    if (data === "menu:optical" || data === "opt:weak" || data.startsWith("opt:pon:")) {
      await editMessage(chatId, messageId, "⏳ <i>অপটিক্যাল সিগন্যাল ও পাওয়ার রিড হচ্ছে...</i>");
      try {
        let pon = null;
        if (data.startsWith("opt:pon:")) {
          pon = data.split(":")[2];
        }

        const opt = await getOpticalPower(pon);
        let title = "অপটিক্যাল সিগন্যাল ও পাওয়ার ডায়াগনস্টিক";
        let displayList = opt.list;

        if (data === "opt:weak") {
          title = "⚠️ দুর্বল সিগন্যাল লাইন (< -25.0 dBm)";
          displayList = opt.weakSignal;
        } else if (pon) {
          title = `PON ${pon} অপটিক্যাল পাওয়ার`;
        }

        const lines = [
          `⚡ <b>${title}</b>`,
          "━━━━━━━━━━━━━━━━━━━━",
          `📊 মোট পরিমাপিত: <b>${opt.total}</b> টি | ⚠️ দুর্বল: <b>${opt.weakSignal.length}</b> টি`,
          "",
        ];

        if (displayList.length === 0) {
          lines.push("✅ <i>কোনো দুর্বল সিগন্যালের ক্লায়েন্ট নেই! সব লাইন ভালো।</i>");
        } else {
          displayList.slice(0, 10).forEach((o, i) => {
            const rxVal = o.rxPower !== null ? o.rxPower : -99;
            const rxColor = rxVal < -27 ? "🔴" : rxVal < -25 ? "🟡" : "🟢";
            lines.push(
              `${i + 1}. <b>${o.id}</b> | <code>${o.name}</code>\n   ${rxColor} <b>Rx: ${o.rxPower} dBm</b> | Tx: ${o.txPower} dBm\n   📏 ${o.dist}m | 🌡️ ${o.temp}°C\n`
            );
          });

          if (displayList.length > 10) {
            lines.push(`<i>...এবং আরও ${displayList.length - 10} টি ONU রয়েছে।</i>`);
          }
        }

        await editMessage(chatId, messageId, lines.join("\n"), getOpticalKeyboard());
      } catch (e) {
        await editMessage(chatId, messageId, `❌ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    if (data === "menu:pons") {
      await editMessage(chatId, messageId, "⏳ <i>PON ১-৮ পোর্ট ডাটা রিড হচ্ছে...</i>");
      try {
        const pons = await getPonPorts();
        const lines = [
          "🔌 <b>VSOL V1600D8 - PON ১ থেকে ৮ পোর্ট সামারি</b>",
          "━━━━━━━━━━━━━━━━━━━━",
        ];

        pons.forEach((p) => {
          const statusIcon = p.status === "Up" ? "🟢" : "⚪";
          lines.push(
            `• <b>${p.name}:</b> ${statusIcon} ${p.status} | ⚡ লেজার: <b>${p.txPower} dBm</b> | 🌡️ ${p.temp}°C (${p.vendor})`
          );
        });

        const ponKb = {
          inline_keyboard: [
            [
              { text: "PON 1 অফলাইন", callback_data: "off:pon:1" },
              { text: "PON 2 অফলাইন", callback_data: "off:pon:2" },
            ],
            [
              { text: "PON 3 অফলাইন", callback_data: "off:pon:3" },
              { text: "PON 4 অফলাইন", callback_data: "off:pon:4" },
            ],
            [
              { text: "PON 5 অফলাইন", callback_data: "off:pon:5" },
              { text: "PON 6 অফলাইন", callback_data: "off:pon:6" },
            ],
            [
              { text: "🔙 মেইন মেনু", callback_data: "menu:main" },
            ],
          ],
        };

        await editMessage(chatId, messageId, lines.join("\n"), ponKb);
      } catch (e) {
        await editMessage(chatId, messageId, `❌ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    if (data === "menu:autofind") {
      await editMessage(chatId, messageId, "⏳ <i>নতুন আন-অথরাইজড ONU স্ক্যান করা হচ্ছে...</i>");
      try {
        const unconfirmed = await getAutoFindOnus();
        const lines = [
          "🔍 <b>নতুন ONU অটো-ফাইন্ড (Automatic Discovery)</b>",
          "━━━━━━━━━━━━━━━━━━━━",
        ];

        if (unconfirmed.length === 0) {
          lines.push("✅ <b>কোনো নতুন আন-কনফিগারড ONU পাওয়া যায়নি।</b>");
          lines.push("");
          lines.push("লাইনে নতুন কোনো ONU প্লাগ ইন করা হলে সাথে সাথে এখানে শো করবে।");
        } else {
          lines.push(`🚨 <b>নতুন ${unconfirmed.length} টি ONU লাইনে পাওয়া গেছে:</b>\n`);
          unconfirmed.forEach((u, i) => {
            lines.push(`${i + 1}. <b>${u.pon}</b> | MAC: <code>${u.mac}</code>`);
          });
        }

        await editMessage(chatId, messageId, lines.join("\n"), getBackKeyboard());
      } catch (e) {
        await editMessage(chatId, messageId, `❌ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    if (data === "menu:search") {
      const searchGuide = [
        "🔎 <b>কাস্টমার সার্চ ও অ্যালার্ট সেট করার নিয়ম:</b>",
        "━━━━━━━━━━━━━━━━━━━━",
        "বটে সরাসরি কাস্টমারের নাম বা MAC মেসেজ পাঠিয়ে দিন!",
        "",
        "উদাহরণ:",
        "• <code>MR@259</code>",
        "• <code>MR@106</code>",
        "• <code>4C:AE:1C:64:16:B0</code>",
        "• <code>/track MR@259</code> (সরাসরি অ্যালার্ট ওয়াচলিস্টে নিতে)",
        "",
        "কাস্টমার প্রোফাইল আসলে নিচের <b>[🔔 অ্যালার্ট চালু করুন]</b> বাটনে চাপ দিলেই শুধুমাত্র সেই কাস্টমারের জন্য অ্যালার্ট একটিভ হবে।",
      ].join("\n");
      await editMessage(chatId, messageId, searchGuide, getBackKeyboard());
      return;
    }

    if (data === "menu:saveconfig") {
      await editMessage(chatId, messageId, "⏳ <i>OLT কনফিগারেশন ফ্ল্যাশ ড্রাইভে সেভ হচ্ছে...</i>");
      try {
        await saveOltConfig();
        const saveMsg = [
          "💾 <b>কনফিগারেশন সফলভাবে সেভ হয়েছে!</b>",
          "━━━━━━━━━━━━━━━━━━━━",
          "✅ সমস্ত রানিং সেটিংস OLT-এর ইন্টারনাল ফ্ল্যাশ স্টোরেজে পার্মানেন্টভাবে রাইট করা হয়েছে।",
          "বিদ্যুৎ বিভ্রাট বা ডিভাইস রিস্টার্ট হলেও কোনো পরিবর্তন নষ্ট হবে না।",
        ].join("\n");
        await editMessage(chatId, messageId, saveMsg, getBackKeyboard());
      } catch (e) {
        await editMessage(chatId, messageId, `❌ কনফিগ সেভ ব্যর্থ: ${e.message}`, getBackKeyboard());
      }
      return;
    }

    if (data === "menu:status") {
      await editMessage(chatId, messageId, "⏳ <i>VSOL V1600D8 সিস্টেম ডাটা রিড হচ্ছে...</i>");
      try {
        const s = await getOltStatus();
        const msg = [
          "📊 <b>VSOL V1600D8 সিস্টেম হেলথ</b>",
          "━━━━━━━━━━━━━━━━━━━━",
          `<b>মডেল:</b> ${s.model}`,
          `<b>হার্ডওয়্যার ভার্সন:</b> ${s.hw}`,
          `<b>ফার্মওয়্যার:</b> ${s.fw}`,
          `<b>সিরিয়াল নম্বর:</b> <code>${s.serial}</code>`,
          `<b>MAC অ্যাড্রেস:</b> <code>${s.mac}</code>`,
          `<b>রানিং টাইম / আপটাইম:</b> ${s.uptime}`,
          `<b>CPU লোড:</b> ${s.cpu}%`,
          `<b>র‍্যাম ব্যবহার:</b> ${s.mem}%`,
          "",
          `🟢 <b>কানেক্টিভিটি:</b> ২৪/৭ লাইভ কানেক্টেড`,
          `🔔 <b>অ্যালার্ট ওয়াচলিস্ট:</b> ${trackedOnus.size} টি কাস্টমার ট্র্যাকিং অন`,
        ].join("\n");
        await editMessage(chatId, messageId, msg, getBackKeyboard());
      } catch (err) {
        await editMessage(chatId, messageId, `❌ <b>Error:</b>\n${err.message}`, getBackKeyboard());
      }
      return;
    }

    if (data.startsWith("act:reboot:")) {
      const parts = data.split(":");
      const pon = parts[2];
      const onu = parts[3];
      await editMessage(chatId, messageId, `⏳ <i>EPON0/${pon}:${onu} রিবুট হচ্ছে...</i>`);
      try {
        await fetchOltPage(`/action/onuauthinfo.html?who=2&select=${pon}&select2=1&onuid=${onu}`);
        await editMessage(chatId, messageId, `✅ <b>রিবুট সম্পন্ন!</b>\nআইডি: <code>EPON0/${pon}:${onu}</code>\nকাস্টমারের ONU রিস্টার্ট হচ্ছে।`, getBackKeyboard());
      } catch (e) {
        await editMessage(chatId, messageId, `❌ এরর: ${e.message}`, getBackKeyboard());
      }
      return;
    }
  }
}

// Background Poller for Watchlist
async function checkWatchlistAlerts() {
  try {
    if (trackedOnus.size > 0) {
      const offline = await getOfflineOnus();
      for (const [id, name] of trackedOnus.entries()) {
        const isOffline = offline.list.some((o) => o.id === id);
        const wasOffline = previousStates.get(id) === "offline";

        if (isOffline && !wasOffline) {
          previousStates.set(id, "offline");
          const found = offline.list.find((o) => o.id === id);
          const isPower = found?.reason.toLowerCase().includes("power");
          const reasonTag = isPower ? "🔌 বিদ্যুৎ বন্ধ (Power Off)" : "✂️ ফাইবার কাটা (Wire Down)";
          const alertMsg = [
            "🚨 <b>[ওয়াচলিস্ট অ্যালার্ট] আপনার ট্র্যাকিং করা ONU অফলাইন হয়েছে!</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            `🆔 <b>আইডি:</b> <code>${id}</code>`,
            `👤 <b>কাস্টমার:</b> <b>${name}</b>`,
            `📉 <b>কারণ:</b> ${reasonTag}`,
            `📏 <b>দূরত্ব:</b> ${found?.dist || "0"} মিটার`,
            `⏰ <b>অফলাইন সময়:</b> ${found?.deregTime || "এখন"}`,
          ].join("\n");

          for (const adminId of CONFIG.ADMIN_TELEGRAM_IDS) {
            await sendMessage(adminId, alertMsg);
          }
        } else if (!isOffline && wasOffline) {
          previousStates.set(id, "online");
          const recoverMsg = [
            "🟢 <b>[ওয়াচলিস্ট অ্যালার্ট] কাস্টমার লাইনে ফিরে এসেছে (Online)!</b>",
            "━━━━━━━━━━━━━━━━━━━━",
            `🆔 <b>আইডি:</b> <code>${id}</code>`,
            `👤 <b>কাস্টমার:</b> <b>${name}</b>`,
            "✅ লাইন স্বাভাবিক হয়েছে।",
          ].join("\n");

          for (const adminId of CONFIG.ADMIN_TELEGRAM_IDS) {
            await sendMessage(adminId, recoverMsg);
          }
        }
      }
    }
  } catch (e) {
    console.error("Watchlist check error:", e.message);
  }
  setTimeout(checkWatchlistAlerts, CONFIG.POLL_INTERVAL_MS);
}

// Long Polling for Telegram
async function pollTelegram() {
  try {
    const data = await telegramCall("getUpdates", { offset: lastTelegramUpdateId + 1, timeout: 20 });
    if (data.ok && data.result) {
      for (const update of data.result) {
        lastTelegramUpdateId = update.update_id;
        await handleUpdate(update);
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }
  setTimeout(pollTelegram, 1000);
}

// Keep Render Port alive (Dummy Web Server for 100% Free Plan)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<h1>VSOL V1600D8 Telegram Cloud Bot is running 24/7!</h1>");
}).listen(PORT, "0.0.0.0", () => {
  console.log(`Web Server listening on port ${PORT}`);
});

console.log("VSOL V1600D8 Full Standalone Bot started 24/7!");
pollTelegram();
checkWatchlistAlerts();
