# Twilio WhatsApp Webhook — Setup Guide

## What this does
- Karigar sends WhatsApp message like "70% done" or "issue: no material"
- Server receives it, updates job progress automatically
- Owner & supervisor get instant WhatsApp notification
- Delivery person sends "dispatched" or "delivered"
- Client gets notified automatically

---

## Step 1 — Install Node.js
Download from: https://nodejs.org (choose LTS version)
No other packages needed — uses built-in Node.js modules only.

---

## Step 2 — Configure server.js
Open server.js and fill in your details at the top:

```
TWILIO_ACCOUNT_SID: "ACxxxx..."       ← from twilio.com/console
TWILIO_AUTH_TOKEN:  "your_token"      ← from twilio.com/console
TWILIO_WA_NUMBER:   "whatsapp:+14155238886"  ← your Twilio sandbox number
OWNER_PHONE:        "whatsapp:+91XXXXXXXXXX" ← your WhatsApp number
SUPERVISOR_PHONE:   "whatsapp:+91XXXXXXXXXX" ← supervisor's WhatsApp
```

---

## Step 3 — Add karigar & delivery phone numbers

In server.js, find phoneToJob and add each karigar's number:

```js
const phoneToJob = {
  "+919876500002": "JB-001",   // Suresh Singh → Job 1
  "+919876500003": "JB-002",   // Ajay Sharma  → Job 2
};

const phoneToDelivery = {
  "+919876511001": "DL-001",   // Ramesh Driver → Delivery 1
};
```

---

## Step 4 — Run the server

```bash
node server.js
```

You'll see:
  ✅ Twilio webhook server running on port 3000

---

## Step 5 — Make it accessible (use ngrok for testing)

Install ngrok: https://ngrok.com/download

```bash
ngrok http 3000
```

Copy the URL it gives you, e.g.:
  https://abc123.ngrok.io

---

## Step 6 — Set webhook URL in Twilio

1. Go to twilio.com/console
2. Messaging → Try it out → Send a WhatsApp message
3. Sandbox Settings
4. "When a message comes in" → set to:
   POST  https://abc123.ngrok.io/webhook

---

## What karigar should send (in WhatsApp)

| Message | What happens |
|---|---|
| 70% done | Progress updated to 70% |
| 100% done | Job marked complete, owner notified |
| issue: no material | Issue flagged, owner & supervisor notified |
| no issue | Issue cleared |
| 50% done, issue: site locked | Both updated at once |

---

## What delivery person should send

| Message | Status |
|---|---|
| loaded | Loading goods |
| dispatched | Dispatched |
| reached | Goods reached client |
| delivered | Delivered & confirmed (client gets WA) |

---

## Check current status

Open in browser: http://localhost:3000/status
Shows all jobs and deliveries in real time.

---

## For production (permanent server)
Host on: Railway.app, Render.com, or any VPS
Both are free to start and give you a permanent URL.
