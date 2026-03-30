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
      childProfile: null,
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
    await updateDoc(doc(getDb(), "users", userId), { userState: null, pendingInput: null, lastGenInput: null });
    await replyMainMenu(userId, user.userType, replyToken);
  } else if (["切換身分", "切換身份", "switch"].includes(text.toLowerCase())) {
    await updateDoc(doc(getDb(), "users", userId), { userState: null, pendingInput: null, lastGenInput: null });
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

async function sendChildProfileComplete(userId: string, replyToken: string | null, cp: any) {
  await sendResponse(
    userId,
    replyToken,
    `🎉 孩子資料已儲存！\n\n` +
    `孩子稱呼：${cp.childName || "未設定"}\n` +
    `年級班級：${cp.grade || "未設定"}\n` +
    `孩子特質：${cp.traits || "未設定"}\n` +
    `班導師：${cp.teacherName || "未設定"}\n\n` +
    `之後 AI 生成的回覆，都會自動帶入孩子的資訊 ✨`,
    [{ label: "🏠 回主選單", data: "action=BACK_MENU" }]
  );
}

async function startChildWizard(userId: string, replyToken: string | null, existingCp: any) {
  const hasExisting = existingCp?.childName;
  const step1Buttons = hasExisting
    ? [{ label: "⏭️ 保留現有稱呼", data: "action=CHILD_WIZARD_SKIP" }]
    : [{ label: "⏭️ 跳過這步", data: "action=CHILD_WIZARD_SKIP" }];
  const preview = hasExisting
    ? `\n\n目前資料：\n孩子稱呼：${existingCp.childName || "未設定"}\n年級班級：${existingCp.grade || "未設定"}\n孩子特質：${existingCp.traits || "未設定"}\n班導師：${existingCp.teacherName || "未設定"}`
    : "";
  await updateDoc(doc(getDb(), "users", userId), { userState: "AWAITING_CHILD_NAME" });
  await sendResponse(
    userId,
    replyToken,
    `👶 孩子資料設定${preview}\n\n第 1 步：孩子的暱稱或姓名是？\n（例如：小明、Emily、安安）`,
    step1Buttons
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

  // ── 孩子資料設定精靈 ───────────────────────────────────
  if (user.userState === "AWAITING_CHILD_NAME") {
    const cp = user.childProfile || {};
    cp.childName = text.trim();
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_CHILD_GRADE",
      childProfile: cp,
    });
    await sendResponse(userId, replyToken,
      `✅ 孩子稱呼：${cp.childName}\n\n第 2 步：孩子的年級班級是？\n（例如：國小三年級甲班、二年一班）`,
      [{ label: "⏭️ 跳過這步", data: "action=CHILD_WIZARD_SKIP" }]
    );
    return;
  }

  if (user.userState === "AWAITING_CHILD_GRADE") {
    const cp = user.childProfile || {};
    cp.grade = text.trim();
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_CHILD_TRAITS",
      childProfile: cp,
    });
    await sendResponse(userId, replyToken,
      `✅ 年級班級：${cp.grade}\n\n第 3 步：孩子有什麼特質或備註嗎？\n（例如：活潑好動、對數學有興趣、有輕微過動）`,
      [{ label: "⏭️ 跳過這步", data: "action=CHILD_WIZARD_SKIP" }]
    );
    return;
  }

  if (user.userState === "AWAITING_CHILD_TRAITS") {
    const cp = user.childProfile || {};
    cp.traits = text.trim();
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_CHILD_TEACHER",
      childProfile: cp,
    });
    await sendResponse(userId, replyToken,
      `✅ 孩子特質：${cp.traits}\n\n第 4 步：班導師怎麼稱呼？\n（例如：王老師、陳老師）`,
      [{ label: "⏭️ 跳過這步", data: "action=CHILD_WIZARD_SKIP" }]
    );
    return;
  }

  if (user.userState === "AWAITING_CHILD_TEACHER") {
    const cp = user.childProfile || {};
    cp.teacherName = text.trim();
    await updateDoc(doc(getDb(), "users", userId), {
      userState: null,
      childProfile: cp,
    });
    await sendChildProfileComplete(userId, replyToken, cp);
    return;
  }
  // ─────────────────────────────────────────────────────────

  // ── 澄清狀態：用戶打字而非點按鈕 ──────────────────────
  if (["AWAITING_NOTIFY_CLARIFY", "AWAITING_REPLY_CLARIFY", "AWAITING_CONFLICT_CLARIFY", "AWAITING_PARENT_CLARIFY"].includes(user.userState)) {
    await replyText(userId, replyToken, "請點選上方按鈕選擇，或輸入「主選單」重新開始。");
    return;
  }
  // ─────────────────────────────────────────────────────────

  // ── AI 功能：儲存輸入，進入澄清流程 ──────────────────────
  if (user.userState === "AWAITING_NOTIFY_INPUT") {
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_NOTIFY_CLARIFY",
      pendingInput: JSON.stringify({ type: "notify", text }),
    });
    const clarifyQ_notify = await generateClarifyQuestion(text, "notify") ?? "📢 通知語氣偏好？";
    await sendResponse(userId, replyToken, clarifyQ_notify, [
      { label: "📋 正式專業", data: "action=NOTIFY_TONE&value=formal" },
      { label: "😊 適中親切", data: "action=NOTIFY_TONE&value=mid" },
      { label: "🌸 溫馨活潑", data: "action=NOTIFY_TONE&value=warm" },
      { label: "⚡ 直接生成", data: "action=SKIP_CLARIFY" },
    ]);
    return;
  }

  if (user.userState === "AWAITING_REPLY_INPUT") {
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_REPLY_CLARIFY",
      pendingInput: JSON.stringify({ type: "reply", text }),
    });
    const clarifyQ_reply = await generateClarifyQuestion(text, "reply") ?? "💬 家長目前的情緒？";
    await sendResponse(userId, replyToken, clarifyQ_reply, [
      { label: "😌 情緒平穩", data: "action=REPLY_EMOTION&value=calm" },
      { label: "😟 有些擔憂", data: "action=REPLY_EMOTION&value=worried" },
      { label: "😤 語氣不滿", data: "action=REPLY_EMOTION&value=upset" },
      { label: "😰 非常焦慮", data: "action=REPLY_EMOTION&value=anxious" },
      { label: "⚡ 直接生成", data: "action=SKIP_CLARIFY" },
    ]);
    return;
  }

  if (user.userState === "AWAITING_CONFLICT_INPUT") {
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_CONFLICT_CLARIFY",
      pendingInput: JSON.stringify({ type: "conflict", text }),
    });
    const clarifyQ_conflict = await generateClarifyQuestion(text, "conflict") ?? "🤝 衝突發生在哪個管道？";
    await sendResponse(userId, replyToken, clarifyQ_conflict, [
      { label: "👥 LINE 群組", data: "action=CONFLICT_CHANNEL&value=group" },
      { label: "💬 LINE 私訊", data: "action=CONFLICT_CHANNEL&value=private" },
      { label: "📞 電話", data: "action=CONFLICT_CHANNEL&value=phone" },
      { label: "🤝 當面", data: "action=CONFLICT_CHANNEL&value=face" },
      { label: "⚡ 直接生成", data: "action=SKIP_CLARIFY" },
    ]);
    return;
  }

  if (user.userState === "AWAITING_PARENT_INPUT") {
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_PARENT_CLARIFY",
      pendingInput: JSON.stringify({ type: "parent_daily", text, situationType: "daily" }),
    });
    const clarifyQ_parent = await generateClarifyQuestion(text, "parent_daily") ?? "💬 您希望這封回覆達到？";
    await sendResponse(userId, replyToken, clarifyQ_parent, [
      { label: "🔍 了解情況", data: "action=PARENT_GOAL&value=understand" },
      { label: "🤝 表達配合", data: "action=PARENT_GOAL&value=cooperate" },
      { label: "🙏 婉轉拒絕", data: "action=PARENT_GOAL&value=decline" },
      { label: "⚡ 直接生成", data: "action=SKIP_CLARIFY" },
    ]);
    return;
  }

  if (user.userState === "AWAITING_PARENT_URGENT_INPUT") {
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_PARENT_CLARIFY",
      pendingInput: JSON.stringify({ type: "parent_urgent", text, situationType: "urgent" }),
    });
    const clarifyQ_urgent = await generateClarifyQuestion(text, "parent_urgent") ?? "🚨 您希望這封回覆達到？";
    await sendResponse(userId, replyToken, clarifyQ_urgent, [
      { label: "🛡️ 保護孩子", data: "action=PARENT_GOAL&value=protect" },
      { label: "🔍 了解情況", data: "action=PARENT_GOAL&value=understand" },
      { label: "🔎 請重新調查", data: "action=PARENT_GOAL&value=investigate" },
      { label: "⚡ 直接生成", data: "action=SKIP_CLARIFY" },
    ]);
    return;
  }

  if (user.userState === "AWAITING_PARENT_REPAIR_INPUT") {
    await updateDoc(doc(getDb(), "users", userId), {
      userState: "AWAITING_PARENT_CLARIFY",
      pendingInput: JSON.stringify({ type: "parent_repair", text, situationType: "repair" }),
    });
    const clarifyQ_repair = await generateClarifyQuestion(text, "parent_repair") ?? "🤝 您希望這封回覆達到？";
    await sendResponse(userId, replyToken, clarifyQ_repair, [
      { label: "🙏 適度致歉", data: "action=PARENT_GOAL&value=apologize" },
      { label: "💚 重建信任", data: "action=PARENT_GOAL&value=trust" },
      { label: "🕊️ 表達善意", data: "action=PARENT_GOAL&value=goodwill" },
      { label: "⚡ 直接生成", data: "action=SKIP_CLARIFY" },
    ]);
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

async function generateWithCleanup(userId: string, userType: string, type: string, data: any, replyToken: string) {
  try {
    await startLoadingAnimation(userId);
    await pushMessage(userId, "🔍 正在為您撰寫內容，請稍候...");

    const aiResponse = await generateAIContent(userId, userType, type, data);

    await updateDoc(doc(getDb(), "users", userId), {
      userState: null,
      pendingInput: null,
      lastGenInput: JSON.stringify({ userType, type, data }),
    });

    const isParent = userType === "parent";
    const quickReplies = [
      { label: "🔄 重新擬定", data: "action=REGENERATE" },
      { label: "🏠 回主選單", data: "action=BACK_MENU" },
    ];
    if (isParent) {
      const strategies = parseMultiStrategy(aiResponse);
      await sendMultiResponse(userId, replyToken, strategies, quickReplies);
    } else {
      const finalResponse = `[v2.1] ${aiResponse}`;
      await sendResponse(userId, replyToken, finalResponse, quickReplies);
    }
  } catch (error: any) {
    console.error("Error in generateWithCleanup:", error);
    await updateDoc(doc(getDb(), "users", userId), { userState: null, pendingInput: null });

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
      // Auto-start child wizard for new parents without childProfile
      if (type === "parent" && !user.childProfile) {
        await pushMessage(userId, "👶 歡迎！讓我先幫您設定孩子的基本資料，讓 AI 回覆更貼近您的情況。");
        await startChildWizard(userId, null, null);
      } else {
        await replyMainMenu(userId, type!);
      }
    } else if (action === "REGENERATE") {
      const lastGen = user.lastGenInput ? JSON.parse(user.lastGenInput) : null;
      if (!lastGen) { await replyMainMenu(userId, user.userType, replyToken); return; }
      await generateWithCleanup(userId, lastGen.userType, lastGen.type, lastGen.data, replyToken);
    } else if (action === "BACK_MENU") {
      await updateDoc(doc(getDb(), "users", userId), { userState: null, pendingInput: null, lastGenInput: null });
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
      const cp = !isTeacher ? (user.childProfile || {}) : null;
      const childLine = cp !== null
        ? `\n\n【孩子資料】\n• 孩子稱呼：${cp.childName || "未設定"}\n• 年級班級：${cp.grade || "未設定"}\n• 特質備註：${cp.traits || "未設定"}\n• 班導師：${cp.teacherName || "未設定"}`
        : "";
      const buttons = isTeacher
        ? [
            { label: "🎨 設定溝通風格", data: "action=MENU_STYLE" },
            { label: "🔄 切換身分", data: "action=RESET_TYPE" },
            { label: "🏠 回主選單", data: "action=BACK_MENU" },
          ]
        : [
            { label: "👶 更新孩子資料", data: "action=P_CHILD_SETUP" },
            { label: "🔄 切換身分", data: "action=RESET_TYPE" },
            { label: "🏠 回主選單", data: "action=BACK_MENU" },
          ];
      await sendResponse(
        userId,
        replyToken,
        `👤 帳號資訊\n──────────────\n方案：${user.plan}\n今日已用：${usage} / 3 次${styleLine}${childLine}`,
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
    } else if (action === "P_CHILD_SETUP") {
      if (user.userType !== "parent") {
        await replyMainMenu(userId, user.userType, replyToken);
        return;
      }
      await startChildWizard(userId, replyToken, user.childProfile);
    } else if (action === "CHILD_WIZARD_SKIP") {
      const stateMap: any = {
        AWAITING_CHILD_NAME: "AWAITING_CHILD_GRADE",
        AWAITING_CHILD_GRADE: "AWAITING_CHILD_TRAITS",
        AWAITING_CHILD_TRAITS: "AWAITING_CHILD_TEACHER",
        AWAITING_CHILD_TEACHER: null,
      };
      const promptMap: any = {
        AWAITING_CHILD_GRADE: `第 2 步：孩子的年級班級是？\n（例如：國小三年級甲班、二年一班）`,
        AWAITING_CHILD_TRAITS: `第 3 步：孩子有什麼特質或備註嗎？\n（例如：活潑好動、對數學有興趣、有輕微過動）`,
        AWAITING_CHILD_TEACHER: `第 4 步：班導師怎麼稱呼？\n（例如：王老師、陳老師）`,
      };
      const currentState = user.userState;
      if (!stateMap.hasOwnProperty(currentState)) {
        await replyMainMenu(userId, user.userType, replyToken);
        return;
      }
      const nextState = stateMap[currentState];
      if (nextState === null) {
        // Done
        await updateDoc(doc(getDb(), "users", userId), { userState: null });
        await sendChildProfileComplete(userId, replyToken, user.childProfile || {});
      } else {
        await updateDoc(doc(getDb(), "users", userId), { userState: nextState });
        await sendResponse(userId, replyToken,
          `⏭️ 已跳過\n\n${promptMap[nextState]}`,
          [{ label: "⏭️ 跳過這步", data: "action=CHILD_WIZARD_SKIP" }]
        );
      }
    } else if (action === "RESET_TYPE") {
      await sendResponse(userId, replyToken, "請選擇您的新身份：", [
        { label: "👩‍🏫 我是老師", data: "action=SET_TYPE&value=teacher" },
        { label: "👨‍👩‍👧 我是家長", data: "action=SET_TYPE&value=parent" }
      ]);
    } else if (action === "NOTIFY_TONE") {
      const pending = user.pendingInput ? JSON.parse(user.pendingInput) : null;
      if (!pending) { await replyMainMenu(userId, user.userType, replyToken); return; }
      await generateWithCleanup(userId, "teacher", "notify", { content: pending.text, tone: params.get("value") }, replyToken);
    } else if (action === "REPLY_EMOTION") {
      const pending = user.pendingInput ? JSON.parse(user.pendingInput) : null;
      if (!pending) { await replyMainMenu(userId, user.userType, replyToken); return; }
      await generateWithCleanup(userId, "teacher", "reply", { parentMsg: pending.text, emotion: params.get("value") }, replyToken);
    } else if (action === "CONFLICT_CHANNEL") {
      const pending = user.pendingInput ? JSON.parse(user.pendingInput) : null;
      if (!pending) { await replyMainMenu(userId, user.userType, replyToken); return; }
      await generateWithCleanup(userId, "teacher", "conflict", { situation: pending.text, channel: params.get("value") }, replyToken);
    } else if (action === "PARENT_GOAL") {
      const pending = user.pendingInput ? JSON.parse(user.pendingInput) : null;
      if (!pending) { await replyMainMenu(userId, user.userType, replyToken); return; }
      await generateWithCleanup(userId, "parent", pending.type, { teacherMsg: pending.text, parentGoal: params.get("value") }, replyToken);
    } else if (action === "SKIP_CLARIFY") {
      const pending = user.pendingInput ? JSON.parse(user.pendingInput) : null;
      if (!pending) { await replyMainMenu(userId, user.userType, replyToken); return; }
      const genUserType = ["notify", "reply", "conflict"].includes(pending.type) ? "teacher" : "parent";
      await generateWithCleanup(userId, genUserType, pending.type, pending.text, replyToken);
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

function parseMultiStrategy(text: string): string[] {
  const markers = ["【策略一：", "【策略二：", "【策略三："];
  const indices = markers.map(m => text.indexOf(m));
  if (indices.some(i => i === -1)) return [text];
  const strategies: string[] = [];
  for (let i = 0; i < 3; i++) {
    const start = indices[i];
    const end = i < 2 ? indices[i + 1] : text.length;
    strategies.push(text.slice(start, end).trim());
  }
  return strategies;
}

async function sendMultiResponse(
  userId: string,
  replyToken: string | null,
  texts: string[],
  quickReplies: any[] = []
) {
  const messages: any[] = texts.map((t, idx) => {
    const msg: any = { type: "text", text: t };
    if (idx === texts.length - 1 && quickReplies.length > 0) {
      msg.quickReply = {
        items: quickReplies.map(i => ({
          type: "action",
          action: { type: "postback", label: i.label, data: i.data, displayText: i.label }
        }))
      };
    }
    return msg;
  });

  if (replyToken) {
    try {
      await axios.post("https://api.line.me/v2/bot/message/reply", {
        replyToken,
        messages
      }, {
        headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
      });
      console.log(`[MSG] Multi-strategy sent via REPLY to ${userId}`);
      return true;
    } catch (error: any) {
      console.error(`[MSG] Multi-strategy reply failed for ${userId}, falling back to push:`, error.response?.data || error.message);
    }
  }

  if (!userId) {
    console.error("[MSG] Cannot push multi-strategy: userId is empty");
    return false;
  }

  try {
    await axios.post("https://api.line.me/v2/bot/message/push", {
      to: userId,
      messages
    }, {
      headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}` }
    });
    console.log(`[MSG] Multi-strategy sent via PUSH to ${userId}`);
    return true;
  } catch (error: any) {
    console.error(`[MSG] Multi-strategy push failed for ${userId}:`, error.response?.data || error.message);
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

function buildParentPrompt(data: any, style: any, childProfile?: any) {
  const typeGuide: any = {
    daily:   '這是日常親師溝通，語氣友好有禮即可。',
    urgent:  '這是緊急或衝突情況，需要保護家長立場，措辭謹慎但不激進。',
    repair:  '這是修復親師關係，語氣要真誠、低調，創造和解空間。',
    absence: '這是請假或特殊說明，語氣得體、說明清楚即可。',
  };
  const goalLabels: any = {
    understand:   '先了解完整情況再表態',
    cooperate:    '表達配合意願',
    decline:      '婉轉拒絕老師的要求',
    protect:      '保護孩子立場，請老師重新調查',
    investigate:  '請老師重新調查事件始末',
    apologize:    '適度致歉，修復關係',
    trust:        '重建彼此信任',
    goodwill:     '表達善意，化解嫌隙',
  };

  const situationType = typeGuide[data.situationType] || '日常溝通';
  const teacherMsg = data.teacherMsg || "老師傳來的訊息";
  const parentGoal = goalLabels[data.parentGoal] || '了解情況';

  const cpLines = [
    childProfile?.childName ? `【孩子稱呼】${childProfile.childName}` : '',
    childProfile?.grade ? `【年級班級】${childProfile.grade}` : '',
    childProfile?.traits ? `【孩子特質】${childProfile.traits}` : '',
    childProfile?.teacherName ? `【班導師稱呼】${childProfile.teacherName}` : '',
  ].filter(Boolean).join('\n');

  return `你是台灣家長的親師溝通顧問，幫家長找到最好的回覆措辭。
你了解台灣親師文化，知道怎麼讓家長既保護孩子，又不傷害與老師的關係。

【情況類型】${situationType}
【事件描述 / 老師訊息】
${teacherMsg}

【家長希望達到的目的】${parentGoal}
${data.context ? `【補充背景】${data.context}` : ''}
${cpLines}
${style?.opening ? `【慣用開場白】${style.opening}` : ''}

直接輸出回覆內容，不加說明。
語氣得體，100～180字，繁體中文。`;
}

function buildParentMultiStrategyPrompt(data: any, style: any, childProfile?: any) {
  const typeGuide: any = {
    daily:   '這是日常親師溝通，語氣友好有禮即可。',
    urgent:  '這是緊急或衝突情況，需要保護家長立場，措辭謹慎但不激進。',
    repair:  '這是修復親師關係，語氣要真誠、低調，創造和解空間。',
    absence: '這是請假或特殊說明，語氣得體、說明清楚即可。',
  };
  const goalLabels: any = {
    understand:   '先了解完整情況再表態',
    cooperate:    '表達配合意願',
    decline:      '婉轉拒絕老師的要求',
    protect:      '保護孩子立場，請老師重新調查',
    investigate:  '請老師重新調查事件始末',
    apologize:    '適度致歉，修復關係',
    trust:        '重建彼此信任',
    goodwill:     '表達善意，化解嫌隙',
  };

  const situationType = typeGuide[data.situationType] || '日常溝通';
  const teacherMsg = data.teacherMsg || "老師傳來的訊息";
  const parentGoal = goalLabels[data.parentGoal] || '了解情況';

  const cpLines = [
    childProfile?.childName ? `【孩子稱呼】${childProfile.childName}` : '',
    childProfile?.grade ? `【年級班級】${childProfile.grade}` : '',
    childProfile?.traits ? `【孩子特質】${childProfile.traits}` : '',
    childProfile?.teacherName ? `【班導師稱呼】${childProfile.teacherName}` : '',
  ].filter(Boolean).join('\n');

  return `你是台灣家長的親師溝通顧問，幫家長找到最好的回覆措辭。
你了解台灣親師文化，知道怎麼讓家長既保護孩子，又不傷害與老師的關係。

【情況類型】${situationType}
【事件描述 / 老師訊息】
${teacherMsg}

【家長希望達到的目的】${parentGoal}
${data.context ? `【補充背景】${data.context}` : ''}
${cpLines}
${style?.opening ? `【慣用開場白】${style.opening}` : ''}

請針對以上情境，提供三種不同的回覆策略，每種約 80～120 字，繁體中文。
每種策略要有明顯不同的目標或語氣取向（例如：委婉溝通／積極配合／保護立場）。
策略名稱由你自由命名，體現真正的差異化。
格式如下（直接輸出，不加任何說明或前言）：

【策略一：{策略名稱}】
{回覆內容}

【策略二：{策略名稱}】
{回覆內容}

【策略三：{策略名稱}】
{回覆內容}`;
}

// --- AI Generation Logic ---

async function generateClarifyQuestion(text: string, type: string): Promise<string | null> {
  const focusHintMap: Record<string, string> = {
    notify:        "語氣偏好（正式專業／適中親切／溫馨活潑）",
    reply:         "家長目前情緒（平穩／擔憂／不滿／焦慮）",
    conflict:      "溝通管道（群組／私訊／電話／當面）",
    parent_daily:  "家長想達到的目的（了解情況／表達配合／婉轉拒絕）",
    parent_urgent: "家長的優先事項（保護孩子／了解情況／請老師重新調查）",
    parent_repair: "修復目標（適度致歉／重建信任／表達善意）",
  };
  const focusHint = focusHintMap[type] ?? "使用者的目標";

  const prompt = `根據以下情況，用一句話（15字以內，繁體中文）問一個澄清問題，幫助了解使用者需求。
只輸出問題本身，不加任何說明、表情符號或標點符號以外的字。

情況：${text.substring(0, 200)}
問題方向：${focusHint}`;

  try {
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("CLARIFY_TIMEOUT")), 6000)
    );
    const aiPromise = getGenAI().models.generateContent({
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
    const response: any = await Promise.race([aiPromise, timeoutPromise]);
    const question = response.text?.trim();
    if (question && question.length > 0 && question.length <= 40) return question;
  } catch (_) {
    // fall through to default
  }
  return null;
}

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
    prompt = buildParentMultiStrategyPrompt(dataObj, styleJson, userData.childProfile);
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
    
    const displayNameMap: Record<string, string> = {};
    usersSnapshot.docs.forEach(d => {
      const u = d.data();
      if (u.displayName) displayNameMap[d.id] = u.displayName;
    });

    const stats = {
      totalUsers: usersSnapshot.size,
      teachers: usersSnapshot.docs.filter(d => d.data().userType === "teacher").length,
      parents: usersSnapshot.docs.filter(d => d.data().userType === "parent").length,
      recentLogs: logsSnapshot.docs.map(d => {
        const log = d.data();
        return { ...log, displayName: displayNameMap[log.userId] || null };
      }),
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
