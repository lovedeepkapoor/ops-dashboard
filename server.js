// ============================================================
// OPS APP — Main Server
// Serves dashboard + handles Twilio WhatsApp + Google Sheets
// ============================================================

const http        = require("http");
const https       = require("https");
const fs          = require("fs");
const path        = require("path");
const querystring = require("querystring");

// ── CONFIG (filled from environment variables on Railway) ───
const C = {
  PORT:             process.env.PORT || 3000,
  TWILIO_SID:       process.env.TWILIO_SID       || "",
  TWILIO_TOKEN:     process.env.TWILIO_TOKEN      || "",
  TWILIO_WA_FROM:   process.env.TWILIO_WA_FROM    || "whatsapp:+14155238886",
  OWNER_PHONE:      process.env.OWNER_PHONE        || "",
  SUPERVISOR_PHONE: process.env.SUPERVISOR_PHONE   || "",
  SHEETS_API_KEY:   process.env.SHEETS_API_KEY     || "",
  SHEET_ID:         process.env.SHEET_ID           || "",
};

// ── GOOGLE SHEETS HELPER ────────────────────────────────────
async function sheetsRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "sheets.googleapis.com",
      path,
      method,
      headers: {
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    };
    const req = https.request(options, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Append a row to a sheet tab
async function appendRow(tab, values) {
  if (!C.SHEET_ID || !C.SHEETS_API_KEY) return;
  const range = encodeURIComponent(`${tab}!A1`);
  await sheetsRequest(
    "POST",
    `/v4/spreadsheets/${C.SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&key=${C.SHEETS_API_KEY}`,
    { values: [values] }
  );
}

// Read all rows from a sheet tab
async function readRows(tab) {
  if (!C.SHEET_ID || !C.SHEETS_API_KEY) return [];
  const range = encodeURIComponent(`${tab}!A1:Z1000`);
  const res = await sheetsRequest(
    "GET",
    `/v4/spreadsheets/${C.SHEET_ID}/values/${range}?key=${C.SHEETS_API_KEY}`
  );
  return res.values || [];
}

// ── TWILIO HELPER ───────────────────────────────────────────
async function sendWA(to, body) {
  if (!C.TWILIO_SID || !C.TWILIO_TOKEN) {
    console.log(`[WA MOCK] To: ${to}\n${body}\n`);
    return;
  }
  const creds   = Buffer.from(`${C.TWILIO_SID}:${C.TWILIO_TOKEN}`).toString("base64");
  const payload = querystring.stringify({ From: C.TWILIO_WA_FROM, To: to, Body: body });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${C.TWILIO_SID}/Messages.json`,
      method: "POST",
      headers: {
        "Authorization": `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve(JSON.parse(d)));
    });
    req.on("error", reject);
    req.write(payload); req.end();
  });
}

// ── IN-MEMORY STORE (synced with Google Sheets) ─────────────
const store = {
  challans:    [],   // { id, client, addr, phone, contact, items, notes, status, date, by }
  jobs:        [],   // { id, challan, team, lead, phone, type, date, time, dur, pct, issue, issueNote, lastNote, status, by }
  deliveries:  [],   // { id, challan, person, phone, vehicle, addr, clientPhone, status, time }
  log:         [],   // { t, txt, type }
};

// phone → job/delivery mapping (auto-built from store)
function phoneToJob(phone) {
  const p = phone.replace(/\D/g, "");
  return store.jobs.find(j => j.phone.replace(/\D/g, "") === p);
}
function phoneToDelivery(phone) {
  const p = phone.replace(/\D/g, "");
  return store.deliveries.find(d => d.phone.replace(/\D/g, "") === p);
}

function tnow() {
  const d = new Date();
  return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
}

function addLog(txt, type = "info") {
  const entry = { t: tnow(), txt, type };
  store.log.unshift(entry);
  if (store.log.length > 100) store.log.pop();
  appendRow("Log", [new Date().toISOString(), txt, type]);
}

// ── KARIGAR MESSAGE PARSER ──────────────────────────────────
function parseKarigar(msg) {
  const lower = msg.toLowerCase();
  const result = { pct: null, issue: null, issueNote: null };
  const pctMatch = msg.match(/(\d+)\s*%/);
  if (pctMatch) result.pct = parseInt(pctMatch[1]);
  if (lower.includes("issue") || lower.includes("problem") || lower.includes("nahi") || lower.includes("rukk") || lower.includes("band")) {
    result.issue = "flagged";
    const m = msg.match(/(?:issue|problem)[:\s]+(.+)/i);
    result.issueNote = m ? m[1].trim() : msg.trim();
  } else if (lower.includes("no issue") || lower.includes("theek") || lower.includes("sab theek") || lower.includes("koi issue nahi")) {
    result.issue = "none";
  }
  return result;
}

// ── DELIVERY MESSAGE PARSER ─────────────────────────────────
function parseDelivery(msg) {
  const l = msg.toLowerCase();
  if (l.includes("load"))       return "loading";
  if (l.includes("dispatch") || l.includes("nikl")) return "dispatched";
  if (l.includes("reach") || l.includes("pahunch")) return "reached";
  if (l.includes("deliver") || l.includes("de diya") || l.includes("done")) return "delivered";
  return null;
}

// ── WEBHOOK HANDLER ─────────────────────────────────────────
async function handleWebhook(body) {
  const from    = (body.From || "").replace("whatsapp:", "");
  const msgBody = (body.Body || "").trim();
  const media   = body.MediaUrl0 || null;
  console.log(`[${tnow()}] From ${from}: "${msgBody}"`);

  // KARIGAR
  const job = phoneToJob(from);
  if (job) {
    const parsed = parseKarigar(msgBody);
    let reply = "";
    let ownerMsg = "";

    if (parsed.pct !== null) {
      job.pct = parsed.pct;
      if (parsed.pct >= 100) {
        job.status = "done";
        reply    = `✅ 100% recorded for ${job.challan}. Please send finalization photos now.`;
        ownerMsg = `🏁 *Job Complete!*\nJob: ${job.id} | Team: ${job.team}\nChallan: ${job.challan}\nWork is 100% done.`;
      } else {
        reply    = `✅ Progress updated to *${parsed.pct}%* for ${job.challan}.`;
        ownerMsg = `📊 *Progress Update*\nJob: ${job.id} | Team: ${job.team}\nChallan: ${job.challan}\nProgress: *${parsed.pct}%*`;
      }
    }

    if (parsed.issue === "flagged") {
      job.issue     = "flagged";
      job.issueNote = parsed.issueNote;
      reply    += reply ? "\n\n⚠️ Issue flagged. Supervisor notified." : "⚠️ Issue flagged. Supervisor notified.";
      ownerMsg += `\n\n⚠️ *Issue:* ${parsed.issueNote}`;
    } else if (parsed.issue === "none") {
      job.issue = "none";
      reply += reply ? "\n✅ No issues noted." : "✅ No issues recorded.";
    }

    if (media && job.pct >= 100) {
      ownerMsg += `\n\n📸 Finalization photo received: ${media}`;
    }

    if (!reply) reply = `Received for ${job.challan}. Current: ${job.pct}%. Reply with "% done" or "issue: description".`;

    await sendWA(`whatsapp:${from}`, reply);
    if (ownerMsg) {
      if (C.OWNER_PHONE)      await sendWA(C.OWNER_PHONE, ownerMsg);
      if (C.SUPERVISOR_PHONE) await sendWA(C.SUPERVISOR_PHONE, ownerMsg);
    }

    // Save to Google Sheets
    appendRow("Progress", [new Date().toISOString(), job.id, job.challan, job.team, job.pct, job.issue, job.issueNote, from]);
    addLog(`${job.id} → ${job.pct}%${job.issue === "flagged" ? " | Issue: " + job.issueNote : ""}`, "progress");
    return reply;
  }

  // DELIVERY
  const deliv = phoneToDelivery(from);
  if (deliv) {
    const status = parseDelivery(msgBody);
    if (status) {
      deliv.status = status;
      const labels = { loading: "Loading goods", dispatched: "Dispatched", reached: "Reached client", delivered: "Delivered & confirmed" };
      const label  = labels[status];
      const reply  = `✅ Status updated: *${label}*`;

      await sendWA(`whatsapp:${from}`, reply);
      const notif = `🚚 *Delivery Update*\nOrder: ${deliv.id} | Challan: ${deliv.challan}\nPerson: ${deliv.person}\nStatus: *${label}*`;
      if (C.OWNER_PHONE)      await sendWA(C.OWNER_PHONE, notif);
      if (C.SUPERVISOR_PHONE) await sendWA(C.SUPERVISOR_PHONE, notif);

      if (status === "dispatched" || status === "delivered") {
        const clientMsgs = {
          dispatched: `Dear Customer,\n\nYour order (${deliv.challan}) has been dispatched and is on the way.\nDelivery by: ${deliv.person}\n\n— Logistics Team`,
          delivered:  `Dear Customer,\n\nYour order (${deliv.challan}) has been delivered. Thank you!\n\n— Logistics Team`,
        };
        if (deliv.clientPhone) await sendWA(`whatsapp:${deliv.clientPhone}`, clientMsgs[status]);
      }

      appendRow("Delivery", [new Date().toISOString(), deliv.id, deliv.challan, deliv.person, status, from]);
      addLog(`${deliv.id} → ${label}`, "delivery");
      return reply;
    }
    return `Please reply: "loaded", "dispatched", "reached", or "delivered".`;
  }

  return "Hello! Contact your supervisor to register your number.";
}

// ── API HANDLERS ────────────────────────────────────────────
async function handleAPI(method, url, body, res) {
  const send = (data, code = 200) => {
    const json = JSON.stringify(data);
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(json);
  };

  // GET all data
  if (method === "GET" && url === "/api/data") {
    return send({ challans: store.challans, jobs: store.jobs, deliveries: store.deliveries, log: store.log });
  }

  // POST new challan
  if (method === "POST" && url === "/api/challan") {
    const ch = { ...body, status: "pending", createdAt: new Date().toISOString() };
    store.challans.unshift(ch);
    appendRow("Challans", [ch.id, ch.client, ch.addr, ch.phone, ch.contact, JSON.stringify(ch.items), ch.notes, ch.status, ch.date, ch.by]);
    addLog(`Challan ${ch.id} submitted by ${ch.by} for ${ch.client}`, "challan");
    return send({ ok: true, challan: ch });
  }

  // POST assign karigar
  if (method === "POST" && url === "/api/assign") {
    const job = { ...body, id: "JB-" + String(store.jobs.length + 1).padStart(3, "0"), pct: 0, issue: "none", issueNote: "", lastNote: "", status: "assigned", createdAt: new Date().toISOString() };
    store.jobs.unshift(job);
    const ch = store.challans.find(c => c.id === job.challan);
    if (ch) ch.status = "assigned";
    appendRow("Jobs", [job.id, job.challan, job.team, job.lead, job.phone, job.type, job.date, job.time, job.dur, job.status, job.by]);
    addLog(`${job.team} assigned to ${job.challan} (${job.type}) by ${job.by}`, "assign");

    // Send WhatsApp to karigar
    const ch2   = store.challans.find(c => c.id === job.challan);
    const items  = ch2 ? ch2.items.map(i => `• ${i.desc} — ${i.qty} ${i.unit}`).join("\n") : "";
    const msg    = `*New Job Assignment — ${job.type}*\n\nHello ${job.lead},\n\nChallan: *${job.challan}*\nClient: ${ch2 ? ch2.client : ""}\nLocation: ${ch2 ? ch2.addr : ""}\nContact: ${ch2 ? ch2.contact : ""} (${ch2 ? ch2.phone : ""})\nWork: ${job.type}\nDate: ${job.date} at ${job.time}\nDuration: ${job.dur}\n\nItems:\n${items}${job.notes ? "\n\nInstructions:\n" + job.notes : ""}\n\nReply with "% done" to update progress.\n— ${job.by}`;
    await sendWA(`whatsapp:${job.phone}`, msg);
    return send({ ok: true, job });
  }

  // POST update job progress
  if (method === "POST" && url === "/api/progress") {
    const { id, pct, issue, issueNote, lastNote } = body;
    const job = store.jobs.find(j => j.id === id);
    if (job) { job.pct = pct; job.issue = issue; job.issueNote = issueNote; job.lastNote = lastNote; if (pct >= 100) job.status = "done"; }
    appendRow("Progress", [new Date().toISOString(), id, pct, issue, issueNote, lastNote]);
    addLog(`${id} progress → ${pct}%${issue !== "none" ? " | " + issue : ""}`, "progress");
    return send({ ok: true });
  }

  // POST create delivery
  if (method === "POST" && url === "/api/delivery") {
    const d = { ...body, id: "DL-" + String(store.deliveries.length + 1).padStart(3, "0"), status: "pending", createdAt: new Date().toISOString() };
    store.deliveries.unshift(d);
    const ch = store.challans.find(c => c.id === d.challan);
    if (ch) ch.status = "dispatched";
    appendRow("Delivery", [d.id, d.challan, d.person, d.phone, d.vehicle, d.addr, d.status]);
    addLog(`Delivery ${d.id} created for ${d.challan}`, "delivery");

    // Notify delivery person
    const msg = `*Delivery Assignment*\n\nHello ${d.person},\n\nChallan: *${d.challan}*\nClient: ${ch ? ch.client : ""}\nAddress: ${d.addr}\nVehicle: ${d.vehicle}\n\nGoods:\n${ch ? ch.items.map(i => `• ${i.desc} — ${i.qty} ${i.unit}`).join("\n") : ""}\n\nReply: "loaded" → "dispatched" → "reached" → "delivered"\n— Logistics Team`;
    await sendWA(`whatsapp:${d.phone}`, msg);
    return send({ ok: true, delivery: d });
  }

  // POST update delivery status
  if (method === "POST" && url === "/api/delivery/status") {
    const { id, status, note } = body;
    const d = store.deliveries.find(x => x.id === id);
    if (d) d.status = status;
    addLog(`${id} → ${status}${note ? " — " + note : ""}`, "delivery");
    return send({ ok: true });
  }

  send({ error: "Not found" }, 404);
}

// ── HTTP SERVER ─────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  // Serve static files
  if (method === "GET" && (url === "/" || url === "/index.html")) {
    const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }

  // Twilio webhook
  if (method === "POST" && url === "/webhook") {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", async () => {
      const body = querystring.parse(raw);
      const reply = await handleWebhook(body);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
    });
    return;
  }

  // API
  if (url.startsWith("/api/")) {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      await handleAPI(method, url, body, res);
    });
    return;
  }

  // Health check
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", jobs: store.jobs.length, challans: store.challans.length }));
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(C.PORT, () => {
  console.log(`\n✅ Ops App running on port ${C.PORT}`);
  console.log(`   Dashboard: http://localhost:${C.PORT}`);
  console.log(`   Webhook:   http://localhost:${C.PORT}/webhook`);
  console.log(`   Health:    http://localhost:${C.PORT}/health\n`);
});
