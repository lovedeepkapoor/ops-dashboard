// ============================================================
// Twilio WhatsApp Webhook Server
// For: Karigar progress updates & delivery status
// Run: node server.js
// ============================================================

const http = require("http");
const https = require("https");
const querystring = require("querystring");

// ── CONFIG ─────────────────────────────────────────────────
const CONFIG = {
  PORT: 3000,
  TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", // your Twilio SID
  TWILIO_AUTH_TOKEN:  "your_auth_token_here",               // your Twilio Auth Token
  TWILIO_WA_NUMBER:   "whatsapp:+14155238886",              // your Twilio sandbox number
  OWNER_PHONE:        "whatsapp:+919876500000",             // owner's WhatsApp number
  SUPERVISOR_PHONE:   "whatsapp:+919876500001",             // supervisor's WhatsApp number
};

// ── IN-MEMORY JOB STORE (replace with DB later) ────────────
const jobs = {
  "JB-001": { challan: "CH-2026-006", team: "Team Beta",  lead: "Suresh Singh",  phone: "+919876500002", pct: 60,  issue: "none", status: "in-progress" },
  "JB-002": { challan: "CH-2026-007", team: "Team Alpha", lead: "Ravi Kumar",    phone: "+919876500001", pct: 30,  issue: "none", status: "in-progress" },
};

const deliveries = {
  "DL-001": { challan: "CH-2026-006", person: "Ramesh Driver", phone: "+919876511001", clientPhone: "+919876599001", status: "in-transit" },
};

// phone → job/delivery ID mapping (who is assigned what)
const phoneToJob = {
  "+919876500002": "JB-001",
  "+919876500001": "JB-002",
};
const phoneToDelivery = {
  "+919876511001": "DL-001",
};

// ── HELPERS ────────────────────────────────────────────────
function normalize(phone) {
  return phone.replace("whatsapp:", "").replace(/\s/g, "");
}

function sendWA(to, body) {
  const creds = Buffer.from(`${CONFIG.TWILIO_ACCOUNT_SID}:${CONFIG.TWILIO_AUTH_TOKEN}`).toString("base64");
  const payload = querystring.stringify({ From: CONFIG.TWILIO_WA_NUMBER, To: to, Body: body });
  const options = {
    hostname: "api.twilio.com",
    path: `/2010-04-01/Accounts/${CONFIG.TWILIO_ACCOUNT_SID}/Messages.json`,
    method: "POST",
    headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) },
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function timestamp() {
  return new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

// ── KARIGAR MESSAGE PARSER ─────────────────────────────────
// Karigar can send messages like:
//   "50% done"            → updates progress
//   "75% done, no issues" → updates progress, clears issue
//   "issue: no material"  → flags issue
//   "100% done"           → marks complete, asks for finalization photo
function parseKarigarMessage(msg) {
  const lower = msg.toLowerCase();
  const result = { pct: null, issue: null, issueNote: null };

  // extract percentage
  const pctMatch = msg.match(/(\d+)\s*%/);
  if (pctMatch) result.pct = parseInt(pctMatch[1]);

  // extract issue
  if (lower.includes("issue") || lower.includes("problem") || lower.includes("nahi") || lower.includes("rukk")) {
    result.issue = "flagged";
    const issueMatch = msg.match(/issue[:\s]+(.+)/i) || msg.match(/problem[:\s]+(.+)/i);
    result.issueNote = issueMatch ? issueMatch[1].trim() : msg;
  } else if (lower.includes("no issue") || lower.includes("koi issue nahi") || lower.includes("sab theek")) {
    result.issue = "none";
  }

  return result;
}

// ── DELIVERY MESSAGE PARSER ────────────────────────────────
// Delivery person sends:
//   "loaded"      → loading
//   "dispatched"  → dispatched
//   "reached"     → goods reached client
//   "delivered"   → confirmed delivery
function parseDeliveryMessage(msg) {
  const lower = msg.toLowerCase();
  if (lower.includes("loaded") || lower.includes("load"))       return "loading";
  if (lower.includes("dispatch") || lower.includes("nikla"))    return "dispatched";
  if (lower.includes("reached") || lower.includes("pahunch"))   return "reached";
  if (lower.includes("delivered") || lower.includes("de diya")) return "delivered";
  return null;
}

// ── WEBHOOK HANDLER ────────────────────────────────────────
async function handleWebhook(body) {
  const from    = normalize(body.From || "");
  const msgBody = (body.Body || "").trim();
  const mediaUrl = body.MediaUrl0 || null; // finalization photo

  console.log(`[${timestamp()}] Message from ${from}: "${msgBody}"`);

  // ── KARIGAR UPDATE ──────────────────────────────────────
  const jobId = phoneToJob[from];
  if (jobId && jobs[jobId]) {
    const job    = jobs[jobId];
    const parsed = parseKarigarMessage(msgBody);
    let reply    = "";
    let ownerNotif = "";

    // update percentage
    if (parsed.pct !== null) {
      job.pct = parsed.pct;
      if (parsed.pct === 100) {
        job.status = "done";
        reply = `✅ Great! ${parsed.pct}% recorded. Please send finalization photos now and confirm with client.`;
        ownerNotif = `🏁 *Job Complete!*\n\nJob: ${jobId}\nTeam: ${job.team}\nChallan: ${job.challan}\n\nWork is 100% done. Awaiting finalization photos.`;
      } else {
        reply = `✅ Got it! Progress updated to *${parsed.pct}%* for ${job.challan}.`;
        ownerNotif = `📊 *Progress Update*\n\nJob: ${jobId}\nTeam: ${job.team}\nChallan: ${job.challan}\nProgress: *${parsed.pct}%*`;
      }
    }

    // update issue
    if (parsed.issue === "flagged") {
      job.issue     = "flagged";
      job.issueNote = parsed.issueNote;
      reply += reply ? "\n\n⚠️ Issue flagged. Supervisor has been notified." : "⚠️ Issue flagged. Supervisor notified.";
      ownerNotif += `\n\n⚠️ *Issue:* ${parsed.issueNote}`;
    } else if (parsed.issue === "none") {
      job.issue = "none";
      reply += reply ? "\n\n✅ No issues noted." : "✅ No issues recorded.";
    }

    if (!reply) reply = `Received your update for ${job.challan}. Current progress: ${job.pct}%. Reply with "% done" or "issue: [description]".`;

    // send reply to karigar
    await sendWA(`whatsapp:${from}`, reply);

    // notify owner & supervisor
    if (ownerNotif) {
      await sendWA(CONFIG.OWNER_PHONE, ownerNotif);
      await sendWA(CONFIG.SUPERVISOR_PHONE, ownerNotif);
    }

    // finalization photo received
    if (mediaUrl && job.pct === 100) {
      const photoMsg = `📸 *Finalization Photo Received*\n\nJob: ${jobId}\nTeam: ${job.team}\nChallan: ${job.challan}\nPhoto: ${mediaUrl}`;
      await sendWA(CONFIG.OWNER_PHONE, photoMsg);
    }

    console.log(`[${timestamp()}] Job ${jobId} updated → ${job.pct}%${job.issue !== "none" ? " | Issue: " + job.issueNote : ""}`);
    return reply;
  }

  // ── DELIVERY UPDATE ─────────────────────────────────────
  const delivId = phoneToDelivery[from];
  if (delivId && deliveries[delivId]) {
    const deliv  = deliveries[delivId];
    const status = parseDeliveryMessage(msgBody);

    if (status) {
      deliv.status = status;
      const statusLabels = { loading: "Loading goods", dispatched: "Dispatched", reached: "Goods reached client", delivered: "Delivered & confirmed" };
      const label = statusLabels[status];

      // reply to delivery person
      const reply = `✅ Status updated: *${label}*`;
      await sendWA(`whatsapp:${from}`, reply);

      // notify supervisor & owner
      const notif = `🚚 *Delivery Update*\n\nOrder: ${delivId}\nChallan: ${deliv.challan}\nPerson: ${deliv.person}\nStatus: *${label}*`;
      await sendWA(CONFIG.OWNER_PHONE, notif);
      await sendWA(CONFIG.SUPERVISOR_PHONE, notif);

      // notify client when dispatched or delivered
      if (status === "dispatched" || status === "delivered") {
        const clientMsgs = {
          dispatched: `Dear Customer,\n\nYour order (${deliv.challan}) has been dispatched and is on the way.\n\nDelivery by: ${deliv.person}\n\n— Logistics Team`,
          delivered:  `Dear Customer,\n\nYour order (${deliv.challan}) has been delivered successfully. Thank you!\n\n— Logistics Team`,
        };
        await sendWA(`whatsapp:${deliv.clientPhone}`, clientMsgs[status]);
      }

      console.log(`[${timestamp()}] Delivery ${delivId} → ${status}`);
      return reply;
    }

    return "Please send your delivery status: 'loaded', 'dispatched', 'reached', or 'delivered'";
  }

  // ── UNKNOWN SENDER ───────────────────────────────────────
  console.log(`[${timestamp()}] Unknown sender: ${from}`);
  return "Hello! Please contact your supervisor to register your number in the system.";
}

// ── HTTP SERVER ────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    let rawBody = "";
    req.on("data", chunk => rawBody += chunk);
    req.on("end", async () => {
      try {
        const body = querystring.parse(rawBody);
        const reply = await handleWebhook(body);
        // Twilio expects TwiML response
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
      } catch (err) {
        console.error("Webhook error:", err);
        res.writeHead(500);
        res.end("Error");
      }
    });
  } else if (req.method === "GET" && req.url === "/status") {
    // health check + current job status
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobs, deliveries, timestamp: timestamp() }, null, 2));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(CONFIG.PORT, () => {
  console.log(`\n✅ Twilio webhook server running on port ${CONFIG.PORT}`);
  console.log(`   Webhook URL: http://YOUR_SERVER_IP:${CONFIG.PORT}/webhook`);
  console.log(`   Status page: http://YOUR_SERVER_IP:${CONFIG.PORT}/status`);
  console.log(`\n   Set this URL in Twilio Console → Messaging → Sandbox Settings`);
  console.log(`   "When a message comes in" → POST → http://YOUR_IP:${CONFIG.PORT}/webhook\n`);
});
