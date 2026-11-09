import express from "express";
import dotenv from "dotenv";
import QRCode from "qrcode";
import { connectToWhatsApp, getSocket, getCurrentQR } from "./wa_client.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json());

// 1. Browser QR Display Endpoint
app.get("/qr", async (req, res) => {
  const sock = getSocket();
  const isConnected = Boolean(sock?.user);

  // Case A: WhatsApp already login hai
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>WhatsApp Status</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 40px; border-radius: 16px; text-align: center; box-shadow: 0 10px 25px rgba(0,0,0,0.5); border: 1px solid #334155; }
          .badge { background: #22c55e; color: #052e16; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 14px; display: inline-block; margin-bottom: 15px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge">CONNECTED</div>
          <h2>WhatsApp is Active!</h2>
          <p style="color: #94a3b8;">User ID: <strong>${sock.user.id}</strong></p>
        </div>
      </body>
      </html>
    `);
  }

  const qr = getCurrentQR();

  // Case B: Abhi QR generate nahi hua
  if (!qr) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="refresh" content="3">
        <title>Waiting for QR</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 40px; border-radius: 16px; text-align: center; border: 1px solid #334155; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Initializing WhatsApp Session...</h2>
          <p style="color: #94a3b8;">Page auto-refresh ho raha hai, kripya 2-3 second rukiye...</p>
        </div>
      </body>
      </html>
    `);
  }

  // Case C: QR available hai -> Image render karna
  try {
    const qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta http-equiv="refresh" content="20">
        <title>Scan WhatsApp QR</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 35px; border-radius: 20px; text-align: center; box-shadow: 0 15px 35px rgba(0,0,0,0.5); border: 1px solid #334155; max-width: 360px; }
          h2 { margin-top: 0; color: #38bdf8; }
          .qr-box { background: #ffffff; padding: 15px; border-radius: 12px; display: inline-block; margin: 15px 0; }
          p { color: #94a3b8; font-size: 14px; margin-bottom: 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Link WhatsApp</h2>
          <p>WhatsApp open karein &rarr; Linked Devices &rarr; Scan karein</p>
          <div class="qr-box">
            <img src="${qrImage}" alt="WhatsApp QR Code" style="display:block;" />
          </div>
          <p>⏱️ QR expire hone par page automatically refresh ho jayega.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    return res.status(500).send("QR image render karne me error aaya.");
  }
});

// 2. Emoji Reaction Endpoint (FastAPI se call hota hai)
app.post("/api/reaction", async (req, res) => {
  const { message_id, remote_jid, emoji } = req.body;
  const sock = getSocket();
  if (!sock) return res.status(503).json({ error: "Socket not ready" });

  try {
    await sock.sendMessage(remote_jid, {
      react: {
        text: emoji,
        key: {
          id: message_id,
          remoteJid: remote_jid,
          fromMe: remote_jid.includes(sock.user?.id.split(":")[0]),
        },
      },
    });
    return res.json({ status: "reaction_sent" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


app.get("/sync-status", (req, res) => {
  res.json({
    connected: isConnected,
    isSyncing: isSyncing,
    historyCompleted: historyCompleted,
    totalProcessed: totalProcessed
  });
});

// 3. WhatsApp Message Send Endpoint (FastAPI reply deliver karta hai)
app.post("/api/send", async (req, res) => {
  const { remote_jid, text } = req.body;
  const sock = getSocket();
  if (!sock) return res.status(503).json({ error: "Socket not ready" });

  try {
    const result = await sock.sendMessage(remote_jid, { text });
    return res.json({ status: "message_sent", id: result.key.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[WA Worker]: Running on port ${PORT}`);
  await connectToWhatsApp();
});