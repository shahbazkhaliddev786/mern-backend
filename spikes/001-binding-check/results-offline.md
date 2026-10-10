# Spec 001 results — offline (mocked API)

Run: 2026-10-10T07:22:20.386Z

| Package | Version |
|---|---|
| `@langchain/anthropic` | 1.5.12 |
| `@anthropic-ai/sdk (nested in @langchain/anthropic)` | 0.122.0 |
| `@anthropic-ai/sdk (top level, control)` | 0.131.0 |
| `@langchain/core` | 1.2.17 |
| `deepeval` | 0.9.22 |

| Check | ChatAnthropic | SDK control | Evidence | Notes |
|---|---|---|---|---|
| C1 Adaptive thinking + effort | pass | pass | thinking={"type":"adaptive"} output_config={"effort":"low"} status=200 |  |
| C2 Explicit effort on Haiku 5.5 / Opus 5.5 | pass | n/a | claude-haiku-5-5: effort="low" status=200; claude-opus-5-5: effort="low" status=200 |  |
| C3 Strict tools (bindTools + Zod) | pass | pass | tool={"strict":true,"additionalProperties":false,"required":["query","price_max"]} tool_calls=[{"name":"search_products","args":{"query":"running shoes","price_max":50}}] status=200 |  |
| C4 tool_choice never forced | pass-with-note | n/a | default: tool_choice=undefined; auto: tool_choice={"type":"auto"}; withStructuredOutput: tool_choice=undefined output_config.format=false status=200 | withStructuredOutput (default method) with thinking on sends an unforced tool call and warns it may throw if the model skips the tool — use outputConfig.format (structured outputs) when JSON output is needed |
| C5 Refusal stop_reason + stop_details | pass | pass | response_metadata.stop_reason="refusal" stop_details={"type":"refusal","category":"cyber","explanation":"mocked refusal"} |  |
| C6 Thinking blocks round-trip unchanged | pass | n/a | turn1 thinking blocks=1, resent=1, identical=true status=200 |  |
| C7 Sonnet history replayed to Opus 5.5 | pass | n/a | resent to Opus: thinking blocks=1, status=200 |  |
| C8 Thinking display "updates" (beta) | pass | n/a | thinking={"type":"adaptive","display":"updates"} anthropic-beta="thinking-display-updates-2026-08-18" notes=["Searching the catalog for shoes under $50."] status=200 |  |
| C9 Mid-conversation system message | pass | n/a | top-level system="You are the Aljo Store shopping assistant." message roles=["user","assistant","user","system"] status=200 |  |
| C10 Prompt caching usage | pass-with-note | n/a | system cache_control sent=true usage_metadata.input_token_details={"cache_creation":0,"cache_read":4000} status=200 | offline: proves the binding passes cache_control and reports cache usage; a real cache hit needs the live run |
| C11 Server-side refusal fallbacks | pass-with-note | n/a | fallbacks="default" anthropic-beta="server-side-fallback-2026-07-01" status=200 | no first-class option: passed through invocationKwargs |
| C12 Streaming (.stream + streamEvents) | pass | n/a | stream=true chunks=9 thinking=1 (signature present) text=true tool_calls=[{"name":"search_products","args":{"query":"running shoes","price_max":50}}] streamEvents chat chunks=9 |  |
| C13 deepeval with @langchain/core 1.2.17 | fail | n/a | as installed: Error: Cannot find module '@sentry/node'; stale telemetry.js moved aside: Tests  3 passed (3) | fails as installed only because of the stale dist/telemetry.js; with it moved aside everything passes, including the LangChain integration on @langchain/core 1.2.17 |
