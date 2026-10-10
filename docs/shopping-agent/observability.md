# AI Shopping Assistant — Observability Checklist

> **The core problem:** for an agent, a `200 OK` with low latency can still be a complete failure — it placed the wrong order, hallucinated a return policy, or looped 8 times burning tokens. Traditional app monitoring (is it up? is it fast?) is necessary but **nowhere near sufficient**. You observe *decisions, trajectories, and outcomes*, not just health.
>
> Observability must answer three agent-specific questions: **(1) What did the agent decide and why? (2) Did its actions actually succeed and were they correct/safe? (3) Is quality drifting over time?**
>
> Companion to [`architecture.md`](./architecture.md), [`tech-stack.md`](./tech-stack.md), [`evals.md`](./evals.md), and [`security.md`](./security.md).

---

## Layer 0 — Standard app health (RED / USE)

The baseline. Don't skip it just because the LLM layer is shinier.

- [ ] **Rate** — requests/min per endpoint
- [ ] **Errors** — 4xx/5xx, unhandled exceptions, Express error rate
- [ ] **Duration** — p50/p95/p99 latency per route
- [ ] **Saturation** — Node event-loop lag, memory, CPU, Mongo connection pool
- [ ] **MongoDB** — query latency, slow queries, Atlas Vector Search index health
- [ ] **Product search** — latency of the Mongo product query behind `search_products` (and Typesense health, if it's ever added)

---

## Layer 1 — LLM call level (per model invocation)

Every call to Sonnet / Haiku is a span. Capture:

- [ ] **Model + version** (`claude-sonnet-5-5` vs `claude-haiku-5-5` vs `claude-opus-5-5` escalation) — which tier served this, and the **effort level** sent
- [ ] **Tokens**: input / output / **cache-read / cache-creation** — cache hit-rate is a direct cost lever
- [ ] **Cost per call** and **cost per conversation** (tokens × price)
- [ ] **Latency** + **TTFT** (time-to-first-token) — streaming UX health
- [ ] **`stop_reason`** — `end_turn` vs `max_tokens` (truncation!) vs `tool_use` vs **`refusal`**
- [ ] **Thinking tokens** (adaptive thinking spend; effort is the control)
- [ ] **Dropped thinking blocks** — expected on an escalation turn (Opus can't read Sonnet's blocks); anywhere else they mean the history was edited, which breaks the append-only rule ([`tech-stack.md`](./tech-stack.md) Layer 3) and restarts the prompt cache
- [ ] **Error/retry**: 429 rate-limit, 529 overload, timeout, retry count
- [ ] **Prompt + completion** captured (for trace replay + eval dataset curation)

> 🚩 Alert on: rising `max_tokens` stop rate (truncation), `refusal` spikes, cache-read hit-rate dropping (silent prompt-cache invalidation = cost blowup).

---

## Layer 2 — Agent trajectory level (the "why")

This is what makes it an *agent*. Observe the **path**, not just endpoints.

- [ ] **Step count per turn** — how many tool calls to resolve one user request
- [ ] **Loop detection** — same tool + same args called N times = stuck agent
- [ ] **Knowledge question** — the self-contained question the agent passed to `ask_store_knowledge` (did it lose the user's meaning?). There is no separate query rewrite or intent router in v1 ([`reconciliation.md`](./reconciliation.md) Gap 3, spec 013)
- [ ] **Tool-selection trace** — which tool the agent chose, and whether it was the *right* one for the intent
- [ ] **Full trajectory tree** — user msg → agent → tool → result → agent → … → response (one trace, one correlation ID)
- [ ] **HITL interrupts** — fired? approved/denied? **time-to-confirm**
- [ ] **Turns-to-completion** — conversations that never resolve (user gave up)
- [ ] **Opus escalation** — rate, **trigger reason** (loop / step budget / repeated tool error), whether Opus resolved the turn, and **cost of escalated turns**
- [ ] **Human escalation** — `submit_support_request` after a failed Opus retry vs. user-initiated

> 🚩 Alert on: step-count p95 climbing (agent getting confused), loop-detection hits, Opus escalation rate climbing (Sonnet regressing — and a cost spike).

---

## Layer 3 — RAG retrieval level (`ask_store_knowledge`)

A grounded answer is only as good as what was retrieved. Instrument the pipeline:

- [ ] **Search question** (the tool's `question` argument) — a bad question = bad retrieval
- [ ] **Retrieved chunk IDs + scores** (hybrid: vector + BM25) — what did it actually pull?
- [ ] **Rerank scores** (Voyage rerank-2.5) before vs after — is rerank reordering meaningfully?
- [ ] **Empty / low-confidence retrieval rate** — questions the KB can't answer (content gaps!)
- [ ] **Retrieval latency** (embed + hybrid search + rerank)
- [ ] **Context size** handed to the LLM
- [ ] **Citations** — did the answer cite retrieved chunks, or answer ungrounded?
- [ ] **Online grounding/faithfulness** — sampled LLM-judge check that the answer is supported by context

> 🚩 Alert on: empty-retrieval spikes (KB gaps or embedding drift), citation rate dropping (ungrounded answers = hallucination risk).

---

## Layer 4 — Tool / action level ⭐ (most important for an action-taking agent)

The agent *acts on the user's behalf*. This is where silent, costly failures hide.

- [ ] **Per tool**: name, input args, output, **success/error**, latency
- [ ] **Authz result** — did the tool enforce `user_id` scoping? Log **authz denials** (someone/agent tried to access another user's data)
- [ ] **Write-action audit** — all writes (`add_to_cart`, `update_cart_item`, `clear_cart`, `place_order`, `cancel_order`, `update_profile`, `upload_avatar`, `submit_support_request`):
  - [ ] For confirm-required tools: was the **confirmation shown** before execution? **Confirmed or denied**?
  - [ ] For auto writes (`add_to_cart`, `update_cart_item`): logged with args + resulting cart state (no confirmation expected)
  - [ ] For `place_order`: **open checkout reused** vs new Stripe session created — the duplicate-checkout guard firing
  - [ ] Checkout value, item count (business + anomaly detection)
- [ ] **Checkout → order lifecycle** (payment-first: an order exists only after payment):
  - [ ] `PendingCheckout` → paid `Order` conversion rate and time-to-pay
  - [ ] **Expired `PendingCheckout`s** (abandoned Stripe sessions, removed by the 24h TTL)
  - [ ] Webhook failures: signature errors, or a completed session with no matching `PendingCheckout`
  - [ ] `cancel_order` rate, rejected cancels (wrong state), refunds issued, and `REFUND_FAILED` errors waiting for an admin retry
- [ ] **Tool error taxonomy** — out-of-stock, invalid SKU, invalid shipping address (Zod rejection), payment handoff failure, webhook failure, cancel-not-allowed, refund failure, upload rejected, DB error
- [ ] **Action success ≠ tool success** — did `place_order` return a checkout link for the right cart and address, *and* did the webhook later create exactly one matching paid order?
- [ ] **Payment boundary guard** — assert/alert if **card-like or credential data ever appears** in a prompt or tool arg (it must never reach the agent)

> 🚩 Alert immediately on: any confirm-required write (`place_order`, `cancel_order`, `clear_cart`, `update_profile`, `upload_avatar`, `submit_support_request`) without a preceding confirmation event, authz-denial spikes, card/credential pattern detected in LLM I/O, more than one order for one Stripe session, an order created other than by a verified webhook.

---

## Layer 5 — Safety & security

- [ ] **Refusal rate** + categories (`stop_details.category`), and whether a server-side fallback answered the turn
- [ ] **Prompt-injection signals** — retrieved reviews/product text attempting instruction override; flag + sample
- [ ] **Guardrail triggers** — business-rule violations the backend had to reject (e.g. LLM tried to apply an invalid discount)
- [ ] **PII handling** — no card/login/PII persisted to logs, traces, or long-term memory; redaction verified
- [ ] **Jailbreak attempts** — users trying to make the agent act outside scope

---

## Layer 6 — Quality / online evals (is it drifting?)

Offline DeepEval gates CI; **online evals** catch production drift.

- [ ] **Sampled LLM-judge** on live traffic: faithfulness, answer-relevancy, tool-correctness (sample %, not 100% — cost)
- [ ] **User feedback** — thumbs up/down, explicit "that's wrong"
- [ ] **Task-success proxy** — did the conversation end in the intended action (cart/order) vs abandonment?
- [ ] **Regression watch** — quality metrics trended over time + per deploy (did a prompt/model change regress?)
- [ ] **Trace → dataset pipeline** — failing/interesting traces auto-flow into the DeepEval golden set

---

## Layer 7 — Business / product KPIs

Observability that leadership (and interviewers) care about:

- [ ] **Containment / deflection rate** — resolved without human
- [ ] **Agent-attributed conversions** — carts created, orders placed via the agent
- [ ] **Cart abandonment** after agent interaction
- [ ] **Cost per resolved conversation** (tokens + infra ÷ resolutions) — the unit economic that matters
- [ ] **Escalation rate** to human support — `submit_support_request` count ÷ conversations, split by reason (agent failed vs. user asked)

---

## The tracing stack decision: OpenTelemetry vs OpenLLMetry vs LangSmith

**These are not either/or — they compose into layers.**

| Option | What it is | Role here |
|---|---|---|
| **OpenTelemetry (OTel)** | Vendor-neutral standard for traces/metrics/logs; has **GenAI semantic conventions** (`gen_ai.*` span attributes) | **The backbone.** One correlated trace: HTTP → agent step → tool → Mongo query → LLM call, all under one trace ID. No vendor lock-in. |
| **OpenLLMetry** (Traceloop) | An SDK **built on top of OTel** that auto-instruments LLM providers, vector DBs, and frameworks into OTel spans | **The easy on-ramp** — auto-emits OTel-compatible LLM/RAG spans in Node/TS without hand-instrumenting every call. |
| **LangSmith** | Proprietary **LLM-native** tracing/eval platform; best DX for agent trajectories; can **ingest/export OTLP** | **The specialized lens** — richest view of agent trajectories + online evals, already in the stack. |

### Recommendation for this project

**Yes — adopt OpenTelemetry as the backbone from day one, keep LangSmith as the LLM-native layer.** Reasoning:

1. **Correlation across the full stack** — OTel puts the LLM span, the Mongo `$vectorSearch`, the product query, and the Express request in **one trace**. When an order goes wrong, you see the *entire* path, not just the LLM part. LangSmith alone shows you the agent, not the DB query under it.
2. **No vendor lock-in** — OTel + `gen_ai.*` conventions means you can ship the same spans to LangSmith, Grafana/Tempo, Datadog, or Honeycomb without re-instrumenting. This is the interview-correct answer to *"how do you avoid being locked to one observability vendor?"*
3. **OpenLLMetry** is the pragmatic way to get OTel LLM spans in Node without hand-rolling — auto-instruments Anthropic SDK, the vector store, and LangGraph. Point its OTLP exporter at LangSmith (which accepts OTLP) **and** a general backend.

**The honest tradeoff to state aloud:** for a *demo*, LangSmith alone is enough and zero-friction. I'd still wire OTel early because **retrofitting observability is painful**, and full-stack trace correlation + vendor-neutrality is a genuine senior signal — not because the demo strictly needs it. Keep the OTel backend light (even the free tier of a hosted backend, or LangSmith's OTLP endpoint) — don't over-build dashboards for a portfolio project.

> **Clarifying the name:** "LLMtelemetry" almost certainly means **OpenLLMetry** (Traceloop). It's not a competitor to OTel — it *is* OTel, with LLM auto-instrumentation on top.

---

## Minimum trace schema (log this on every request)

```
trace_id, conversation_id, user_id (hashed)
rewritten_query
model, effort, tokens{in,out,cache_read,cache_create}, cost, ttft, stop_reason
trajectory[]: [{step, tool, args, authz_result, result, latency, error}]
retrieval: {chunk_ids[], scores[], rerank_scores[], empty?, citations[]}
write_actions[]: [{tool, confirm_required, confirmation_shown, confirmed, pending_checkout_id?, checkout_reused?}]
escalation: {model, reason, resolved?, cost}
safety: {refusal?, injection_flag?, guardrail_triggered?, pii_detected?}
outcome: {resolved?, action_completed?, user_feedback}
```

---

## SLOs / alerts worth setting (start small)

| Signal | Why it matters | Alert |
|---|---|---|
| Confirm-required write without confirmation event | Safety breach — autonomous irreversible/account action | **page immediately** |
| Card/credential pattern in LLM I/O | PCI boundary violation | **page immediately** |
| Authz-denial spike | Possible IDOR / jailbreak attempt | high |
| `refusal` rate spike | Model blocking legit traffic | high |
| Empty-retrieval spike | KB gap or embedding drift | medium |
| Step-count p95 climbing | Agent getting confused / looping | medium |
| Opus escalation rate climbing | Sonnet regressing; escalated turns are expensive | medium |
| Expired `PendingCheckout`s climbing, or a paid Stripe session with no order | Checkout abandoned at scale, or the webhook is broken | medium |
| Cache-read hit-rate drop | Silent prompt-cache invalidation → cost blowup | medium |
| TTFT p95 regression | Streaming UX degrading | low |

---

## Interview soundbites

1. "For an agent, uptime and latency are necessary but not sufficient — a fast 200 can still place the wrong order. I observe decisions, trajectories, and outcomes."
2. "OpenTelemetry is my backbone so the LLM span, the vector search, and the DB write sit in one correlated trace with no vendor lock-in; LangSmith is the LLM-native lens on top. OpenLLMetry is just the OTel auto-instrumentation layer — not a competitor."
3. "My highest-severity alerts are safety, not performance: a write action without a confirmation, or card data reaching the agent, pages immediately."
4. "Failing production traces flow back into my DeepEval golden set — observability feeds evals, closing the loop."
