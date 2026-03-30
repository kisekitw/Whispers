import express from "express";
import session from "express-session";
import fs from "fs";
import path from "path";
import { initializeApp, getApps } from "firebase/app";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, query, orderBy, limit, Firestore } from "firebase/firestore";
import axios from "axios";
import { GoogleGenAI, HarmCategory, HarmBlockThreshold } from "@google/genai";
import dotenv from "dotenv";
import { createAdminRouter } from "./admin-routes";

// Error handling for silent crashes
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] UNCAUGHT EXCEPTION:`, err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error(`[${new Date().toISOString()}] UNHANDLED REJECTION at:`, promise, "reason:", reason);
});

dotenv.config();

// Lazy initialization for Firebase
let dbInstance: Firestore | null = null;
function getDb() {
  if (!dbInstance) {
    try {
      console.log("[INIT] Initializing Firebase...");
      const configPath = path.join(process.cwd(), "firebase-applet-config.json");
      if (!fs.existsSync(configPath)) {
        throw new Error("firebase-applet-config.json not found");
      }
      const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      const dbInfo = `[INIT] Firebase Config loaded, Project ID: ${firebaseConfig.projectId}, Database ID: ${firebaseConfig.firestoreDatabaseId || "(default)"}\n`;
      console.log(dbInfo);
      try {
        fs.appendFileSync(path.join(process.cwd(), "server_start.txt"), dbInfo);
      } catch (e) {}
      
      const apps = getApps();
      const app = apps.length === 0 ? initializeApp(firebaseConfig) : apps[0];
      
      console.log("[INIT] Getting Firestore instance...");
      dbInstance = firebaseConfig.firestoreDatabaseId 
        ? getFirestore(app, firebaseConfig.firestoreDatabaseId) 
        : getFirestore(app);
      console.log("[INIT] Firestore instance created successfully for DB:", firebaseConfig.firestoreDatabaseId || "(default)");
    } catch (error) {
      console.error("FATAL ERROR IN getDb:", error);
      throw error;
    }
  }
  return dbInstance;
}

// Lazy initialization for Gemini
let genAIInstance: GoogleGenAI | null = null;
function getGenAI() {
  if (!genAIInstance) {
    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    const keyStatus = apiKey ? `Present (starts with ${apiKey.substring(0, 4)}...)` : "Missing";
    console.log(`[DEBUG] getGenAI - Key Status: ${keyStatus}`);
    
    // Write to a debug file we can read
    try {
      fs.appendFileSync(path.join(process.cwd(), "debug_genai.txt"), 
        `[${new Date().toISOString()}] Key Status: ${keyStatus}, APP_URL: ${process.env.APP_URL}\n`);
    } catch (e) {}

    if (!apiKey) {
      console.error("FATAL: GEMINI_API_KEY and API_KEY are missing from environment!");
      throw new Error("GEMINI_API_KEY_MISSING");
    }
    genAIInstance = new GoogleGenAI({ apiKey });
  }
  return genAIInstance;
}

// --- Environment Variable Check ---
const startupLog = `[${new Date().toISOString()}] Server starting...
GEMINI_API_KEY: ${process.env.GEMINI_API_KEY ? "Present" : "Missing"}
API_KEY: ${process.env.API_KEY ? "Present" : "Missing"}
LINE_CHANNEL_ID: ${process.env.LINE_CHANNEL_ID ? "Present" : "Missing"}
LINE_CHANNEL_SECRET: ${process.env.LINE_CHANNEL_SECRET ? "Present" : "Missing"}
LINE_CHANNEL_ACCESS_TOKEN: ${process.env.LINE_CHANNEL_ACCESS_TOKEN ? "Present" : "Missing"}
`;
console.log(startupLog);
try {
  fs.writeFileSync(path.join(process.cwd(), "server_start.txt"), startupLog);
} catch (e) {}

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.set("trust proxy", true);

// Global body parsers - moved to top for all routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session middleware (required before admin routes)
app.use(session({
  secret: process.env.ADMIN_SESSION_SECRET || "whispers-admin-secret-please-set-env",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  },
}));

// Admin routes — AdminLTE dashboard replaces the React SPA
app.use("/admin", createAdminRouter(getDb));

// Root serves the React landing page (handled by Vite in dev, static in prod)

// Global request logger
app.use((req, res, next) => {
  // Prevent trailing slash redirects for webhook
  if (req.url === '/api/webhook/') {
    req.url = '/api/webhook';
  }
  
  const originalRedirect = res.redirect.bind(res);
  res.redirect = function(...args: any[]) {
    console.log(`[${new Date().toISOString()}] REDIRECTING to ${args[0]}`);
    return originalRedirect(...args);
  } as any;
  
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - Host: ${req.headers.host} - Proto: ${req.headers["x-forwarded-proto"]} - Body: ${JSON.stringify(req.body).substring(0, 100)}`);
  next();
});

// --- Webhook Route (Top priority, explicit methods) ---
app.post("/api/webhook", async (req, res) => {
  console.log(`[${new Date().toISOString()}] Webhook POST received. Body:`, JSON.stringify(req.body));
  try {
    const events = req.body.events || [];
    if (events.length === 0) {
      console.log("Empty events array (Verify request)");
      return res.status(200).json({ status: "ok" });
    }

    for (const event of events) {
      try {
        await handleLineEvent(event);
      } catch (e) {
        console.error("Error handling event:", e);
      }
    }
    return res.status(200).json({ status: "ok" });
  } catch (error) {
    console.error("Critical Webhook Error:", error);
    return res.status(200).json({ status: "ok" });
  }
});

app.get("/api/webhook", (req, res) => {
  console.log(`[${new Date().toISOString()}] Webhook GET received`);
  res.status(200).send("Webhook endpoint is active. Use POST for LINE events.");
});

app.options("/api/webhook", (req, res) => {
  res.status(200).end();
});

app.get("/health", (req, res) => res.status(200).send("OK"));
app.get("/ping", (req, res) => res.status(200).json({ status: "alive", time: new Date().toISOString() }));

const LINE_CHANNEL_ID = process.env.LINE_CHANNEL_ID?.trim();
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET?.trim();
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN?.trim();

console.log(`[INIT] LINE_CHANNEL_ID: ${LINE_CHANNEL_ID ? "Set" : "Missing"}`);
console.log(`[INIT] LINE_CHANNEL_SECRET: ${LINE_CHANNEL_SECRET ? "Set" : "Missing"}`);
console.log(`[INIT] LINE_CHANNEL_ACCESS_TOKEN: ${LINE_CHANNEL_ACCESS_TOKEN ? "Set" : "Missing"}`);

async function handleLineEvent(event: any) {
  console.log("Processing event:", event.type);
  const userId = event.source?.userId;
  if (!userId) return;

  const today = new Date().toISOString().split("T")[0];
  const db = getDb();

  // Debug log for webhook entry
  try {
    await addDoc(collection(db, "logs"), {
      timestamp: new Date().toISOString(),
      userId,
      action: "WEBHOOK_ENTRY",
      status: "info"
    });
  } catch (e) {
    console.error("Immediate log failed:", e);
  }

  // Ensure user exists
  let userDoc = await getDoc(doc(db, "users", userId));
  let userData = userDoc.data();

  if (!userData) {
    console.log("Creating new user:", userId);
    let displayName = "用戶";
    try {
      const profileRes = await axios.get(`https://api.line.me/v2/bot/profile/${userId}`, {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
      });
      displayName = profileRes.data.displayName || "用戶";
    } catch (e) {
      console.error("Error fetching LINE profile:", e);
    }

    userData = {
      userId,
      userType: "", // To be set by user
      plan: "free",
      usageToday: 0,
      usageResetDate: today,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      displayName,
    };
    await setDoc(doc(db, "users", userId), userData);
  } else {
    // Check for usage reset
    if (userData.usageResetDate !== today) {
      console.log("Resetting usage for user:", userId);
      userData.usageToday = 0;
      userData.usageResetDate = today;
      await updateDoc(doc(db, "users", userId), {
        usageToday: 0,
        usageResetDate: today,
        lastActiveAt: new Date().toISOString(),
      });
    } else {
      await updateDoc(doc(db, "users", userId), {
        lastActiveAt: new Date().toISOString(),
      });
    }
  }

  if (event.type === "follow") {
    await sendFollowMessage(userId, userData.userType);
  } else if (event.type === "message" && event.message.type === "text") {
    await handleTextMessage(userId, userData, event.message.text.trim(), event.replyToken);
  } else if (event.type === "postback") {
    await handlePostback(userId, userData, event.postback.data, event.replyToken);
  }
}

async function sendFollowMessage(userId: string, userType: string) {
  if (!userType) {
    await pushMessage(userId, "👋 嗨！歡迎使用親師悄悄話！\n\n請問你是：");
    await sendResponse(userId, null, "選擇你的身份：", [
      { label: "👩‍🏫 我是老師", data: "action=SET_TYPE&value=teacher" },
      { label: "👨‍👩‍👧 我是家長", data: "action=SET_TYPE&value=parent" }
    ]);
  } else {
    await replyMainMenu(userId, userType);
  }
}


async function handleTextMessage(userId: string, user: any, text: string, replyToken: string) {
  console.log(`Handling text message from ${userId}: ${text}`);
  
  // If user hasn't set their type yet, force them to choose
  if (!user.userType) {
    await sendResponse(userId, replyToken, "👋 嗨！歡迎使用親師悄悄話！\n\n請問你是：", [
      { label: "👩‍🏫 我是老師", data: "action=SET_TYPE&value=teacher" },
      { label: "👨‍👩‍👧 我是家長", data: "action=SET_TYPE&value=parent" }
    ]);
    return;
  }

  // Simple routing for now
  if (["主選單", "回主選單", "選單", "menu"].includes(text.toLowerCase())) {
    await updateDoc(doc(getDb(), "users", userId), { userState: null });
    await replyMainMenu(userId, user.userType, replyToken);
  } else if (["切換身分", "切換身份", "switch"].includes(text.toLowerCase())) {
    await updateDoc(doc(getDb(), "users", userId), { userState: null });
    await sendResponse(userId, replyToken, "請選擇您的新身份：", [
      { label: "👩‍🏫 我是老師", data: "action=SET_TYPE&value=teacher" },
      { label: "👨‍👩‍👧 我是家長", data: "action=SET_TYPE&value=parent" }
    ]);
  } else if (user.userState) {
    await handleStateMessage(userId, user, text, replyToken);
  } else {
    // Handle state-based conversation or generic reply
    await replyText(userId, replyToken, "請點選選單功能或輸入「主選單」開始。");
  }
}

async function sendStyleComplete(userId: string, replyToken: string | null, style: any) {
  const avoidDisplay = (style.avoidWords || []).length > 0
    ? style.avoidWords.join("、")
    : "無";
  await sendResponse(
    userId,
    replyToken,
    `🎉 溝通風格已儲存！\n\n` +
    `班級：${style.className || "未設定"}\n` +
    `開場白：${style.opening || "未設定"}\n` +
    `避免詞語：${avoidDisplay}\n\n` +
    `之後每次生成的內容，AI 都會自動套用你的風格 ✨`,
    [{ label: "🏠 回主選單", data: "action=BACK_MENU" }]
  );
}

async function handleStateMessage(userId: string, user: any, text: string, replyToken: string) {
  // ── 風格設定精靈（無 AI、無 loading）──────────────────────
  if (user.userState === "AWAITING_STYLE_CLASSNAME") {
    const style = user.styleJson ? JSON.parse(user.styleJson) : {};
    style.className = text.trim();
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_STYLE_OPENING",
      styleJson: JSON.stringify(style),
    });
    const step2Buttons = style.opening
      ? [{ label: "⏭️ 保留現有開場白", data: "action=STYLE_SKIP_OPENING" }]
      : [];
    await sendResponse(
      userId,
      replyToken,
      `✅ 班級：${style.className}\n\n第 2 步：你的慣用開場白是？\n（例如：各位家長您好、親愛的家長您好）`,
      step2Buttons
    );
    return;
  }

  if (user.userState === "AWAITING_STYLE_OPENING") {
    const style = user.styleJson ? JSON.parse(user.styleJson) : {};
    style.opening = text.trim();
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_STYLE_AVOID",
      styleJson: JSON.stringify(style),
    });
    await sendResponse(
      userId,
      replyToken,
      `✅ 開場白：「${style.opening}」\n\n第 3 步：有沒有你不想出現在文字裡的詞語？\n（例如：麻煩家長、請務必）\n\n多個詞以逗號分隔，也可以直接跳過。`,
      [{ label: "⏭️ 跳過這步", data: "action=STYLE_SKIP_AVOID" }]
    );
    return;
  }

  if (user.userState === "AWAITING_STYLE_AVOID") {
    const style = user.styleJson ? JSON.parse(user.styleJson) : {};
    style.avoidWords = text
      .split(/[，,、\s]+/)
      .map((w: string) => w.trim())
      .filter((w: string) => w.length > 0);
    await updateDoc(doc(getDb(), "users", userId), {
      userState: null,
      styleJson: JSON.stringify(style),
    });
    await sendStyleComplete(userId, replyToken, style);
    return;
  }
  // ─────────────────────────────────────────────────────────

  try {
    // 1. Start loading animation (doesn't use replyToken)
    await startLoadingAnimation(userId);
    
    // 2. Try to push "writing" message (doesn't use replyToken)
    // If push fails, we ignore it to ensure the final reply still works
    await pushMessage(userId, "🔍 正在為您撰寫內容，請稍候...");
    
    let type = "";
    if (user.userState === "AWAITING_NOTIFY_INPUT") type = "notify";
    else if (user.userState === "AWAITING_REPLY_INPUT") type = "reply";
    else if (user.userState === "AWAITING_CONFLICT_INPUT") type = "conflict";
    else if (user.userState === "AWAITING_PARENT_INPUT") type = "parent_daily";
    else if (user.userState === "AWAITING_PARENT_URGENT_INPUT") type = "parent_urgent";
    else if (user.userState === "AWAITING_PARENT_REPAIR_INPUT") type = "parent_repair";

    const aiResponse = await generateAIContent(userId, user.userType, type, text);
    
    // Clear state after successful generation
    await updateDoc(doc(getDb(), "users", userId), { userState: null });
    
    // Use the PRECIOUS replyToken for the actual AI response
    const finalResponse = `[v2.1] ${aiResponse}`;
    await sendResponse(userId, replyToken, finalResponse, [
      { label: "🏠 回主選單", data: "action=BACK_MENU" }
    ]);
  } catch (error: any) {
    console.error("Error in handleStateMessage:", error);
    
    // Also clear state on error to prevent getting stuck
    await updateDoc(doc(getDb(), "users", userId), { userState: null });

    const logStatus = error.logStatus ? `\n(Log: ${error.logStatus})` : "";
    const errorMsg = error.message === "LIMIT_EXCEEDED" 
      ? "❌ 抱歉，您今天的免費額度（3次）已用完。請明天再試，或升級方案！"
      : error.message === "AI_TIMEOUT"
      ? "⏳ 抱歉，AI 回應超時了（可能因為內容過長或網路不穩），請再試一次！"
      : error.message === "AI_BLOCKED"
      ? "🛡️ 抱歉，AI 認為內容包含敏感詞彙（如喪假、衝突等）而拒絕回答，請嘗試更換措辭。"
      : error.message === "AI_EMPTY_RESPONSE"
      ? "📭 抱歉，AI 產生了空回應，請再試一次。"
      : error.message === "GEMINI_API_KEY_MISSING"
      ? "🔑 系統設定錯誤：遺失 AI 金鑰，請聯繫管理員。"
      : `抱歉，生成內容時發生錯誤 [v2.1: ${error.message.substring(0, 30)}]，請稍後再試。`;

    // Use sendResponse for consistency
    await sendResponse(userId, replyToken, errorMsg + logStatus);
  }
}

async function handlePostback(userId: string, user: any, data: string, replyToken: string) {
  console.log(`Handling postback from ${userId}: ${data}`);
  const params = new URLSearchParams(data);
  const action = params.get("action");

  try {
    if (action === "SET_TYPE") {
      const type = params.get("value");
      await updateDoc(doc(getDb(), "users", userId), { userType: type, userState: null });
      await replyText(userId, replyToken, type === "teacher" ? "✅ 已設定為老師版！" : "✅ 已設定為家長版！");
      // Use push for menu after replyToken is used
      await replyMainMenu(userId, type!);
    } else if (action === "BACK_MENU") {
      await updateDoc(doc(getDb(), "users", userId), { userState: null });
      await replyMainMenu(userId, user.userType, replyToken);
    } else if (action === "MENU_NOTIFY") {
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_NOTIFY_INPUT" });
      await replyText(userId, replyToken, "📢 請輸入通知重點內容（例如：下週三故宮、帶便當、穿運動服）：");
    } else if (action === "MENU_REPLY") {
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_REPLY_INPUT" });
      await replyText(userId, replyToken, "💬 請貼上家長的訊息內容，我將為您撰寫回覆建議：");
    } else if (action === "MENU_CONFLICT") {
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_CONFLICT_INPUT" });
      await replyText(userId, replyToken, "🤝 請描述發生的衝突或棘手情況，我將為您提供處理建議：");
    } else if (action === "P_MENU_REPLY") {
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_PARENT_INPUT" });
      await replyText(userId, replyToken, "💬 請描述您想跟老師溝通的情況或貼上老師的訊息：");
    } else if (action === "P_MENU_URGENT") {
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_PARENT_URGENT_INPUT" });
      await replyText(userId, replyToken, "🚨 請描述孩子在校發生的緊急狀況，我將幫您撰寫謹慎的回應：");
    } else if (action === "P_MENU_REPAIR") {
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_PARENT_REPAIR_INPUT" });
      await replyText(userId, replyToken, "🤝 請描述希望修復的親師關係情況，我將幫您擬定誠懇的訊息：");
    } else if (action === "MENU_ACCOUNT" || action === "P_MENU_ACCOUNT") {
      const today = new Date().toISOString().split("T")[0];
      const usage = user.usageResetDate === today ? user.usageToday : 0;
      const isTeacher = user.userType === "teacher";
      const style = isTeacher && user.styleJson ? JSON.parse(user.styleJson) : null;
      const styleLine = isTeacher
        ? (style?.className
            ? `\n班級：${style.className}  開場白：${style.opening || "未設定"}`
            : "\n溝通風格：尚未設定")
        : "";
      const buttons = isTeacher
        ? [
            { label: "🎨 設定溝通風格", data: "action=MENU_STYLE" },
            { label: "🔄 切換身分", data: "action=RESET_TYPE" },
            { label: "🏠 回主選單", data: "action=BACK_MENU" },
          ]
        : [
            { label: "🔄 切換身分", data: "action=RESET_TYPE" },
            { label: "🏠 回主選單", data: "action=BACK_MENU" },
          ];
      await sendResponse(
        userId,
        replyToken,
        `👤 帳號資訊\n──────────────\n方案：${user.plan}\n今日已用：${usage} / 3 次${styleLine}`,
        buttons
      );
    } else if (action === "MENU_STYLE") {
      if (user.userType !== "teacher") {
        await replyMainMenu(userId, user.userType, replyToken);
        return;
      }
      const existingStyle = user.styleJson ? JSON.parse(user.styleJson) : null;
      const preview = existingStyle?.className
        ? `\n\n目前設定：\n班級：${existingStyle.className}\n開場白：${existingStyle.opening || "未設定"}\n避免詞語：${(existingStyle.avoidWords || []).length > 0 ? existingStyle.avoidWords.join("、") : "無"}`
        : "";
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_STYLE_CLASSNAME" });
      const step1Buttons = existingStyle?.className
        ? [{ label: "⏭️ 保留現有班級", data: "action=STYLE_SKIP_CLASSNAME" }]
        : [];
      await sendResponse(
        userId,
        replyToken,
        `🎨 溝通風格設定${preview}\n\n第 1 步：輸入新的班級名稱，或點「保留」繼續：\n（例如：五年二班、三年甲班）`,
        step1Buttons
      );
    } else if (action === "STYLE_SKIP_AVOID") {
      if (user.userState !== "AWAITING_STYLE_AVOID") {
        await replyMainMenu(userId, user.userType, replyToken);
        return;
      }
      const existingStyle = user.styleJson ? JSON.parse(user.styleJson) : {};
      await updateDoc(doc(getDb(), "users", userId), {
        userState: null,
        styleJson: JSON.stringify(existingStyle),
      });
      await sendStyleComplete(userId, replyToken, existingStyle);
    } else if (action === "STYLE_SKIP_CLASSNAME") {
      if (user.userState !== "AWAITING_STYLE_CLASSNAME") {
        await replyMainMenu(userId, user.userType, replyToken);
        return;
      }
      const style = user.styleJson ? JSON.parse(user.styleJson) : {};
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_STYLE_OPENING" });
      const step2Buttons = style.opening
        ? [{ label: "⏭️ 保留現有開場白", data: "action=STYLE_SKIP_OPENING" }]
        : [];
      await sendResponse(
        userId,
        replyToken,
        `✅ 班級保留：${style.className || "未設定"}\n\n第 2 步：輸入新的慣用開場白，或點「保留」繼續：\n（例如：各位家長您好、親愛的家長您好）`,
        step2Buttons
      );
    } else if (action === "STYLE_SKIP_OPENING") {
      if (user.userState !== "AWAITING_STYLE_OPENING") {
        await replyMainMenu(userId, user.userType, replyToken);
        return;
      }
      const style = user.styleJson ? JSON.parse(user.styleJson) : {};
      await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_STYLE_AVOID" });
      await sendResponse(
        userId,
        replyToken,
        `✅ 開場白保留：「${style.opening || "未設定"}」\n\n第 3 步：有沒有你不想出現在文字裡的詞語？\n（例如：麻煩家長、請務必）\n\n多個詞以逗號分隔，也可以直接跳過。`,
        [{ label: "⏭️ 跳過這步", data: "action=STYLE_SKIP_AVOID" }]
      );
    } else if (action === "RESET_TYPE") {
      await sendResponse(userId, replyToken, "請選擇您的新身份：", [
        { label: "👩‍🏫 我是老師", data: "action=SET_TYPE&value=teacher" },
        { label: "👨‍👩‍👧 我是家長", data: "action=SET_TYPE&value=parent" }
      ]);
    } else {
      await replyText(userId, replyToken, "功能開發中，敬請期待！");
    }
  } catch (e) {
    console.error("Error in handlePostback:", e);
    await replyText(userId, replyToken, "抱歉，處理您的請求時發生錯誤。");
  }
}

async function replyMainMenu(userId: string, userType: string, replyToken: string | null = null) {
  if (!userType) {
    await sendResponse(userId, replyToken, "👋 嗨！歡迎使用親師悄悄話！\n\n請問你是：", [
      { label: "👩‍🏫 我是老師", data: "action=SET_TYPE&value=teacher" },
      { label: "👨‍👩‍👧 我是家長", data: "action=SET_TYPE&value=parent" }
    ]);
    return;
  }

  if (userType === "teacher") {
    await sendResponse(userId, replyToken, "老師好！需要什麼幫助？", [
      { label: "📢 家長通知", data: "action=MENU_NOTIFY" },
      { label: "💬 回覆家長", data: "action=MENU_REPLY" },
      { label: "🤝 衝突處理", data: "action=MENU_CONFLICT" },
      { label: "👤 帳號資訊", data: "action=MENU_ACCOUNT" }
    ]);
  } else {
    await sendResponse(userId, replyToken, "需要什麼幫助？", [
      { label: "💬 回覆老師訊息", data: "action=P_MENU_REPLY" },
      { label: "🚨 孩子出事了", data: "action=P_MENU_URGENT" },
      { label: "🤝 親師關係修復", data: "action=P_MENU_REPAIR" },
      { label: "👤 帳號資訊", data: "action=P_MENU_ACCOUNT" }
    ]);
  }
}

// --- LINE API Helpers ---

async function sendResponse(userId: string, replyToken: string | null, text: string, quickReplies: any[] = []) {
  const messages: any[] = [{ type: "text", text }];
  if (quickReplies.length > 0) {
    messages[0].quickReply = {
      items: quickReplies.map(i => ({
        type: "action",
        action: { type: "postback", label: i.label, data: i.data, displayText: i.label }
      }))
    };
  }

  // Try reply first if token exists
  if (replyToken) {
    try {
      await axios.post("https://api.line.me/v2/bot/message/reply", {
        replyToken,
        messages
      }, {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
      });
      console.log(`[MSG] Successfully sent via REPLY to ${userId}`);
      return true;
    } catch (error: any) {
      console.error(`[MSG] Reply failed for ${userId}, falling back to push:`, error.response?.data || error.message);
      // Fall through to push
    }
  }

  // Fallback to push
  if (!userId) {
    console.error("[MSG] Cannot push message: userId is empty");
    return false;
  }

  try {
    await axios.post("https://api.line.me/v2/bot/message/push", {
      to: userId,
      messages
    }, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    console.log(`[MSG] Successfully sent via PUSH to ${userId}`);
    return true;
  } catch (error: any) {
    console.error(`[MSG] Push failed for ${userId}:`, error.response?.data || error.message);
    return false;
  }
}

async function startLoadingAnimation(userId: string) {
  try {
    await axios.post("https://api.line.me/v2/bot/chat/loading/start", {
      chatId: userId,
      loadingSeconds: 20
    }, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
    });
  } catch (error: any) {
    console.warn("Loading animation failed:", error.response?.data || error.message);
  }
}

async function replyText(userId: string, replyToken: string, text: string) {
  return sendResponse(userId, replyToken, text);
}

async function pushMessage(userId: string, text: string) {
  return sendResponse(userId, null, text);
}

// --- Prompt Builders ---

function buildNotifyPrompt(data: any, style: any) {
  const toneMap: any = { formal: '正式專業', mid: '適中親切', warm: '溫馨活潑' };
  const avoidWords = (style?.avoidWords || []).length > 0
    ? `請避免使用以下詞語：${style.avoidWords.join('、')}` : '';

  const notifyType = data.notifyType || "一般事項通知";
  const content = data.content || "請協助提醒孩子相關事宜";
  const tone = toneMap[data.tone] || '適中親切';
  const className = style?.className || data.className || '班級';

  return `你是台灣國小老師助理，專門撰寫家長通知。

【班級】${className}
【慣用開場白】${style?.opening || '各位家長您好'}
【通知類型】${notifyType}
【重點內容】${content}
【語氣要求】${tone}
【附加要求】${(data.extras || []).join('、') || '無'}
${avoidWords}

請直接輸出通知內文，不加說明或標題。
格式：稱呼開頭 → 事項說明（時間/地點/金額/截止日要清楚） → 感謝結尾
字數：150～220字，繁體中文，台灣習慣用語。`;
}

function buildTeacherReplyPrompt(data: any, style: any) {
  const emotionMap: any = { calm: '情緒平穩', worried: '有些擔憂', upset: '語氣不滿', anxious: '非常焦慮' };
  const goalMap: any    = { soothe: '安撫並解釋', comply: '請家長配合', meet: '邀請面談', thanks: '表達感謝' };
  const avoid      = (style?.avoidWords || []).length > 0 ? `請避免使用：${style.avoidWords.join('、')}` : '';

  const parentMsg = data.parentMsg || "家長傳來的訊息";
  const emotion = emotionMap[data.emotion] || '情緒平穩';
  const goal = goalMap[data.goal] || '安撫並解釋';

  return `你是台灣國小老師，幫我撰寫回覆家長的訊息範本。

【慣用開場白】${style?.opening || '家長您好'}
【家長訊息】${parentMsg}
【家長情緒】${emotion}
【希望達到的結果】${goal}
${data.context ? `【補充背景】${data.context}` : ''}
${avoid}

直接輸出回覆內容，不加說明。請使用上方的慣用開場白作為回覆的第一句話。
語氣誠懇有溫度，不卑不亢，100～160字，繁體中文。`;
}

function buildConflictPrompt(data: any, style: any) {
  const channelMap: any = {
    group: 'LINE 群組（公開）', private: 'LINE 私訊',
    phone: '電話', face: '當面', letter: '書面投訴',
  };
  const stanceMap: any = {
    basis: '我有充分依據', misunderstand: '有誤會需澄清',
    review: '願意重新審視', escalate: '需要主任介入',
  };
  const needMap: any = {
    reply: '謹慎回應訊息', clarify: '群組公開澄清策略',
    invite: '邀請私下溝通話術', report: '給主任的說明稿',
  };

  const situation = data.situation || "親師溝通衝突事件";
  const channel = channelMap[data.channel] || 'LINE 私訊';
  const stance = stanceMap[data.stance] || '有誤會需澄清';
  const need = needMap[data.need] || '謹慎回應訊息';

  const avoid = (style?.avoidWords || []).length > 0 ? `請避免使用：${style.avoidWords.join('、')}` : '';

  return `你是台灣學校親師溝通顧問，協助老師處理衝突。

【事件描述】${situation}
【管道】${channel}
【老師立場】${stance}
【需要協助】${need}
${avoid}

請提供：
1. 【情況分析】（2～3句，點出核心問題）
2. 【建議話術】（直接可用的完整文字，務必標示此標題）
3. 【後續建議】（1～2點注意事項）

繁體中文，語氣專業冷靜，整體 250～380字。`;
}

function buildParentPrompt(data: any, style: any) {
  const typeGuide: any = {
    daily:   '這是日常親師溝通，語氣友好有禮即可。',
    urgent:  '這是緊急或衝突情況，需要保護家長立場，措辭謹慎但不激進。',
    repair:  '這是修復親師關係，語氣要真誠、低調，創造和解空間。',
    absence: '這是請假或特殊說明，語氣得體、說明清楚即可。',
  };
  const goalLabels: any = {
    understand: '先了解完整情況再表態',
    cooperate:  '表達配合意願',
    protect:    '保護孩子立場，請老師重新調查',
    apologize:  '適度致歉，修復關係',
  };

  const situationType = typeGuide[data.situationType] || '日常溝通';
  const teacherMsg = data.teacherMsg || "老師傳來的訊息";
  const parentGoal = goalLabels[data.parentGoal] || '了解情況';

  return `你是台灣家長的親師溝通顧問，幫家長找到最好的回覆措辭。
你了解台灣親師文化，知道怎麼讓家長既保護孩子，又不傷害與老師的關係。

【情況類型】${situationType}
【事件描述 / 老師訊息】
${teacherMsg}

【家長希望達到的目的】${parentGoal}
${data.context ? `【補充背景】${data.context}` : ''}
${style?.opening ? `【慣用開場白】${style.opening}` : ''}

直接輸出回覆內容，不加說明。
語氣得體，100～180字，繁體中文。`;
}

// --- AI Generation Logic ---

async function generateAIContent(userId: string, userType: string, type: string, data: any) {
  console.log(`Generating AI content for ${userId} (${userType}, ${type})`);
  const db = getDb();
  const userDoc = await getDoc(doc(db, "users", userId));
  const userData = userDoc.data();
  if (!userData) throw new Error("User not found");

  const today = new Date().toISOString().split("T")[0];
  let usageToday = userData.usageResetDate === today ? userData.usageToday : 0;

  const hasTrial = userData.trialEndDate && new Date(userData.trialEndDate) > new Date();
  if (userData.plan === "free" && !hasTrial && usageToday >= 3) {
    throw new Error("LIMIT_EXCEEDED");
  }

  const styleJson = userData.styleJson ? JSON.parse(userData.styleJson) : null;
  let prompt = "";

  if (userType === "teacher") {
    const dataObj = typeof data === "string" ? { content: data, parentMsg: data, situation: data } : data;
    if (type === "notify") prompt = buildNotifyPrompt(dataObj, styleJson);
    else if (type === "reply") prompt = buildTeacherReplyPrompt(dataObj, styleJson);
    else if (type === "conflict") prompt = buildConflictPrompt(dataObj, styleJson);
  } else {
    const situationTypeMap: any = { parent_daily: "daily", parent_urgent: "urgent", parent_repair: "repair" };
    const situationType = situationTypeMap[type] || "daily";
    const dataObj = typeof data === "string" ? { teacherMsg: data, situationType } : { ...data, situationType };
    prompt = buildParentPrompt(dataObj, styleJson);
  }

  console.log(`Calling Gemini API with prompt length: ${prompt.length}`);
  
  try {
    // Check key before calling
    let aiPromise;
    try {
      aiPromise = getGenAI().models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt }] }],
        config: {
          safetySettings: [
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
          ]
        }
      });
    } catch (keyErr: any) {
      console.error("Failed to get GenAI instance:", keyErr.message);
      throw keyErr; // Re-throw to be caught by outer catch
    }

    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error("AI_TIMEOUT")), 25000)
    );

    const response: any = await Promise.race([aiPromise, timeoutPromise]);
    
    if (!response.candidates || response.candidates.length === 0) {
      throw new Error("AI_BLOCKED");
    }

    const text = response.text;
    if (!text) throw new Error("AI_EMPTY_RESPONSE");
    
    console.log(`AI response received, length: ${text?.length}`);

    // Update usage
    await updateDoc(doc(db, "users", userId), {
      usageToday: usageToday + 1,
      usageResetDate: today
    });

    // Log success
    try {
      await addDoc(collection(db, "logs"), {
        timestamp: new Date().toISOString(),
        userId,
        userType,
        action: type,
        input: JSON.stringify(data),
        output: text,
        model: "gemini-3-flash-preview",
        status: "success"
      });
    } catch (logErr) {
      console.warn("Log writing failed (non-fatal):", logErr);
    }

    return text;
  } catch (error: any) {
    console.error("AI Generation Error Details:", error);
    
    // Log failure for debugging
    let logStatus = "Logging attempted...";
    try {
      await addDoc(collection(db, "logs"), {
        timestamp: new Date().toISOString(),
        userId,
        userType,
        action: type,
        input: JSON.stringify(data),
        error: error.message,
        stack: error.stack?.substring(0, 500),
        status: "error"
      });
      logStatus = "Log written successfully.";
    } catch (logErr: any) {
      logStatus = `Log write FAILED: ${logErr.message}`;
      console.warn("Error log writing failed:", logErr);
    }

    // Pass specific error message if it's one of our custom ones
    if (["LIMIT_EXCEEDED", "AI_TIMEOUT", "AI_BLOCKED", "AI_EMPTY_RESPONSE", "GEMINI_API_KEY_MISSING"].includes(error.message)) {
      const enhancedError = new Error(error.message);
      (enhancedError as any).logStatus = logStatus;
      throw enhancedError;
    }
    
    // Otherwise wrap the original error message
    const wrappedError = new Error(`AI_ERR: ${error.message || "Unknown"}`);
    (wrappedError as any).logStatus = logStatus;
    throw wrappedError;
  }
}

// --- Debug & Admin API Routes ---
app.get("/api/debug-logs", async (req, res) => {
  try {
    const db = getDb();
    const logsSnapshot = await getDocs(query(collection(db, "logs"), orderBy("timestamp", "desc"), limit(50)));
    const logs = logsSnapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(logs);
  } catch (e: any) {
    res.status(500).json({ error: e.toString() });
  }
});

app.post("/api/debug/create-test-log", async (req, res) => {
  try {
    const db = getDb();
    await addDoc(collection(db, "logs"), {
      timestamp: new Date().toISOString(),
      userId: "TEST_USER",
      userType: "teacher",
      action: "TEST_ACTION",
      input: JSON.stringify({ message: "這是一筆測試輸入" }),
      output: "這是一筆測試輸出內容，用來驗證 Dashboard 顯示功能是否正常。",
      model: "gemini-3-flash-preview",
      status: "success"
    });
    res.json({ status: "ok" });
  } catch (e: any) {
    res.status(500).json({ error: e.toString() });
  }
});

app.get("/api/stats", async (req, res) => {
  try {
    const db = getDb();
    const usersSnapshot = await getDocs(collection(db, "users"));
    const logsSnapshot = await getDocs(query(collection(db, "logs"), orderBy("timestamp", "desc"), limit(10)));
    
    const stats = {
      totalUsers: usersSnapshot.size,
      teachers: usersSnapshot.docs.filter(d => d.data().userType === "teacher").length,
      parents: usersSnapshot.docs.filter(d => d.data().userType === "parent").length,
      recentLogs: logsSnapshot.docs.map(d => d.data()),
    };
    res.json(stats);
  } catch (e: any) {
    console.error("Error in /api/stats:", e);
    res.status(500).json({ error: e.toString(), stack: e.stack });
  }
});

// --- Catch-all for 404 debugging ---
app.use("/api/*", (req, res) => {
  console.log(`[${new Date().toISOString()}] 404 on API route: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ error: "API route not found", method: req.method, url: req.originalUrl });
});

// Vite middleware
async function startServer() {
  console.log(`[${new Date().toISOString()}] Starting server initialization...`);
  try {
    if (process.env.NODE_ENV !== "production") {
      console.log(`[${new Date().toISOString()}] Initializing Vite in middleware mode...`);
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "spa",
      });
      app.use(vite.middlewares);
      console.log(`[${new Date().toISOString()}] Vite middleware attached.`);
    } else {
      // Production: serve React SPA from dist/; admin handled by /admin router above
      const distPath = path.join(process.cwd(), "dist");
      app.use(express.static(distPath));
      // Any unmatched route → serve index.html (React SPA handles routing)
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[${new Date().toISOString()}] Server listening on http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] FAILED TO START SERVER:`, error);
  }
}

startServer();
