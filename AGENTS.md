# Base44 Dev Environment

## Project Overview
AI Lead Finder — a Vite + React frontend that uses the Base44 SDK (`@base44/sdk`) to talk to Base44's backend (`base44.app`) via an `/api` proxy. No backend functions, no database — all data goes through Base44 core integrations (InvokeLLM) and entity CRUD.

## Setup
- **Runtime:** Node 22 (via `docker-compose.base44.yml`)
- **Start:** `docker compose -f docker-compose.base44.yml up -d`
- **Preview:** Port 3000 → Vite dev server on 5173
- **Live reload:** Enabled (Vite HMR with polling for bind-mount compatibility)

## Required Configuration
- `VITE_BASE44_APP_ID` — Base44 App ID (from Base44 dashboard). Without it, the app renders UI but all API calls fail with "App not found". Delivered via `/run/base44/app.env`.
- `VITE_BASE44_APP_BASE_URL` — Set to `https://base44.app` in compose environment. The `@base44/vite-plugin` uses it to proxy `/api` requests to Base44's backend.

## Architecture Notes
- `@base44/vite-plugin` config in `vite.config.js` handles SDK aliases (`@/` → `/src/`), HMR, and API proxy.
- The plugin's `loadEnv` picks up env vars from the compose `environment:` section (process.env), not just .env files.
- `src/api/base44Client.js` creates the SDK client with `serverUrl: ''` (relative URLs) and `requiresAuth: false` (anonymous access).
- `src/lib/app-params.js` reads `VITE_BASE44_APP_ID` from `import.meta.env` or URL query param `app_id`.
- `src/lib/AuthContext.jsx` fetches app public settings on mount; without a valid app ID it shows an error state.

## Verification
- `curl -sf -H "Host: external-preview.example.com" http://localhost:3000/` must return the app HTML (Vite `allowedHosts: true`).
- Console errors "App not found" (404) mean `VITE_BASE44_APP_ID` is missing or invalid.
