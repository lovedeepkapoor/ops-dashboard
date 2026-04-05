// ============================================================
// OPS APP v4 â Server
// PIN login + Staff + Karigar WhatsApp + Photos + AI AGENTS
// ============================================================
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const querystring = require("querystring");

const C = {
  PORT: process.env.PORT || 3000,
  SID: process.env.TWILIO_SID || "",
  TOKEN: process.env.TWILIO_TOKEN || "",
  FROM: process.env.TWILIO_FROM || "whatsapp:+14155238886",
  OWNER: process.env.OWNER_PHONE || "",
  NOTIFY: (process.env.NOTIFY_PHONES || "").split(",").filter(Boolean),
  OPENAI_KEY: process.env.OPENAI_API_KEY || "",
};

// ââ OPENAI HELPER ââââââââââââââââââââââââââââââââââââââââââââ
function openaiRequest(urlPath, method, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com",
      path: urlPath,
      method,
      headers: {
        Authorization: `Bearer ${C.OPENAI_KEY}`,
        "Content-Type": contentType,
        "Content-Length": body.length,
      },
    }, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function gpt(systemPrompt, userMsg, model = "gpt-4o-mini", maxTokens = 800) {
  const raw = await openaiRequest(
    "/v1/chat/completions", "POST",
    Buffer.from(JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMsg }
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
    })),
    "application/json"
  );
  const data = JSON.parse(raw);
  return data.choices?.[0]?.message?.content || "";
}

// ââ MULTIPART PARSER âââââââââââââââââââââââââââââââââââââââââ
function idxOf(buf, search, start = 0) { for (let i = start; i <= buf.length - search.length; i++) { let ok = true; for (let j = 0; j < search.length; j++) { if (buf[i + j] !== search[j]) { ok = false; break; } } if (ok) return i; } return -1; }
function splitMultipart(body, boundary) {
  const parts = [], delim = Buffer.from("--" + boundary), endM = Buffer.from("--" + boundary + "--");
  let pos = 0;
  while (pos < body.length) {
    const start = idxOf(body, delim, pos); if (start === -1) break;
    pos = start + delim.length + 2;
    if (body.slice(start, start + endM.length).equals(endM)) break;
    const hdrEnd = idxOf(body, Buffer.from("\r\n\r\n"), pos); if (hdrEnd === -1) break;
    const hdr = body.slice(pos, hdrEnd).toString();
    const next = idxOf(body, delim, hdrEnd + 4);
    const data = body.slice(hdrEnd + 4, next === -1 ? body.length : next - 2);
    const nm = hdr.match(/name="([^"]+)"/), fm = hdr.match(/filename="([^"]+)"/);
    parts.push({ name: nm ? nm[1] : "", filename: fm ? fm[1] : "", data });
    pos = next === -1 ? body.length : next;
  }
  return parts;
}

// ââ STORE âââââââââââââââââââââââââââââââââââââââââââââââââââââ
const store = {
  staff: [{ id: 1, name: "Owner", pin: process.env.OWNER_PIN || "0000", role: "owner", addedAt: new Date().toISOString() }],
  sites: [],
  karigars: [],
  log: [],
  // Agent memory
  agentTasks: [],
  products: [],    // product catalog for inquiry agent
  leads: [],       // leads for follow-up agent
  quotes: [],      // generated quotes
};
let siteId = 1, karId = 1, staffId = 2, taskId = 1, productId = 1, leadId = 1, quoteId = 1;

// ââ HELPERS âââââââââââââââââââââââââââââââââââââââââââââââââââ
const tnow = () => { const d = new Date(); return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0"); };
const norm = p => (p || "").replace(/\D/g, "");
const json = (res, data, code = 200) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(data)); };
function addLog(txt, type = "info") { store.log.unshift({ t: tnow(), txt, type }); if (store.log.length > 300) store.log.pop(); }

// ââ TWILIO ââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function sendWA(to, body) {
  const toNum = to.startsWith("whatsapp:") ? to : `whatsapp:+${norm(to)}`;
  if (!C.SID || !C.TOKEN) { console.log(`[WAâ${toNum}]\n${body}\n`); return; }
  const payload = querystring.stringify({ From: C.FROM, To: toNum, Body: body });
  const creds = Buffer.from(`${C.SID}:${C.TOKEN}`).toString("base64");
  return new Promise(resolve => {
    const req = https.request({
      hostname: "api.twilio.com",
      path: `/2010-04-01/Accounts/${C.SID}/Messages.json`,
      method: "POST",
      headers: { "Authorization": `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) }
    }, res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d)); });
    req.on("error", e => console.error("WA error", e));
    req.write(payload); req.end();
  });
}
async function notifyAll(msg, excludePhone = "") {
  const phones = [C.OWNER, ...C.NOTIFY].filter(p => p && norm(p) !== norm(excludePhone));
  await Promise.all(phones.map(p => sendWA(p, msg)));
}

// ââ MESSAGE PARSER ââââââââââââââââââââââââââââââââââââââââââââ
function parse(msg) {
  const low = msg.toLowerCase().trim();
  const r = { pct: null, accept: null, done: false, issue: null, eta: null };
  if (/^(yes|accept|haan|theek|ok|okay|confirm|aa gaya|pahunch|shuru|start)/.test(low)) r.accept = true;
  if (/^(no|reject|nahi|nhi|band|cancel|nahin|nahi aaunga)/.test(low)) r.accept = false;
  if (/\b(100|done|complete|khatam|ho gaya|finish|poora|mukammal)\b/.test(low)) { r.done = true; r.pct = 100; }
  if (!r.done) { const m = low.match(/(\d{1,3})\s*(%|percent|done|complete|ho gaya|pr|per)?/); if (m) { const n = parseInt(m[1]); if (n >= 0 && n <= 100) r.pct = n; } }
  if (/\b(issue|problem|dikkat|nahi hai|nhi hai|rukk|band|delay|atka)\b/.test(low)) { const m = low.match(/(?:issue|problem|dikkat)[:\s]+(.+)/); r.issue = m ? m[1].trim() : low.trim(); }
  const etaM = low.match(/\b(by\s+)?(\d+\s*(day|din|week|hafte|hour|ghante)s?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|kal|parso|aaj)\b/);
  if (etaM) r.eta = etaM[0].replace(/^by\s+/, "").trim();
  return r;
}
function findKarigar(phone) { const n = norm(phone); return store.karigars.find(k => norm(k.phone) === n); }

// ============================================================
// ð¤ AI AGENT TEAM
// ============================================================

function logTask(agent, input, output, status = "done") {
  const task = { id: taskId++, agent, input: input.slice(0, 200), output: output.slice(0, 500), status, t: tnow(), date: new Date().toLocaleDateString("en-IN") };
  store.agentTasks.unshift(task);
  if (store.agentTasks.length > 200) store.agentTasks.pop();
  addLog(`ð¤ ${agent}: ${input.slice(0, 60)}...`, "agent");
  return task;
}

// ââ BOSS AGENT â routes tasks to correct specialist ââââââââââ
async function bossAgent(input) {
  const siteNames = store.sites.map(s => s.name).join(", ") || "none";
  const productNames = store.products.map(p => p.name).join(", ") || "none";

  const routing = await gpt(
    `You are the Boss Agent for SKT Impex, an interior decor and construction materials company in India.
Your job is to read the user's request and decide which specialist agent should handle it.

Available agents:
- "order" â order status, site progress, karigar assignment, job updates
- "inquiry" â product questions, pricing, availability, specifications
- "quote" â generate price quotations for customers
- "followup" â follow up with leads, pending payments, customer callbacks
- "marketing" â create WhatsApp messages, Instagram captions, product descriptions, SEO content

Current sites: ${siteNames}
Products in catalog: ${productNames}

Reply with ONLY a JSON: {"agent":"<name>","reason":"<one line why>"}`,
    input
  );

  let agentName = "inquiry";
  try {
    const parsed = JSON.parse(routing.replace(/```json|```/g, "").trim());
    agentName = parsed.agent || "inquiry";
  } catch (e) { }

  // Route to correct agent
  let response = "";
  if (agentName === "order") response = await orderAgent(input);
  else if (agentName === "quote") response = await quoteAgent(input);
  else if (agentName === "followup") response = await followupAgent(input);
  else if (agentName === "marketing") response = await marketingAgent(input);
  else response = await inquiryAgent(input);

  return { agent: agentName, response };
}

// ââ AGENT 1: ORDER MANAGER âââââââââââââââââââââââââââââââââââ
async function orderAgent(input) {
  const siteData = store.sites.map(s =>
    `Site: ${s.name} | Status: ${s.status} | Progress: ${s.pct}% | Karigar: ${s.karigar.length} assigned | Issue: ${s.issue}`
  ).join("\n") || "No sites yet.";

  return await gpt(
    `You are the Order Manager Agent for SKT Impex. You handle site/job status, karigar assignments, and project updates.
Current site data:
${siteData}

Reply in clear, friendly English. Keep it concise. If asked about a specific site, give its full status.
If no relevant data, suggest what action to take on the dashboard.`,
    input
  );
}

// ââ AGENT 2: PRODUCT INQUIRY âââââââââââââââââââââââââââââââââ
async function inquiryAgent(input) {
  const catalog = store.products.length > 0
    ? store.products.map(p => `${p.name}: ${p.desc} | Price: â¹${p.price} per ${p.unit}`).join("\n")
    : "No products added yet. Add products via the Products section.";

  return await gpt(
    `You are the Product Inquiry Agent for SKT Impex, an interior decor company selling wooden wall panels, louvers, baffle ceilings, moss walls, and similar products.

Product catalog:
${catalog}

Answer customer questions about products, pricing, availability, and specifications.
Be helpful and professional. If product isn't in catalog, give general knowledge about that product type.
Always mention prices in â¹ (Indian Rupees). Keep reply under 150 words.`,
    input
  );
}

// ââ AGENT 3: QUOTATION âââââââââââââââââââââââââââââââââââââââ
async function quoteAgent(input) {
  const result = await gpt(
    `You are the Quotation Agent for SKT Impex. Generate professional price quotes from customer requests.

Extract details and return ONLY a JSON:
{
  "clientName": "customer name or 'Customer'",
  "items": [{"product": "product name", "qty": number, "unit": "sqft/pcs/rft", "rate": number, "amount": number}],
  "subtotal": number,
  "notes": "any special notes",
  "validDays": 30
}

Rules:
- If rate not mentioned, use reasonable market rates for interior decor materials in India
- Wooden wall panels: â¹80-150/sqft, Baffle ceiling: â¹120-200/sqft, Moss wall: â¹200-400/sqft
- Always include installation note if relevant
- Calculate amounts correctly`,
    input,
    "gpt-4o-mini",
    600
  );

  let quoteData = null;
  try {
    quoteData = JSON.parse(result.replace(/```json|```/g, "").trim());
    // Save quote
    const q = { id: quoteId++, ...quoteData, createdAt: new Date().toISOString(), status: "draft" };
    store.quotes.push(q);
    const total = quoteData.subtotal || quoteData.items?.reduce((s, i) => s + i.amount, 0) || 0;
    return `â Quote generated!\n\nClient: ${quoteData.clientName}\nItems: ${quoteData.items?.length || 0}\nTotal: â¹${total.toLocaleString("en-IN")}\nValid: ${quoteData.validDays} days\n\nQuote saved with ID #${q.id}. View in Quotes tab.`;
  } catch (e) {
    return result; // fallback to text response
  }
}

// ââ AGENT 4: FOLLOW-UP âââââââââââââââââââââââââââââââââââââââ
async function followupAgent(input) {
  const leadData = store.leads.map(l =>
    `${l.name} | ${l.phone} | ${l.status} | Last contact: ${l.lastContact || "never"} | Notes: ${l.notes}`
  ).join("\n") || "No leads added yet.";

  return await gpt(
    `You are the Follow-Up Agent for SKT Impex. You manage customer follow-ups, pending payments, and lead nurturing.

Current leads:
${leadData}

Help with:
- Drafting WhatsApp follow-up messages to send to customers
- Identifying which leads need attention
- Writing payment reminder messages
- Suggesting follow-up schedules

Write messages in a friendly, professional tone. Use Hindi/Hinglish where appropriate for local customers.`,
    input
  );
}

// ââ AGENT 5: MARKETING âââââââââââââââââââââââââââââââââââââââ
async function marketingAgent(input) {
  return await gpt(
    `You are the Marketing & SEO Agent for SKT Impex, an interior decor company in India.

You create:
- Instagram captions for product photos
- WhatsApp broadcast messages
- Product descriptions for catalogs
- Google Business posts
- SEO-friendly content

Style: Modern, premium, aspirational but approachable. Mix English with Hindi phrases for local appeal.
Always include relevant hashtags for Instagram posts.
Keep WhatsApp messages short and punchy (under 100 words).
For SEO content, focus on keywords like "interior decor", "wooden wall panels", "louvers", city names.`,
    input,
    "gpt-4o-mini",
    600
  );
}

// ââ WEBHOOK âââââââââââââââââââââââââââââââââââââââââââââââââââ
async function webhook(body) {
  const from = (body.From || "").replace("whatsapp:", "");
  const msgBody = (body.Body || "").trim();
  const mediaUrl = body.MediaUrl0 || null;
  console.log(`[${tnow()}] from ${from}: "${msgBody}" media:${mediaUrl || "none"}`);
  const k = findKarigar(from);
  if (!k) return "Hello! Your number is not registered. Please contact your supervisor.";
  const site = store.sites.find(s => s.id === k.siteId);
  const p = parse(msgBody);
  if (mediaUrl) {
    if (!site) return `${k.name}, you are not assigned to any site right now.`;
    if (!site.photos) site.photos = [];
    site.photos.push({ url: mediaUrl, by: k.name, at: tnow(), date: new Date().toLocaleDateString("en-IN") });
    const photoMsg = `ð¸ *Completion Photo Received*\n\nSite: ${site.name}\nFrom: ${k.name}\nTime: ${tnow()}\nPhoto: ${mediaUrl}`;
    await notifyAll(photoMsg, from);
    addLog(`${k.name} sent completion photo for ${site.name}`, "photo");
    return `â Photo received for *${site.name}*. Supervisor has been notified.`;
  }
  if (p.accept === true) {
    if (!site) return `No site assigned to you right now, ${k.name}.`;
    site.status = "active";
    const reply = `â Confirmed ${k.name}! You are on *${site.name}*.\n\nð ${site.addr}\nð§ ${site.work}\n\nUpdate anytime:\nâ¢ Reply "70%" for progress\nâ¢ Reply "issue: [problem]" for issues\nâ¢ Reply "done" when complete\nâ¢ Send a photo when complete`;
    await notifyAll(`â *${k.name} accepted the site*\n\nSite: ${site.name}\nAddress: ${site.addr}\nKarigar: ${k.name} (${k.size} person team)`, from);
    addLog(`${k.name} accepted ${site.name}`, "assign");
    return reply;
  }
  if (p.accept === false) {
    const sName = site ? site.name : "site";
    if (site) { site.karigar = site.karigar.filter(id => id !== k.id); if (!site.karigar.length) site.status = "pending"; }
    k.free = true; k.siteId = null;
    await notifyAll(`â *${k.name} rejected the site*\n\nSite: ${sName}\nPlease reassign another karigar.`, from);
    addLog(`${k.name} rejected ${sName}`, "info");
    return `Okay ${k.name}, noted. Your supervisor will reassign.`;
  }
  if (p.pct !== null) {
    if (!site) return `${k.name}, you are not assigned to any site right now.`;
    site.pct = p.pct;
    if (p.issue) site.issue = p.issue;
    if (p.eta) site.note = `ETA: ${p.eta}`;
    if (p.done || p.pct >= 100) {
      site.pct = 100; site.status = "done"; k.free = true; k.siteId = null;
      const reply = `ð ${k.name}, work marked *100% complete* for *${site.name}*!\n\nPlease send completion photos now.`;
      await notifyAll(`ð *Job Complete!*\n\nSite: ${site.name}\nKarigar: ${k.name}\nâ 100% done${p.eta ? "\nCompleted: " + p.eta : ""}\n\nAwaiting completion photos.`, from);
      addLog(`${k.name} completed ${site.name}`, "done");
      return reply;
    }
    const reply = `â Progress updated to *${p.pct}%* for *${site.name}*.${p.eta ? "\nð ETA: " + p.eta : ""}${p.issue ? "\nâ  Issue: " + p.issue : "\nâ No issues noted."}\n\nKeep going! Reply with % anytime.`;
    await notifyAll(`ð *Progress Update*\n\nSite: ${site.name}\nKarigar: ${k.name}\nProgress: *${p.pct}%*${p.eta ? "\nð ETA: " + p.eta : ""}${p.issue ? "\nâ  Issue: " + p.issue : ""}`, from);
    addLog(`${k.name} â ${site.name} = ${p.pct}%${p.issue ? " | Issue:" + p.issue : ""}`, "progress");
    return reply;
  }
  if (p.issue) {
    if (site) site.issue = p.issue;
    await notifyAll(`â  *Issue Flagged*\n\nSite: ${site ? site.name : "Unknown"}\nKarigar: ${k.name}\nIssue: ${p.issue}\n\nPlease arrange support.`, from);
    addLog(`${k.name} flagged issue: ${p.issue}`, "issue");
    return `â  Issue noted. Supervisor has been notified. Someone will contact you soon.`;
  }
  return `Hello ${k.name}! Reply with:\nâ¢ "accept" â confirm site\nâ¢ "70%" â update progress\nâ¢ "done" â work complete\nâ¢ "issue: [describe]" â flag problem\nâ¢ Send a photo â completion photo`;
}

// ââ API ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function handleAPI(method, url, body, res) {
  // AUTH
  if (method === "POST" && url === "/api/auth/login") {
    const { pin } = body;
    const staff = store.staff.find(s => s.pin === String(pin));
    if (!staff) return json(res, { ok: false, error: "Wrong PIN" }, 401);
    return json(res, { ok: true, staff: { id: staff.id, name: staff.name, role: staff.role } });
  }

  // DATA
  if (method === "GET" && url === "/api/data")
    return json(res, { sites: store.sites, karigars: store.karigars, log: store.log, staff: store.staff.map(s => ({ id: s.id, name: s.name, role: s.role, addedAt: s.addedAt })) });

  // ââ AGENT ENDPOINTS âââââââââââââââââââââââââââââââââââââââââ

  // Boss Agent â main entry point
  if (method === "POST" && url === "/api/agent/chat") {
    const { message } = body;
    if (!message) return json(res, { ok: false, error: "message required" }, 400);
    if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set in Railway" }, 500);
    try {
      const { agent, response } = await bossAgent(message);
      const task = logTask(agent, message, response);
      return json(res, { ok: true, agent, response, taskId: task.id });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 500);
    }
  }

  // Direct agent endpoints
  if (method === "POST" && url === "/api/agent/inquiry") {
    const { message } = body;
    if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set" }, 500);
    const response = await inquiryAgent(message);
    logTask("inquiry", message, response);
    return json(res, { ok: true, response });
  }

  if (method === "POST" && url === "/api/agent/quote") {
    const { message } = body;
    if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set" }, 500);
    const response = await quoteAgent(message);
    logTask("quote", message, response);
    return json(res, { ok: true, response });
  }

  if (method === "POST" && url === "/api/agent/followup") {
    const { message } = body;
    if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set" }, 500);
    const response = await followupAgent(message);
    logTask("followup", message, response);
    return json(res, { ok: true, response });
  }

  if (method === "POST" && url === "/api/agent/marketing") {
    const { message } = body;
    if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set" }, 500);
    const response = await marketingAgent(message);
    logTask("marketing", message, response);
    return json(res, { ok: true, response });
  }

  if (method === "POST" && url === "/api/agent/order") {
    const { message } = body;
    if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set" }, 500);
    const response = await orderAgent(message);
    logTask("order", message, response);
    return json(res, { ok: true, response });
  }

  // Agent tasks log
  if (method === "GET" && url === "/api/agent/tasks")
    return json(res, { ok: true, tasks: store.agentTasks });

  // Quotes
  if (method === "GET" && url === "/api/quotes")
    return json(res, { ok: true, quotes: store.quotes });

  // Products
  if (method === "GET" && url === "/api/products")
    return json(res, { ok: true, products: store.products });

  if (method === "POST" && url === "/api/products/add") {
    const p = { id: productId++, ...body, addedAt: new Date().toISOString() };
    store.products.push(p);
    addLog(`Product added: ${p.name}`, "info");
    return json(res, { ok: true, product: p });
  }

  if (method === "POST" && url === "/api/products/delete") {
    store.products = store.products.filter(x => x.id !== body.id);
    return json(res, { ok: true });
  }

  // Leads
  if (method === "GET" && url === "/api/leads")
    return json(res, { ok: true, leads: store.leads });

  if (method === "POST" && url === "/api/leads/add") {
    const l = { id: leadId++, ...body, status: body.status || "new", lastContact: null, addedAt: new Date().toISOString() };
    store.leads.push(l);
    addLog(`Lead added: ${l.name}`, "info");
    return json(res, { ok: true, lead: l });
  }

  if (method === "POST" && url === "/api/leads/update") {
    const l = store.leads.find(x => x.id === body.id);
    if (l) { Object.assign(l, body); l.lastContact = new Date().toLocaleDateString("en-IN"); }
    return json(res, { ok: true });
  }

  if (method === "POST" && url === "/api/leads/delete") {
    store.leads = store.leads.filter(x => x.id !== body.id);
    return json(res, { ok: true });
  }

  // ââ EXISTING ENDPOINTS ââââââââââââââââââââââââââââââââââââââ

  if (method === "POST" && url === "/api/staff/add") {
    const { name, pin, role } = body;
    if (!name || !pin) return json(res, { ok: false, error: "Name and PIN required" }, 400);
    if (store.staff.find(s => s.pin === String(pin))) return json(res, { ok: false, error: "PIN already in use" }, 400);
    const s = { id: staffId++, name: name.trim(), pin: String(pin), role: role || "staff", addedAt: new Date().toISOString() };
    store.staff.push(s);
    addLog(`Staff added: ${s.name}`, "info");
    return json(res, { ok: true, staff: { id: s.id, name: s.name, role: s.role } });
  }

  if (method === "POST" && url === "/api/staff/delete") {
    const { id } = body;
    if (store.staff.find(s => s.id === id && s.role === "owner")) return json(res, { ok: false, error: "Cannot delete owner" }, 400);
    const s = store.staff.find(x => x.id === id);
    store.staff = store.staff.filter(x => x.id !== id);
    if (s) addLog(`Staff removed: ${s.name}`, "info");
    return json(res, { ok: true });
  }

  if (method === "POST" && url === "/api/karigar/add") {
    const k = { id: karId++, ...body, free: true, siteId: null, photos: [] };
    store.karigars.push(k);
    addLog(`Karigar added: ${k.name}`, "info");
    return json(res, { ok: true, karigar: k });
  }

  if (method === "POST" && url === "/api/karigar/delete") {
    const k = store.karigars.find(x => x.id === body.id);
    if (k && k.siteId) { const s = store.sites.find(x => x.id === k.siteId); if (s) s.karigar = s.karigar.filter(id => id !== k.id); }
    store.karigars = store.karigars.filter(x => x.id !== body.id);
    if (k) addLog(`Karigar removed: ${k.name}`, "info");
    return json(res, { ok: true });
  }

  if (method === "POST" && url === "/api/site/add") {
    const s = { id: siteId++, ...body, karigar: [], pct: 0, issue: "none", note: "", status: "pending", photos: [], addedAt: new Date().toISOString(), addedBy: body.addedBy || "Staff" };
    store.sites.push(s);
    addLog(`Site added: ${s.name} by ${s.addedBy}`, "info");
    return json(res, { ok: true, site: s });
  }

  if (method === "POST" && url === "/api/site/delete") {
    const s = store.sites.find(x => x.id === body.id);
    if (s) s.karigar.forEach(kid => { const k = store.karigars.find(x => x.id === kid); if (k) { k.free = true; k.siteId = null; } });
    store.sites = store.sites.filter(x => x.id !== body.id);
    if (s) addLog(`Site deleted: ${s.name}`, "info");
    return json(res, { ok: true });
  }

  if (method === "POST" && url === "/api/assign") {
    const { siteId: sid, karigarIds, by = "" } = body;
    const s = store.sites.find(x => x.id === sid);
    if (!s) return json(res, { ok: false, error: "Site not found" }, 404);
    s.karigar.forEach(kid => { if (!karigarIds.includes(kid)) { const k = store.karigars.find(x => x.id === kid); if (k) { k.free = true; k.siteId = null; } } });
    s.karigar = karigarIds;
    karigarIds.forEach(kid => { const k = store.karigars.find(x => x.id === kid); if (k) { k.free = false; k.siteId = sid; } });
    if (s.karigar.length) s.status = "assigned";
    for (const kid of karigarIds) {
      const k = store.karigars.find(x => x.id === kid);
      if (k) {
        const msg = `*New Site Offer*\n\nHello ${k.name},\n\nð *Site:* ${s.name}\nð  *Address:* ${s.addr}\nð§ *Work:* ${s.work}\nð *Start:* ${s.date}${s.end ? "\nð *Complete by:* " + s.end : ""}\n\nPlease reply:\nâ ACCEPT â to confirm\nâ REJECT â if not available\n\nAfter starting:\nâ¢ Reply "70%" to update progress\nâ¢ Reply "done" when complete\nâ¢ Send photos when done\nâ¢ Reply "issue: [problem]" if stuck\n\nâ ${by || "Operations Team"}`;
        await sendWA(k.phone, msg);
      }
    }
    addLog(`Karigar assigned to ${s.name} by ${by}`, "assign");
    return json(res, { ok: true });
  }

  if (method === "POST" && url === "/api/status") {
    const { id, pct, issue, note, by = "" } = body;
    const s = store.sites.find(x => x.id === id);
    if (s) { s.pct = pct; s.issue = issue || "none"; s.note = note || ""; if (pct >= 100) s.status = "done"; }
    addLog(`${s ? s.name : id} updated to ${pct}% by ${by}`, "progress");
    return json(res, { ok: true });
  }

  json(res, { error: "Not found" }, 404);
}

// ââ HTTP SERVER âââââââââââââââââââââââââââââââââââââââââââââââ
http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }

  if (method === "GET" && (url === "/" || url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8"));
  }

  if (method === "GET" && url === "/agents") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(fs.readFileSync(path.join(__dirname, "agents.html"), "utf8"));
  }

  if (method === "POST" && url === "/webhook") {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", async () => {
      const body = querystring.parse(raw);
      const reply = await webhook(body);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
    });
    return;
  }

  if (method === "POST" && url === "/api/transcribe") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks);
        const ctype = req.headers["content-type"] || "";
        const boundary = ctype.split("boundary=")[1];
        if (!boundary) return json(res, { ok: false, error: "No boundary" }, 400);
        const parts = splitMultipart(body, boundary);
        const audioPart = parts.find(p => p.name === "audio");
        const karPart = parts.find(p => p.name === "karigars");
        if (!audioPart) return json(res, { ok: false, error: "No audio found" }, 400);
        const karigars = karPart ? JSON.parse(karPart.data.toString()) : [];
        const fname = audioPart.filename || "audio.webm";
        const ext = fname.split(".").pop() || "webm";
        if (!C.OPENAI_KEY) return json(res, { ok: false, error: "OPENAI_API_KEY not set in Railway variables" }, 500);
        const oaBoundary = "OAB" + Date.now();
        const oaBody = Buffer.concat([
          Buffer.from(`--${oaBoundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: audio/${ext}\r\n\r\n`),
          audioPart.data,
          Buffer.from(`\r\n--${oaBoundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`),
          Buffer.from(`\r\n--${oaBoundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhi`),
          Buffer.from(`\r\n--${oaBoundary}--`),
        ]);
        const whisperRaw = await openaiRequest("/v1/audio/transcriptions", "POST", oaBody, `multipart/form-data; boundary=${oaBoundary}`);
        const whisperData = JSON.parse(whisperRaw);
        if (!whisperData.text) return json(res, { ok: false, error: whisperData.error?.message || "Whisper failed" }, 500);
        const transcript = whisperData.text;
        console.log(`[Whisper] "${transcript}"`);
        const today = new Date().toISOString().split("T")[0];
        const karigarList = karigars.map(k => `- ${k.name} (ID:${k.id}, skill:${k.skill})`).join("\n") || "No karigars registered yet.";
        const prompt = `You are a construction site management assistant in India. Extract site details from this Hindi/Hinglish transcript.
Transcript: "${transcript}"
Available karigars: ${karigarList}
Today: ${today}
Return ONLY JSON: {"name":"","addr":"","work":"","workType":"Electrical|Plumbing|Civil|Carpentry|Painting|Fabrication|General","date":"YYYY-MM-DD","end":"","karigars":[]}`;
        const parsed = await gpt("You extract structured data from Hindi/Hinglish construction site descriptions. Return only valid JSON.", prompt, "gpt-4o-mini", 400);
        let parsedData = null;
        try { parsedData = JSON.parse(parsed.replace(/```json|```/g, "").trim()); } catch (e) { }
        addLog(`Voice: "${transcript.slice(0, 50)}..."`, "info");
        return json(res, { ok: true, text: transcript, parsed: parsedData });
      } catch (e) {
        console.error("Transcribe error:", e);
        return json(res, { ok: false, error: e.message }, 500);
      }
    });
    return;
  }

  if (url.startsWith("/api/")) {
    let raw = "";
    req.on("data", c => raw += c);
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { }
      await handleAPI(method, url, body, res);
    });
    return;
  }

  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, agents: ["boss", "order", "inquiry", "quote", "followup", "marketing"] }));
  }

  res.writeHead(404);
  res.end("Not found");
}).listen(C.PORT, () => console.log(`\nâ OPS v4 on port ${C.PORT}\n Dashboard: http://localhost:${C.PORT}\n Agents: http://localhost:${C.PORT}/agents\n Webhook: http://localhost:${C.PORT}/webhook\n`));
