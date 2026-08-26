// =============================================================================
// server.js — Local Development Server
// Serves static files AND mocks the Cloudflare SMS Worker endpoint.
// Zero npm dependencies — uses Node.js built-in modules only.
//
// RUN:  node server.js
// OPEN: http://localhost:3000
//
// What this server does:
//   PORT 3000  → Serves all static files (index.html, styles.css, app.js, etc.)
//   POST /sms  → Mock SMS endpoint (logs to console, does NOT actually send SMS)
//
// When you're ready for production:
//   1. Deploy sms-worker.js to Cloudflare Workers
//   2. Change SMS_WORKER_URL in app.js to your real Worker URL
//   3. Set SMS_ENABLED = true in app.js
//   4. Deploy the static files to Cloudflare Pages
// =============================================================================

const http = require("http");
const fs   = require("fs");
const path = require("path");
const url  = require("url");

// Load local .env if present
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, "utf8").split("\n");
    envLines.forEach(line => {
      const parts = line.split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join("=").trim();
        if (key && !process.env[key]) process.env[key] = val;
      }
    });
  }
} catch (e) {}

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT      = process.env.PORT || 3000;
const STATIC_DIR = __dirname; // Serve files from the same directory as server.js
const BREVO_KEY  = process.env.BREVO_API_KEY || "";
const BREVO_USER = process.env.BREVO_SMTP_USER || "b6ba16001@smtp-brevo.com";
const BREVO_PASS = process.env.BREVO_SMTP_PASS || "";

// ── MIME type map ──────────────────────────────────────────────────────────────
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".txt":  "text/plain; charset=utf-8",
  ".md":   "text/plain; charset=utf-8",
};

// SMS log stored in memory — check it in the console
const smsLog = [];

// =============================================================================
// HTTP SERVER
// =============================================================================
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname  = parsedUrl.pathname;

  // ── CORS headers (needed so app.js can POST to /sms from the browser) ──────
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ===========================================================================
  // ROUTE: POST /sms — Mock SMS Worker
  // This simulates your Cloudflare Worker locally so you can test the full
  // accident → SMS flow without deploying anything.
  // ===========================================================================
  // ===========================================================================
  // ROUTE: POST /sms — SMS Gateway Proxy (Brevo / SSL Wireless / Mock)
  // ===========================================================================
  if (req.method === "POST" && pathname === "/sms") {
    let body = "";

    req.on("data", chunk => { body += chunk.toString(); });

    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { to, message, accidentId, vehicleName, lat, lng, provider, apiKey } = data;

        if (!to || !message) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required fields: to, message" }));
          return;
        }

        // Sanitize Bangladesh phone number (ensure 88017XXXXXXXX format)
        let phone = to.replace(/\D/g, "");
        if (phone.startsWith("01") && phone.length === 11) {
          phone = "880" + phone.slice(1);
        } else if (phone.startsWith("1") && phone.length === 10) {
          phone = "880" + phone;
        }

        const logEntry = {
          id:          `sms_${Date.now()}`,
          timestamp:   new Date().toISOString(),
          to:          phone,
          provider:    provider || "brevo",
          message,
          accidentId:  accidentId || "N/A",
          vehicleName: vehicleName || "Unknown",
          lat, lng
        };
        smsLog.push(logEntry);

        console.log("\n" + "═".repeat(60));
        console.log(`📱 [SMS GATEWAY DISPATCH] ➔ Provider: ${(provider || "brevo").toUpperCase()}`);
        console.log("═".repeat(60));
        console.log(`  ⏰ Time:      ${logEntry.timestamp}`);
        console.log(`  📞 To:        +${phone}`);
        console.log(`  🚗 Vehicle:   ${vehicleName || "ESP32 Unit"}`);
        console.log(`  🆔 Event:     ${accidentId || "TEST"}`);
        if (lat && lng) console.log(`  📍 Location:  https://maps.google.com/?q=${lat},${lng}`);
        console.log(`  💬 Message:\n     ${message}`);
        console.log("═".repeat(60));

        const brevoKey = apiKey || BREVO_KEY;

        // ── Real Brevo SMS Dispatch ──────────────────────────────────────────
        if ((provider === "brevo" || !provider) && brevoKey) {
          try {
            const https = require("https");
            const brevoPayload = JSON.stringify({
              sender: "IGHS",
              recipient: phone,
              content: message.substring(0, 160), // standard SMS length limit
              type: "transactional",
              unicodeEnabled: true
            });

            const brevoReq = https.request({
              hostname: "api.brevo.com",
              port: 443,
              path: "/v3/transactionalSMS/sms",
              method: "POST",
              headers: {
                "accept": "application/json",
                "api-key": brevoKey,
                "content-type": "application/json",
                "Content-Length": Buffer.byteLength(brevoPayload)
              }
            }, (brevoRes) => {
              let resData = "";
              brevoRes.on("data", chunk => { resData += chunk; });
              brevoRes.on("end", () => {
                console.log("📬 Brevo API Response:", resData);
                res.writeHead(brevoRes.statusCode || 200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  success: brevoRes.statusCode >= 200 && brevoRes.statusCode < 300,
                  provider: "brevo",
                  to: phone,
                  brevoResponse: JSON.parse(resData || "{}")
                }));
              });
            });

            brevoReq.on("error", (e) => {
              console.error("❌ Brevo Network Error:", e.message);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: e.message }));
            });

            brevoReq.write(brevoPayload);
            brevoReq.end();
            return;
          } catch (brevoErr) {
            console.error("Brevo dispatch error:", brevoErr);
          }
        }

        // ── Fallback to Local Log / Simulator ──────────────────────────────
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          success:   true,
          provider:  provider || "local_mock",
          to:        phone,
          accidentId: accidentId || null,
          note:      brevoKey ? "Dispatched via Brevo." : "Logged locally. Add your Brevo API key to send live SMS."
        }));

      } catch (err) {
        console.error("[/sms] Error:", err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request payload" }));
      }
    });

    return;
  }

  // ===========================================================================
  // ROUTE: POST /email — Brevo Emergency Incident Email Dispatcher (SMTP + API)
  // ===========================================================================
  if (req.method === "POST" && pathname === "/email") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { to, senderEmail, vehicleName, lat, lng, distance, severity } = data;

        const recipientEmail = to || "admin@ighs.gov.bd";
        const sender = senderEmail || "ratulislam123@gmail.com";
        const mapUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "https://maps.google.com/?q=24.3636,88.6283";

        const htmlContent = `
          <!DOCTYPE html>
          <html>
          <body style="margin:0; padding:20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif; background:#f8fafc; color:#1e293b;">
            <div style="max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">
              <div style="background:#dc2626; padding:18px 24px; color:#ffffff;">
                <h2 style="margin:0; font-size:18px; font-weight:700;">🚨 [CRITICAL ALERT] Vehicle Collision Detected</h2>
                <p style="margin:4px 0 0 0; font-size:13px; opacity:0.9;">IGHS Autonomous Emergency Telemetry System</p>
              </div>
              <div style="padding:24px;">
                <table style="width:100%; border-collapse:collapse; font-size:14px;">
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:10px 0; color:#64748b; font-weight:600;">Vehicle Unit:</td>
                    <td style="padding:10px 0; font-weight:700; color:#0f172a; text-align:right;">${vehicleName || "Test Vehicle"}</td>
                  </tr>
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:10px 0; color:#64748b; font-weight:600;">Safety Status:</td>
                    <td style="padding:10px 0; font-weight:700; color:#dc2626; text-align:right;">DANGER (Emergency Brake Engaged)</td>
                  </tr>
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:10px 0; color:#64748b; font-weight:600;">Obstacle Distance:</td>
                    <td style="padding:10px 0; font-weight:700; color:#0f172a; text-align:right;">${distance ? distance + " cm" : (severity || "Under 15 cm")}</td>
                  </tr>
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:10px 0; color:#64748b; font-weight:600;">Location:</td>
                    <td style="padding:10px 0; font-weight:600; color:#0f172a; text-align:right;">RUET Campus, Rajshahi</td>
                  </tr>
                  <tr>
                    <td style="padding:10px 0; color:#64748b; font-weight:600;">GPS Coordinates:</td>
                    <td style="padding:10px 0; font-family:monospace; color:#0f172a; text-align:right;">${lat || 24.3636}, ${lng || 88.6283}</td>
                  </tr>
                </table>

                <div style="margin-top:24px; text-align:center;">
                  <a href="${mapUrl}" target="_blank" style="display:inline-block; background:#0f172a; color:#ffffff; text-decoration:none; padding:12px 24px; font-size:14px; font-weight:600; border-radius:8px;">
                    📍 View Live Location in Google Maps ↗
                  </a>
                </div>
              </div>
              <div style="background:#f8fafc; padding:12px 24px; border-top:1px solid #e2e8f0; font-size:11.5px; color:#94a3b8; text-align:center;">
                Dispatched automatically via IGHS Cloud Gateway & Brevo SMTP Relay.
              </div>
            </div>
          </body>
          </html>
        `;

        console.log("\n" + "═".repeat(60));
        console.log(`📧 [BREVO SMTP DISPATCH] ➔ To: ${recipientEmail}`);
        console.log(`  🚗 Vehicle:  ${vehicleName || "Test Vehicle"}`);
        console.log(`  📍 Map Link: ${mapUrl}`);
        console.log("═".repeat(60));

        let nodemailer;
        try { nodemailer = require("nodemailer"); } catch (e) {}

        if (nodemailer && BREVO_PASS) {
          const transporter = nodemailer.createTransport({
            host: "smtp-relay.brevo.com",
            port: 587,
            secure: false,
            auth: {
              user: BREVO_USER,
              pass: BREVO_PASS
            }
          });

          const info = await transporter.sendMail({
            from: `"IGHS Safety Dispatch" <${sender}>`,
            to: recipientEmail,
            subject: `Incident Report: Obstacle detected for ${vehicleName || "Vehicle"} near RUET`,
            html: htmlContent
          });

          console.log("📬 Brevo SMTP Success:", info.messageId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, provider: "brevo_smtp", messageId: info.messageId }));
          return;
        }

        // Fallback to Brevo REST API
        const https = require("https");
        const brevoEmailPayload = JSON.stringify({
          sender: { name: "IGHS Emergency System", email: sender },
          to: [{ email: recipientEmail, name: "Emergency Contact" }],
          subject: `🚨 [CRITICAL ALERT] Vehicle Crash Detected at RUET (${vehicleName || "Test Vehicle"})`,
          htmlContent: htmlContent
        });

        const brevoReq = https.request({
          hostname: "api.brevo.com",
          port: 443,
          path: "/v3/smtp/email",
          method: "POST",
          headers: {
            "accept": "application/json",
            "api-key": BREVO_KEY,
            "content-type": "application/json",
            "Content-Length": Buffer.byteLength(brevoEmailPayload)
          }
        }, (brevoRes) => {
          let resData = "";
          brevoRes.on("data", chunk => { resData += chunk; });
          brevoRes.on("end", () => {
            const isSuccess = brevoRes.statusCode >= 200 && brevoRes.statusCode < 300;
            res.writeHead(isSuccess ? 200 : brevoRes.statusCode || 500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: isSuccess, provider: "brevo_api", to: recipientEmail }));
          });
        });

        brevoReq.on("error", (e) => {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: e.message }));
        });

        brevoReq.write(brevoEmailPayload);
        brevoReq.end();

      } catch (err) {
        console.error("[/email] Error:", err.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid email payload: " + err.message }));
      }
    });
    return;
  }

  // ===========================================================================
  // ROUTE: POST /register-email — Dispatch Vehicle Registration Confirmation
  // ===========================================================================
  if (req.method === "POST" && pathname === "/register-email") {
    let body = "";
    req.on("data", chunk => { body += chunk.toString(); });
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const { to, senderEmail, vehicleName, vehicleId, locationName, lat, lng } = data;

        if (!to) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing recipient email" }));
          return;
        }

        const sender = senderEmail || "ratulislam123@gmail.com";
        const mapUrl = (lat && lng) ? `https://maps.google.com/?q=${lat},${lng}` : "https://maps.google.com/?q=24.3636,88.6283";

        const htmlContent = `
          <!DOCTYPE html>
          <html>
          <body style="margin:0; padding:20px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif; background:#f8fafc; color:#1e293b;">
            <div style="max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; overflow:hidden; box-shadow:0 4px 6px -1px rgba(0,0,0,0.1);">
              <div style="background:#0f172a; padding:20px 24px; color:#ffffff;">
                <h2 style="margin:0; font-size:18px; font-weight:700;">🚗 Vehicle Registration Confirmed</h2>
                <p style="margin:4px 0 0 0; font-size:13px; color:#94a3b8;">IGHS Autonomous Telemetry & Safety Platform</p>
              </div>
              <div style="padding:24px;">
                <p style="margin:0 0 16px 0; font-size:14px; color:#334155;">
                  Your vehicle <strong>${vehicleName || "Test Vehicle"}</strong> has been successfully registered and is now connected to live safety monitoring.
                </p>
                <table style="width:100%; border-collapse:collapse; font-size:13.5px; margin-bottom:20px;">
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:8px 0; color:#64748b; font-weight:600;">Vehicle Name:</td>
                    <td style="padding:8px 0; font-weight:700; color:#0f172a; text-align:right;">${vehicleName}</td>
                  </tr>
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:8px 0; color:#64748b; font-weight:600;">Hardware Device ID:</td>
                    <td style="padding:8px 0; font-family:monospace; color:#0f172a; text-align:right;"><code>${vehicleId || "esp32-ruet-01"}</code></td>
                  </tr>
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:8px 0; color:#64748b; font-weight:600;">Station / Location:</td>
                    <td style="padding:8px 0; color:#0f172a; text-align:right;">${locationName || "RUET Campus, Rajshahi"}</td>
                  </tr>
                  <tr style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:8px 0; color:#64748b; font-weight:600;">GPS Coordinates:</td>
                    <td style="padding:8px 0; font-family:monospace; color:#0f172a; text-align:right;">${lat || 24.3636}, ${lng || 88.6283}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0; color:#64748b; font-weight:600;">Laser Collision Shield:</td>
                    <td style="padding:8px 0; font-weight:700; color:#16a34a; text-align:right;">🟢 Active & Monitoring</td>
                  </tr>
                </table>

                <div style="text-align:center;">
                  <a href="${mapUrl}" target="_blank" style="display:inline-block; background:#2563eb; color:#ffffff; text-decoration:none; padding:11px 22px; font-size:13.5px; font-weight:600; border-radius:8px;">
                    📍 View Vehicle Location on Google Maps ↗
                  </a>
                </div>
              </div>
              <div style="background:#f8fafc; padding:12px 24px; border-top:1px solid #e2e8f0; font-size:11.5px; color:#94a3b8; text-align:center;">
                Connected to IGHS Telemetry Gateway • Rajshahi, Bangladesh
              </div>
            </div>
          </body>
          </html>
        `;

        let nodemailer;
        try { nodemailer = require("nodemailer"); } catch (e) {}

        if (nodemailer && BREVO_PASS) {
          const transporter = nodemailer.createTransport({
            host: "smtp-relay.brevo.com",
            port: 587,
            secure: false,
            auth: {
              user: BREVO_USER,
              pass: BREVO_PASS
            }
          });

          const info = await transporter.sendMail({
            from: `"IGHS Telemetry Network" <${sender}>`,
            to: to,
            subject: `IGHS Telemetry: Unit ${vehicleId || "Unit"} (${vehicleName}) is active`,
            html: htmlContent
          });

          console.log("📬 Brevo Registration Email Sent via SMTP:", info.messageId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, to: to, messageId: info.messageId }));
          return;
        }

      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Registration email error: " + err.message }));
      }
    });
    return;
  }

  // ===========================================================================
  // ROUTE: GET /sms-log — View all captured SMS in browser
  // Open http://localhost:3000/sms-log to see all "sent" SMS during testing
  // ===========================================================================
  if (req.method === "GET" && pathname === "/sms-log") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const rows = smsLog.length === 0
      ? "<tr><td colspan='5' style='text-align:center;color:#888;padding:20px'>No SMS captured yet. Trigger an accident to test.</td></tr>"
      : smsLog.map(s => `
          <tr>
            <td>${s.timestamp}</td>
            <td><code>${s.to}</code></td>
            <td>${s.vehicleName}</td>
            <td>${s.accidentId}</td>
            <td style="font-size:12px;max-width:300px;word-break:break-word">${s.message}</td>
          </tr>
        `).join("");

    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SMS Mock Log — IGHS Dev</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; }
    h1 { color: #5B4FE9; margin-bottom: 8px; }
    p  { color: #666; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    th { background: #5B4FE9; color: white; padding: 12px 16px; text-align: left; font-size: 13px; }
    td { padding: 12px 16px; border-bottom: 1px solid #eee; font-size: 13px; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #f9f9ff; }
    code { background: #ede9ff; color: #3D35C8; padding: 2px 6px; border-radius: 4px; }
    .refresh { background: #5B4FE9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; margin-bottom: 16px; }
    .badge { display: inline-block; background: #fef3c7; color: #92400e; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; margin-left: 8px; }
  </style>
</head>
<body>
  <h1>📱 SMS Mock Log <span class="badge">LOCAL DEV</span></h1>
  <p>
    These are SMS messages that would be sent in production via SSL Wireless.<br>
    No real SMS was sent. This page auto-shows all accident alerts captured during this session.<br>
    <strong>Total captured: ${smsLog.length}</strong>
  </p>
  <button class="refresh" onclick="location.reload()">🔄 Refresh</button>
  <table>
    <thead>
      <tr>
        <th>Timestamp</th>
        <th>To (Phone)</th>
        <th>Vehicle</th>
        <th>Accident ID</th>
        <th>Message</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
    return;
  }

  // ===========================================================================
  // ROUTE: GET /test-accident — Manually trigger a fake accident for testing
  // Open http://localhost:3000/test-accident in your browser to simulate
  // what happens when ESP32 detects an impact.
  // ===========================================================================
  if (req.method === "GET" && pathname === "/test-accident") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test Accident Trigger — IGHS Dev</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #f5f5f5; }
    h1 { color: #DC2626; margin-bottom: 8px; }
    p  { color: #666; margin-bottom: 24px; }
    .card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); max-width: 500px; }
    label { display: block; font-size: 13px; font-weight: 600; color: #333; margin-bottom: 4px; margin-top: 16px; }
    input, select { width: 100%; padding: 10px 12px; border: 1.5px solid #ddd; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
    input:focus, select:focus { border-color: #5B4FE9; outline: none; }
    button { margin-top: 20px; width: 100%; background: #DC2626; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
    button:hover { background: #b91c1c; }
    #result { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px; display: none; }
    .success { background: #dcfce7; color: #166534; border: 1px solid #86efac; }
    .error   { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
    .note { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 12px; font-size: 13px; color: #92400e; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>🚨 Test Accident Trigger</h1>
  <div class="note">
    ⚠️ This page simulates what the ESP32 does when it detects an impact.
    It writes a fake accident document to Firestore, which your dashboard will detect
    and attempt to send an SMS via the local mock server.
  </div>
  <div class="card">
    <p>Fill in the details and click "Simulate Accident" to test the full pipeline.</p>

    <label for="vehicle">Vehicle Name</label>
    <input id="vehicle" type="text" value="Truck-01" />

    <label for="lat">Latitude (BD)</label>
    <input id="lat" type="number" step="0.0001" value="23.8103" />

    <label for="lng">Longitude (BD)</label>
    <input id="lng" type="number" step="0.0001" value="90.4125" />

    <label for="severity">Severity</label>
    <select id="severity">
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high" selected>High</option>
    </select>

    <button onclick="triggerAccident()">🚨 Simulate Accident</button>
    <div id="result"></div>
  </div>

  <script type="module">
    // Import Firebase to write directly to Firestore
    import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
    import { getFirestore, doc, setDoc, serverTimestamp }
      from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";

    // Paste your config here (same as firebase-config.js)
    const firebaseConfig = {
      apiKey:            "AIzaSyBdf5770e_1JVaotE6pHAuoZlPVCzdsI8c",
      authDomain:        "ighs-9a0f1.firebaseapp.com",
      projectId:         "ighs-9a0f1",
      storageBucket:     "ighs-9a0f1.firebasestorage.app",
      messagingSenderId: "714269115464",
      appId:             "1:714269115464:web:9fb386256f2c7b3c7e047d"
    };

    const app = initializeApp(firebaseConfig, "test-trigger");
    const db  = getFirestore(app);

    window.triggerAccident = async () => {
      const btn      = document.querySelector("button");
      const resultEl = document.getElementById("result");
      const vehicle  = document.getElementById("vehicle").value || "Truck-01";
      const lat      = parseFloat(document.getElementById("lat").value);
      const lng      = parseFloat(document.getElementById("lng").value);
      const severity = document.getElementById("severity").value;

      btn.disabled    = true;
      btn.textContent = "Writing to Firestore…";
      resultEl.style.display = "none";

      try {
        const accidentId = "test_" + Date.now();
        await setDoc(doc(db, "accidents", accidentId), {
          vehicleId:   "test-vehicle-01",
          vehicleName: vehicle,
          lat,
          lng,
          severity,
          smsSent:     false,
          smsTo:       "01711000000",
          timestamp:   serverTimestamp()
        });

        resultEl.className    = "result success";
        resultEl.style.display = "block";
        resultEl.innerHTML = [
          "<strong>✅ Accident written to Firestore!</strong><br>",
          "Document ID: <code>" + accidentId + "</code><br>",
          "Your dashboard (if open and logged in) should now show an accident alert<br>",
          "and call the local <code>POST /sms</code> mock endpoint.<br><br>",
          "<a href='/sms-log' target='_blank'>📋 View SMS Log →</a>"
        ].join("");

      } catch (err) {
        resultEl.className    = "result error";
        resultEl.style.display = "block";
        resultEl.innerHTML    = "<strong>❌ Error:</strong> " + err.message +
          "<br><small>Make sure you are signed in on the dashboard tab first (Firestore rules require auth).</small>";
      } finally {
        btn.disabled    = false;
        btn.textContent = "🚨 Simulate Accident";
      }
    };
  </script>
</body>
</html>`);
    return;
  }

  // ===========================================================================
  // ROUTE: Static file server — serves all other files (index.html, etc.)
  // ===========================================================================
  let filePath = path.join(STATIC_DIR, pathname === "/" ? "index.html" : pathname);

  // Security: prevent directory traversal attacks
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end("403 Forbidden");
    return;
  }

  const ext      = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        // File not found → serve index.html (SPA fallback)
        fs.readFile(path.join(STATIC_DIR, "index.html"), (err2, indexData) => {
          if (err2) {
            res.writeHead(404);
            res.end("404 Not Found");
          } else {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(indexData);
          }
        });
      } else {
        res.writeHead(500);
        res.end("500 Internal Server Error");
      }
      return;
    }

    res.writeHead(200, { "Content-Type": mimeType });
    res.end(data);
  });
});

// =============================================================================
// START
// =============================================================================
server.listen(PORT, () => {
  console.log("\n" + "═".repeat(60));
  console.log("  🚀 IGHS Dev Server — Running!");
  console.log("═".repeat(60));
  console.log(`\n  📱 Dashboard:        http://localhost:${PORT}`);
  console.log(`  🚨 Simulate accident: http://localhost:${PORT}/test-accident`);
  console.log(`  📋 SMS log viewer:    http://localhost:${PORT}/sms-log`);
  console.log(`  📮 Mock SMS endpoint: POST http://localhost:${PORT}/sms`);
  console.log("\n  All SMS alerts will be logged here (no real SMS sent).");
  console.log("  Press Ctrl+C to stop.\n");
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Try: set PORT=3001 && node server.js\n`);
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});
