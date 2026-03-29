# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**親師悄悄話 (Whispers)** is an AI-powered LINE bot + admin dashboard that helps teachers and parents generate professional school communications. It runs on Google AI Studio.

## Commands

```bash
npm run dev        # Start dev server (tsx server.ts, port 3000)
npm run build      # Build: vite build + esbuild backend (dist/)
npm run start      # Run production server (node dist/server.cjs)
npm run lint       # TypeScript type check (tsc --noEmit)
npm run clean      # Remove dist/
```

No automated test runner — manual test scripts exist at `check_logs.ts`, `check_users.ts`, `test-client.ts`.

## Architecture

Two co-located apps served by a single Express server (`server.ts`):

### Backend (server.ts ~812 lines)
- **LINE bot webhook** at `POST /api/webhook` — receives all LINE events
- **State machine** per user stored in Firestore (`userState` field), with states like `AWAITING_NOTIFY_INPUT`, `AWAITING_REPLY_INPUT`, `AWAITING_CONFLICT_INPUT`, `AWAITING_PARENT_INPUT`
- **AI generation** via `@google/genai` (Gemini 2.0 flash) — all harm categories set to `BLOCK_NONE`
- **Rate limiting**: free users get 3 AI requests/day (tracked in Firestore `usageToday` + `usageResetDate`)
- **Firestore**: lazy-initialized via `getDb()`, uses custom database ID from `firebase-applet-config.json`
- **LINE API**: reply-token-first with push-message fallback; loading animation before AI calls

### Frontend (React + Vite, `src/`)
- `App.tsx` → `Dashboard.tsx` — admin view showing user stats, type distribution (recharts pie chart), and recent interaction logs
- `GET /api/stats` feeds the dashboard
- Tailwind CSS 4 (via Vite plugin), path alias `@/` → root

### Data Flow
```
LINE User → POST /api/webhook
  → handleLineEvent() → user lookup/creation in Firestore
  → handleTextMessage() or handlePostback()
  → generateAIContent() → Gemini API
  → log to Firestore `logs` collection
  → sendResponse() back to LINE
```

## Key Environment Variables

See `.env.example`. Required at runtime:
- `GEMINI_API_KEY` — injected by AI Studio
- `LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`
- `APP_URL` — injected by AI Studio

Firebase config is embedded in `firebase-applet-config.json` (not env vars).

## Firestore Collections

- **`users`**: LINE userId, userType (`teacher`/`parent`), plan (`free`/`paid`), `usageToday`, `usageResetDate`, `userState`, `displayName`, `lastActiveAt`
- **`logs`**: timestamp, userId, action, input, output, model, status, error details

## User Flows

Teachers see: 📢 家長通知 / 💬 回覆家長 / 🤝 衝突處理 / 👤 帳號資訊
Parents see: 💬 回覆老師訊息 / 🚨 孩子出事了 / 🤝 親師關係修復 / 👤 帳號資訊

Global commands (any state): `主選單` returns to menu, `切換身分` toggles teacher/parent role.

## Build System

- **Frontend**: Vite 6, outputs to `dist/`
- **Backend**: esbuild via `build-server.ts`, bundles `server.ts` → `dist/server.cjs` (CommonJS, Node platform, external: `fsevents`)
- `vite.config.ts` injects `process.env.GEMINI_API_KEY` for the frontend build
