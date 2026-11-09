import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } from "@whiskeysockets/baileys";
  import pino from "pino";
  import { handleIncomingMessage } from "./handlers/message_handler.js";
  
  let sock = null;
  let currentQR = null; // Browser endpoint ke liye QR string memory me save hogi
  
  export function getCurrentQR() {
    return currentQR;
  }
  
  export async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const { version, isLatest } = await fetchLatestBaileysVersion();
  
    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }), // Terminal clean rakhne ke liye silent logger
      printQRInTerminal: false,          // Terminal par QR print bilkul band
      generateHighQualityLinkPreview: true,
    });
  
    sock.ev.on("creds.update", saveCreds);
  
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
  
      // Jab WhatsApp naya QR code generate kare
      if (qr) {
        currentQR = qr;
        console.log("👉 Naya QR generate ho gaya! Browser me open karein: http://localhost:5000/qr");
      }
  
      if (connection === "close") {
        currentQR = null;
        const shouldReconnect =
          lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        
        console.log("Connection closed, reconnecting:", shouldReconnect);
        if (shouldReconnect) {
          connectToWhatsApp();
        }
      } else if (connection === "open") {
        currentQR = null; // Login hone ke baad QR clear
        console.log("✅ WhatsApp connection successfully opened!");
        console.log(`Connected JID: ${sock.user?.id}`);
      }
    });
  
    sock.ev.on("messages.upsert", async (m) => {
      await handleIncomingMessage(sock, m);
    });
  
    return sock;
  }
  
  export function getSocket() {
    return sock;
  }