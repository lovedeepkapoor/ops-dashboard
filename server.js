// ============================================================
// OPS APP v3 — Server
// PIN login + Staff management + Karigar WhatsApp + Photos
// ============================================================
const http        = require("http");
const https       = require("https");
const fs          = require("fs");
const path        = require("path");
const querystring = require("querystring");

const C = {
  PORT:       process.env.PORT            || 3000,
  SID:        process.env.TWILIO_SID      || "",
  TOKEN:      process.env.TWILIO_TOKEN    || "",
  FROM:       process.env.TWILIO_FROM     || "whatsapp:+14155238886",
  OWNER:      process.env.OWNER_PHONE     || "",
  NOTIFY:     (process.env.NOTIFY_PHONES  || "").split(",").filter(Boolean),
  OPENAI_KEY: process.env.OPENAI_API_KEY  || "",
};

// ── OPENAI HELPER ─────────────────────────────────────────────
function openaiRequest(urlPath, method, body, contentType) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.openai.com", path:urlPath, method,
      headers: { "Authorization":`Bearer ${C.OPENAI_KEY}`, "Content-Type":contentType, "Content-Length":body.length }
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>resolve(d)); });
    req.on("error", reject); req.write(body); req.end();
  });
}

// ── MULTIPART PARSER ──────────────────────────────────────────
function idxOf(buf,search,start=0){for(let i=start;i<=buf.length-search.length;i++){let ok=true;for(let j=0;j<search.length;j++){if(buf[i+j]!==search[j]){ok=false;break;}}if(ok)return i;}return -1;}
function splitMultipart(body,boundary){
  const parts=[],delim=Buffer.from("--"+boundary),endM=Buffer.from("--"+boundary+"--");
  let pos=0;
  while(pos<body.length){
    const start=idxOf(body,delim,pos);if(start===-1)break;
    pos=start+delim.length+2;
    if(body.slice(start,start+endM.length).equals(endM))break;
    const hdrEnd=idxOf(body,Buffer.from("\r\n\r\n"),pos);if(hdrEnd===-1)break;
    const hdr=body.slice(pos,hdrEnd).toString();
    const next=idxOf(body,delim,hdrEnd+4);
    const data=body.slice(hdrEnd+4,next===-1?body.length:next-2);
    const nm=hdr.match(/name="([^"]+)"/),fm=hdr.match(/filename="([^"]+)"/);
    parts.push({name:nm?nm[1]:"",filename:fm?fm[1]:"",data});
    pos=next===-1?body.length:next;
  }
  return parts;
}

// ── STORE ────────────────────────────────────────────────────
const store = {
  staff:    [
    { id: 1, name: "Owner", pin: process.env.OWNER_PIN || "0000", role: "owner", addedAt: new Date().toISOString() }
  ],
  sites:    [],
  karigars: [],
  log:      [],
};

let siteId = 1, karId = 1, staffId = 2;

// ── HELPERS ──────────────────────────────────────────────────
const tnow  = () => { const d=new Date(); return d.getHours().toString().padStart(2,"0")+":"+d.getMinutes().toString().padStart(2,"0"); };
const norm  = p  => (p||"").replace(/\D/g,"");
const json  = (res,data,code=200) => { res.writeHead(code,{"Content-Type":"application/json","Access-Control-Allow-Origin":"*"}); res.end(JSON.stringify(data)); };

function addLog(txt, type="info") {
  store.log.unshift({ t: tnow(), txt, type });
  if (store.log.length > 300) store.log.pop();
}

// ── TWILIO ───────────────────────────────────────────────────
async function sendWA(to, body) {
  const toNum = to.startsWith("whatsapp:") ? to : `whatsapp:+${norm(to)}`;
  if (!C.SID || !C.TOKEN) { console.log(`[WA→${toNum}]\n${body}\n`); return; }
  const payload = querystring.stringify({ From: C.FROM, To: toNum, Body: body });
  const creds   = Buffer.from(`${C.SID}:${C.TOKEN}`).toString("base64");
  return new Promise(resolve => {
    const req = https.request({
      hostname: "api.twilio.com",
      path:     `/2010-04-01/Accounts/${C.SID}/Messages.json`,
      method:   "POST",
      headers:  { "Authorization":`Basic ${creds}`, "Content-Type":"application/x-www-form-urlencoded", "Content-Length":Buffer.byteLength(payload) }
    }, res => { let d=""; res.on("data",c=>d+=c); res.on("end",()=>resolve(d)); });
    req.on("error", e => console.error("WA error",e));
    req.write(payload); req.end();
  });
}

async function notifyAll(msg, excludePhone="") {
  const phones = [C.OWNER, ...C.NOTIFY].filter(p => p && norm(p) !== norm(excludePhone));
  await Promise.all(phones.map(p => sendWA(p, msg)));
}

// ── MESSAGE PARSER ───────────────────────────────────────────
function parse(msg) {
  const low = msg.toLowerCase().trim();
  const r   = { pct:null, accept:null, done:false, issue:null, eta:null };

  if (/^(yes|accept|haan|theek|ok|okay|confirm|aa gaya|pahunch|shuru|start)/.test(low)) r.accept = true;
  if (/^(no|reject|nahi|nhi|band|cancel|nahin|nahi aaunga)/.test(low))                  r.accept = false;

  if (/\b(100|done|complete|khatam|ho gaya|finish|poora|mukammal)\b/.test(low)) { r.done=true; r.pct=100; }

  if (!r.done) {
    const m = low.match(/(\d{1,3})\s*(%|percent|done|complete|ho gaya|pr|per)?/);
    if (m) { const n=parseInt(m[1]); if (n>=0&&n<=100) r.pct=n; }
  }

  if (/\b(issue|problem|dikkat|nahi hai|nhi hai|rukk|band|delay|atka)\b/.test(low)) {
    const m = low.match(/(?:issue|problem|dikkat)[:\s]+(.+)/);
    r.issue = m ? m[1].trim() : low.trim();
  }

  const etaM = low.match(/\b(by\s+)?(\d+\s*(day|din|week|hafte|hour|ghante)s?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|kal|parso|aaj)\b/);
  if (etaM) r.eta = etaM[0].replace(/^by\s+/,"").trim();

  return r;
}

function findKarigar(phone) {
  const n = norm(phone);
  return store.karigars.find(k => norm(k.phone) === n);
}

// ── WEBHOOK ──────────────────────────────────────────────────
async function webhook(body) {
  const from     = (body.From||"").replace("whatsapp:","");
  const msgBody  = (body.Body||"").trim();
  const mediaUrl = body.MediaUrl0 || null;   // photo from karigar
  console.log(`[${tnow()}] from ${from}: "${msgBody}" media:${mediaUrl||"none"}`);

  const k    = findKarigar(from);
  if (!k) return "Hello! Your number is not registered. Please contact your supervisor.";

  const site = store.sites.find(s => s.id === k.siteId);
  const p    = parse(msgBody);

  // ── COMPLETION PHOTO ────────────────────────────────────
  if (mediaUrl) {
    if (!site) return `${k.name}, you are not assigned to any site right now.`;
    if (!site.photos) site.photos = [];
    site.photos.push({ url: mediaUrl, by: k.name, at: tnow(), date: new Date().toLocaleDateString("en-IN") });
    const photoMsg = `📸 *Completion Photo Received*\n\nSite: ${site.name}\nFrom: ${k.name}\nTime: ${tnow()}\nPhoto: ${mediaUrl}`;
    await notifyAll(photoMsg, from);
    addLog(`${k.name} sent completion photo for ${site.name}`, "photo");
    return `✅ Photo received for *${site.name}*. Supervisor has been notified.`;
  }

  // ── ACCEPT / REJECT ──────────────────────────────────────
  if (p.accept === true) {
    if (!site) return `No site assigned to you right now, ${k.name}.`;
    site.status = "active";
    const reply = `✅ Confirmed ${k.name}! You are on *${site.name}*.\n\n📍 ${site.addr}\n🔧 ${site.work}\n\nUpdate anytime:\n• Reply "70%" for progress\n• Reply "issue: [problem]" for issues\n• Reply "done" when complete\n• Send a photo when complete`;
    await notifyAll(`✅ *${k.name} accepted the site*\n\nSite: ${site.name}\nAddress: ${site.addr}\nKarigar: ${k.name} (${k.size} person team)`, from);
    addLog(`${k.name} accepted ${site.name}`, "assign");
    return reply;
  }

  if (p.accept === false) {
    const sName = site ? site.name : "site";
    if (site) { site.karigar = site.karigar.filter(id=>id!==k.id); if(!site.karigar.length) site.status="pending"; }
    k.free=true; k.siteId=null;
    await notifyAll(`❌ *${k.name} rejected the site*\n\nSite: ${sName}\nPlease reassign another karigar.`, from);
    addLog(`${k.name} rejected ${sName}`, "info");
    return `Okay ${k.name}, noted. Your supervisor will reassign.`;
  }

  // ── PROGRESS UPDATE ──────────────────────────────────────
  if (p.pct !== null) {
    if (!site) return `${k.name}, you are not assigned to any site right now.`;
    site.pct = p.pct;
    if (p.issue) site.issue = p.issue;
    if (p.eta)   site.note  = `ETA: ${p.eta}`;

    if (p.done || p.pct >= 100) {
      site.pct=100; site.status="done"; k.free=true; k.siteId=null;
      const reply = `🎉 ${k.name}, work marked *100% complete* for *${site.name}*!\n\nPlease send completion photos now.`;
      await notifyAll(`🎉 *Job Complete!*\n\nSite: ${site.name}\nKarigar: ${k.name}\n✅ 100% done${p.eta?"\nCompleted: "+p.eta:""}\n\nAwaiting completion photos.`, from);
      addLog(`${k.name} completed ${site.name}`, "done");
      return reply;
    }

    const reply = `✅ Progress updated to *${p.pct}%* for *${site.name}*.${p.eta?"\n📅 ETA: "+p.eta:""}${p.issue?"\n⚠ Issue: "+p.issue:"\n✓ No issues noted."}\n\nKeep going! Reply with % anytime.`;
    await notifyAll(`📊 *Progress Update*\n\nSite: ${site.name}\nKarigar: ${k.name}\nProgress: *${p.pct}%*${p.eta?"\n📅 ETA: "+p.eta:""}${p.issue?"\n⚠ Issue: "+p.issue:""}`, from);
    addLog(`${k.name} → ${site.name} = ${p.pct}%${p.issue?" | Issue:"+p.issue:""}`, "progress");
    return reply;
  }

  // ── ISSUE ONLY ───────────────────────────────────────────
  if (p.issue) {
    if (site) site.issue = p.issue;
    await notifyAll(`⚠ *Issue Flagged*\n\nSite: ${site?site.name:"Unknown"}\nKarigar: ${k.name}\nIssue: ${p.issue}\n\nPlease arrange support.`, from);
    addLog(`${k.name} flagged issue: ${p.issue}`, "issue");
    return `⚠ Issue noted. Supervisor has been notified. Someone will contact you soon.`;
  }

  return `Hello ${k.name}! Reply with:\n• "accept" — confirm site\n• "70%" — update progress\n• "done" — work complete\n• "issue: [describe]" — flag problem\n• Send a photo — completion photo`;
}

// ── API ───────────────────────────────────────────────────────
async function handleAPI(method, url, body, res) {

  // AUTH — verify PIN
  if (method==="POST" && url==="/api/auth/login") {
    const { pin } = body;
    const staff = store.staff.find(s => s.pin === String(pin));
    if (!staff) return json(res, { ok:false, error:"Wrong PIN" }, 401);
    return json(res, { ok:true, staff: { id:staff.id, name:staff.name, role:staff.role } });
  }

  // DATA
  if (method==="GET" && url==="/api/data")
    return json(res, { sites:store.sites, karigars:store.karigars, log:store.log, staff:store.staff.map(s=>({id:s.id,name:s.name,role:s.role,addedAt:s.addedAt})) });

  // STAFF
  if (method==="POST" && url==="/api/staff/add") {
    const { name, pin, role } = body;
    if (!name||!pin) return json(res,{ok:false,error:"Name and PIN required"},400);
    if (store.staff.find(s=>s.pin===String(pin))) return json(res,{ok:false,error:"PIN already in use"},400);
    const s = { id:staffId++, name:name.trim(), pin:String(pin), role:role||"staff", addedAt:new Date().toISOString() };
    store.staff.push(s);
    addLog(`Staff added: ${s.name}`, "info");
    return json(res, { ok:true, staff:{id:s.id,name:s.name,role:s.role} });
  }

  if (method==="POST" && url==="/api/staff/delete") {
    const { id } = body;
    if (store.staff.find(s=>s.id===id&&s.role==="owner")) return json(res,{ok:false,error:"Cannot delete owner"},400);
    const s = store.staff.find(x=>x.id===id);
    store.staff = store.staff.filter(x=>x.id!==id);
    if (s) addLog(`Staff removed: ${s.name}`, "info");
    return json(res, { ok:true });
  }

  // KARIGAR
  if (method==="POST" && url==="/api/karigar/add") {
    const k = { id:karId++, ...body, free:true, siteId:null, photos:[] };
    store.karigars.push(k);
    addLog(`Karigar added: ${k.name}`, "info");
    return json(res, { ok:true, karigar:k });
  }

  if (method==="POST" && url==="/api/karigar/delete") {
    const k = store.karigars.find(x=>x.id===body.id);
    if (k&&k.siteId) { const s=store.sites.find(x=>x.id===k.siteId); if(s) s.karigar=s.karigar.filter(id=>id!==k.id); }
    store.karigars = store.karigars.filter(x=>x.id!==body.id);
    if (k) addLog(`Karigar removed: ${k.name}`, "info");
    return json(res, { ok:true });
  }

  // SITES
  if (method==="POST" && url==="/api/site/add") {
    const s = { id:siteId++, ...body, karigar:[], pct:0, issue:"none", note:"", status:"pending", photos:[], addedAt:new Date().toISOString(), addedBy:body.addedBy||"Staff" };
    store.sites.push(s);
    addLog(`Site added: ${s.name} by ${s.addedBy}`, "info");
    return json(res, { ok:true, site:s });
  }

  if (method==="POST" && url==="/api/site/delete") {
    const s = store.sites.find(x=>x.id===body.id);
    if (s) s.karigar.forEach(kid=>{ const k=store.karigars.find(x=>x.id===kid); if(k){k.free=true;k.siteId=null;} });
    store.sites = store.sites.filter(x=>x.id!==body.id);
    if (s) addLog(`Site deleted: ${s.name}`, "info");
    return json(res, { ok:true });
  }

  // ASSIGN
  if (method==="POST" && url==="/api/assign") {
    const { siteId:sid, karigarIds, by="" } = body;
    const s = store.sites.find(x=>x.id===sid);
    if (!s) return json(res,{ok:false,error:"Site not found"},404);
    s.karigar.forEach(kid=>{ if(!karigarIds.includes(kid)){const k=store.karigars.find(x=>x.id===kid);if(k){k.free=true;k.siteId=null;}} });
    s.karigar = karigarIds;
    karigarIds.forEach(kid=>{ const k=store.karigars.find(x=>x.id===kid); if(k){k.free=false;k.siteId=sid;} });
    if (s.karigar.length) s.status = "assigned";
    // send WA to each karigar
    for (const kid of karigarIds) {
      const k = store.karigars.find(x=>x.id===kid);
      if (k) {
        const msg = `*New Site Offer*\n\nHello ${k.name},\n\n📍 *Site:* ${s.name}\n🏠 *Address:* ${s.addr}\n🔧 *Work:* ${s.work}\n📅 *Start:* ${s.date}${s.end?"\n🏁 *Complete by:* "+s.end:""}\n\nPlease reply:\n✅ ACCEPT — to confirm\n❌ REJECT — if not available\n\nAfter starting:\n• Reply "70%" to update progress\n• Reply "done" when complete\n• Send photos when done\n• Reply "issue: [problem]" if stuck\n\n— ${by||"Operations Team"}`;
        await sendWA(k.phone, msg);
      }
    }
    addLog(`Karigar assigned to ${s.name} by ${by}`, "assign");
    return json(res, { ok:true });
  }

  // STATUS UPDATE
  if (method==="POST" && url==="/api/status") {
    const { id, pct, issue, note, by="" } = body;
    const s = store.sites.find(x=>x.id===id);
    if (s) { s.pct=pct; s.issue=issue||"none"; s.note=note||""; if(pct>=100) s.status="done"; }
    addLog(`${s?s.name:id} updated to ${pct}% by ${by}`, "progress");
    return json(res, { ok:true });
  }

  json(res, { error:"Not found" }, 404);
}

// ── HTTP SERVER ───────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url    = req.url.split("?")[0];
  const method = req.method;

  if (method==="OPTIONS") {
    res.writeHead(204,{"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST","Access-Control-Allow-Headers":"Content-Type"});
    return res.end();
  }

  if (method==="GET" && (url==="/"||url==="/index.html")) {
    res.writeHead(200,{"Content-Type":"text/html"});
    return res.end(fs.readFileSync(path.join(__dirname,"index.html"),"utf8"));
  }

  if (method==="POST" && url==="/webhook") {
    let raw=""; req.on("data",c=>raw+=c);
    req.on("end", async () => {
      const body  = querystring.parse(raw);
      const reply = await webhook(body);
      res.writeHead(200,{"Content-Type":"text/xml"});
      res.end(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
    }); return;
  }

  if (method==="POST" && url==="/api/transcribe") {
    const chunks=[];
    req.on("data",c=>chunks.push(c));
    req.on("end", async()=>{
      try {
        const body     = Buffer.concat(chunks);
        const ctype    = req.headers["content-type"]||"";
        const boundary = ctype.split("boundary=")[1];
        if (!boundary) return json(res,{ok:false,error:"No boundary"},400);

        // ── Parse multipart ───────────────────────────────────
        const parts = splitMultipart(body, boundary);
        const audioPart   = parts.find(p=>p.name==="audio");
        const karPart     = parts.find(p=>p.name==="karigars");
        if (!audioPart) return json(res,{ok:false,error:"No audio found"},400);

        const karigars = karPart ? JSON.parse(karPart.data.toString()) : [];
        const fname    = audioPart.filename||"audio.webm";
        const ext      = fname.split(".").pop()||"webm";

        if (!C.OPENAI_KEY) return json(res,{ok:false,error:"OPENAI_API_KEY not set in Railway variables"},500);

        // ── Step 1: Whisper transcription ─────────────────────
        const oaBoundary = "OAB"+Date.now();
        const oaBody = Buffer.concat([
          Buffer.from(`--${oaBoundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.${ext}"\r\nContent-Type: audio/${ext}\r\n\r\n`),
          audioPart.data,
          Buffer.from(`\r\n--${oaBoundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`),
          Buffer.from(`\r\n--${oaBoundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nhi`),
          Buffer.from(`\r\n--${oaBoundary}--`),
        ]);

        const whisperRaw = await openaiRequest("/v1/audio/transcriptions","POST",oaBody,`multipart/form-data; boundary=${oaBoundary}`);
        const whisperData = JSON.parse(whisperRaw);
        if (!whisperData.text) return json(res,{ok:false,error:whisperData.error?.message||"Whisper failed"},500);

        const transcript = whisperData.text;
        console.log(`[Whisper] "${transcript}"`);

        // ── Step 2: Claude parses the Hindi/Hinglish text ─────
        const today = new Date().toISOString().split("T")[0];
        const karigarList = karigars.map(k=>`- ${k.name} (ID:${k.id}, skill:${k.skill})`).join("\n")||"No karigars registered yet.";

        const prompt = `You are a construction site management assistant in India. A staff member spoke in Hindi, English or Hinglish and it was transcribed. Extract the site details.

Transcript: "${transcript}"

Available karigars:
${karigarList}

Today's date: ${today}

Extract and return ONLY a JSON object with these exact fields:
{
  "name": "site or client name (e.g. Rahul ka ghar → Rahul Residence)",
  "addr": "address/location (e.g. Sector 32, Chandigarh)",
  "work": "what work needs to be done in English (translate from Hindi if needed)",
  "workType": "one of: Electrical, Plumbing, Civil, Carpentry, Painting, Fabrication, General",
  "date": "start date in YYYY-MM-DD format or today ${today} if not mentioned",
  "end": "completion date in YYYY-MM-DD format or empty string if not mentioned",
  "karigars": [array of karigar IDs from the list above that match names mentioned, empty array if none mentioned]
}

Rules:
- Translate all Hindi to English for name, addr, work fields
- "राहुल के घर" → name: "Rahul Residence"  
- "सेक्टर 32" → addr: "Sector 32"
- "वर्टिकल गार्डन" → work: "Vertical garden installation"
- "चंडीगढ़" → "Chandigarh"
- Match karigar names even if mentioned in Hindi or partial
- Return ONLY the JSON, no explanation, no markdown`;

        const claudeRaw = await openaiRequest("/v1/chat/completions","POST",
          Buffer.from(JSON.stringify({
            model:"gpt-4o-mini",
            messages:[{role:"user",content:prompt}],
            temperature:0.1,
            max_tokens:400,
          })),
          "application/json"
        );
        const claudeData = JSON.parse(claudeRaw);
        let parsed = null;
        try {
          const content = claudeData.choices?.[0]?.message?.content||"{}";
          const clean   = content.replace(/```json|```/g,"").trim();
          parsed        = JSON.parse(clean);
        } catch(e) {
          console.error("Parse error:",e);
        }

        addLog(`Voice: "${transcript.slice(0,50)}..."`, "info");
        return json(res,{ok:true, text:transcript, parsed});

      } catch(e) {
        console.error("Transcribe error:",e);
        return json(res,{ok:false,error:e.message},500);
      }
    });
    return;
  }

  if (url.startsWith("/api/")) {
    let raw=""; req.on("data",c=>raw+=c);
    req.on("end", async () => {
      let body={}; try{body=JSON.parse(raw);}catch{}
      await handleAPI(method, url, body, res);
    }); return;
  }

  if (url==="/health") { res.writeHead(200,{"Content-Type":"application/json"}); return res.end(JSON.stringify({ok:true})); }
  res.writeHead(404); res.end("Not found");

}).listen(C.PORT, ()=>console.log(`\n✅ Server on port ${C.PORT}\n   Dashboard: http://localhost:${C.PORT}\n   Webhook:   http://localhost:${C.PORT}/webhook\n`));
