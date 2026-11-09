import fs from "fs";
import path from "path";
import axios from "axios";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();

const FASTAPI_WEBHOOK_URL =
  process.env.FASTAPI_WEBHOOK_URL || "http://127.0.0.1:8000/api/v1/webhook/incoming";
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || "./downloads";

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

export async function handleIncomingMessage(sock, { messages, type }) {
  console.log(`[WA EVENT]: Type: ${type}, Total Messages: ${messages?.length}`);

  if (!messages || messages.length === 0) return;

  const msg = messages[0];
  console.log("[RAW MESSAGE KEY]:", JSON.stringify(msg.key));
  console.log("[RAW MESSAGE BODY]:", JSON.stringify(msg.message));
  if (!msg.message) return;

  const remoteJid = msg.key.remoteJid;
  if (remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) {
    return; // Individual chats ko process karein
  }

  const messageId = msg.key.id;
  const isFromMe = Boolean(msg.key.fromMe);

  // Self-Chat detection ("Message Yourself")
  const myPhoneNumber = sock.user.id.split(":")[0];
  const senderNumber = remoteJid.split("@")[0];
  const isSelfChat = senderNumber === myPhoneNumber;

  const pushName = msg.pushName || (isSelfChat ? "Self" : "Contact");
  const timestamp = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000);

  let messageText = "";
  let mediaType = null;
  let mediaDiskPath = null;
  const msgContent = msg.message;

  // 1. Text Message
  if (msgContent.conversation) {
    messageText = msgContent.conversation;
  } else if (msgContent.extendedTextMessage?.text) {
    messageText = msgContent.extendedTextMessage.text;
  }
  // 2. Image Message (Receipts / Invoices)
  else if (msgContent.imageMessage) {
    mediaType = "image";
    messageText = msgContent.imageMessage.caption || "";
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: pino({ level: "silent" }) }
      );
      const fileName = `img_${messageId}.jpg`;
      mediaDiskPath = path.resolve(DOWNLOAD_DIR, fileName);
      fs.writeFileSync(mediaDiskPath, buffer);
      console.log(`📸 [Media Saved]: Image -> ${mediaDiskPath}`);
    } catch (err) {
      console.error("[Media Error]: Image download failed:", err.message);
    }
  }
  // 3. Audio / Voice Note Message
  else if (msgContent.audioMessage) {
    mediaType = "audio";
    try {
      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        { logger: pino({ level: "silent" }) }
      );
      const isVoiceNote = Boolean(msgContent.audioMessage.ptt);
      const ext = isVoiceNote ? "ogg" : "mp3";
      const fileName = `audio_${messageId}.${ext}`;
      mediaDiskPath = path.resolve(DOWNLOAD_DIR, fileName);
      fs.writeFileSync(mediaDiskPath, buffer);
      console.log(`🎙️ [Media Saved]: Voice Note -> ${mediaDiskPath}`);
    } catch (err) {
      console.error("[Media Error]: Audio download failed:", err.message);
    }
  }

  if (!messageText && !mediaDiskPath) return;

  // FastAPI ko payload forward karna
  const payload = {
    message_id: messageId,
    sender_jid: remoteJid,
    sender_name: pushName,
    text: messageText,
    media_type: mediaType,
    media_path: mediaDiskPath,
    is_from_me: isFromMe,
    is_self_chat: isSelfChat,
    timestamp: timestamp,
  };

  try {
    const response = await axios.post(FASTAPI_WEBHOOK_URL, payload, { timeout: 10000 });
    console.log(`🚀 [Webhook Sent]: ${messageId} | Status: ${response.data.status}`);
  } catch (err) {
    console.error(`❌ [Webhook Error]: ${err.message}`);
  }
}