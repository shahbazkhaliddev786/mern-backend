# 004 — Vercel streaming check

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M1 — Spikes & foundations ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |

## Goal

Find out, on a real Vercel deployment, whether the backend can stream a long chat turn to the browser: events arrive one by one (not all at the end), both directly and through the frontend's `/api` rewrite, and a turn of about 90 seconds isn't cut off. Then decide where the chat endpoint runs and what `maxDuration` it needs.

## Context

- [`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 14, pre-build checks 1 and 2; [`phases.md`](../shopping-agent/phases.md) M1 item 3.
- **How requests reach the backend today:**
  - The backend is one Vercel function: `mern-backend/vercel.json` rewrites every path to `api/index.ts`, which wraps the Express app.
  - The frontend's `vercel.json` rewrites `/api/(.*)` to `https://mern-backend-mauve-ten.vercel.app/api/$1` — an **external** rewrite, so Vercel's edge proxies the response. Whether that proxy passes a stream through unbuffered is the main unknown.
  - Neither `vercel.json` sets `maxDuration`, so the plan's default applies.
  - The Express stack has no `compression` middleware (which would buffer streams); `helmet` doesn't buffer.
- **Network:** this cloud session can't reach `*.vercel.app` (the environment's network policy denies it). The probe therefore runs from your machine, or from here once `vercel.app` is allowed.
- The probe streams timestamps only — no model, no API key, no database.

## Scope

**In:**
- A temporary streaming endpoint in the backend, off unless `STREAM_PROBE_ENABLED=true`.
- A probe script that measures when each event arrives.
- Runs against: local dev (baseline), the backend preview URL directly, and the frontend preview through its `/api` rewrite — at 30, 90 and 240 seconds.
- The decision: chat endpoint on Vercel (with which `maxDuration`) or elsewhere; whether the browser must call the backend directly instead of through the rewrite.

**Out:**
- The real chat endpoint (M2). The probe endpoint is deleted once this spec closes; its results stay here.
- Authentication on the probe (it returns timestamps only, is off by default, and is capped at 300 seconds).

## Design

**Endpoint:** `POST /api/v1/agent/_stream-probe?seconds=N` (N defaults to 30; max 300).
- Mounted only when `STREAM_PROBE_ENABLED=true`; otherwise the route doesn't exist (404).
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`; `res.flushHeaders()` immediately.
- Sends `event: tick` with `{ i, serverTs }` every second, a `: keepalive` comment every 15 seconds, then `event: done` with `{ elapsedMs }` and ends. Stops early if the client disconnects.
- Same wire format the M2 chat stream will use (SSE over a POST, read with `fetch` + `ReadableStream` — Gap 14).

**Probe:** `spikes/004-vercel-streaming/probe.ts <url> [seconds]` (run with `npx tsx`):
- POSTs with `fetch`, reads the body with a `ReadableStream`, and records the arrival time of every event.
- Reports: time to first byte; time to first `tick`; arrival gaps (median and max); whether `done` arrived; total time; how the stream ended (done / cut off with status / network error).
- Verdict per run: **streams** if the first tick arrives within 3 s and the median gap is ≤ 1.5 s; **buffered** if most ticks arrive in one burst at the end; **cut off** if `done` never arrives.
- Writes one row per run to `spikes/004-vercel-streaming/results.md`.

**Runs:**

| Run | URL | Seconds |
|---|---|---|
| R1 baseline | `http://localhost:4000/api/v1/agent/_stream-probe` | 30 |
| R2 direct | `https://<backend-preview>.vercel.app/api/v1/agent/_stream-probe` | 30, 90, 240 |
| R3 via rewrite | `https://<frontend-preview>.vercel.app/api/v1/agent/_stream-probe` | 30, 90, 240 |

**Decision rule:**
- R2 and R3 stream at 90 s → the chat endpoint stays on Vercel behind the rewrite; set `maxDuration` to cover the longest run that passed plus headroom (and at least 120 s).
- R2 streams but R3 is buffered → the chat endpoint stays on Vercel, but the browser calls the backend URL directly for `/agent/chat` (CORS already allows the frontend origin).
- R2 is buffered or cut off before 90 s → the chat endpoint needs a long-running host; that becomes its own spec before M2.

## Tasks

- [ ] Probe route (behind `STREAM_PROBE_ENABLED`) + `.env.example` entry
- [ ] `spikes/004-vercel-streaming/probe.ts`
- [ ] R1 locally
- [ ] **You:** deploy backend and frontend previews from this branch with `STREAM_PROBE_ENABLED=true` on the backend preview, and send me the two preview URLs
- [ ] R2 and R3 (from your machine, or from here once `vercel.app` is allowed)
- [ ] Apply the decision rule; set `maxDuration` in `vercel.json` if staying on Vercel
- [ ] Delete the probe route; keep the probe script and results
- [ ] Update `phases.md` §0, `tech-stack.md` Layer 1/2 if hosting changes, and the spec index

## Acceptance criteria

- [ ] R1–R3 results recorded with time to first tick, gaps, and whether `done` arrived
- [ ] The hosting decision and `maxDuration` are stated in the decision log
- [ ] The probe route is gone from `main` once the spec closes
- [ ] `npm run lint`, `npm run build`, `npm test` pass

## Test plan

The probe is the test (R1–R3). The route also gets one unit test: with `STREAM_PROBE_ENABLED` unset it isn't mounted (404); with it set, a 2-second run returns `tick` events and `done`.

## Open questions

- **Who runs R2/R3:** you from your machine (`npx tsx spikes/004-vercel-streaming/probe.ts <url> 90`), or me after `vercel.app` is allowed in this environment's network settings?
- **Preview deployments:** does the backend Vercel project build previews for branches (so `claude/nifty-planck-d1xptl` gets a URL), or should the probe be deployed another way?

## Results

_Filled in when the runs are done._

## Decision log

| Date | Decision | Why |
|---|---|---|
