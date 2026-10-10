# Specs

Every piece of work on the shopping agent starts as a spec in this folder. The spec is written and agreed **before** the code, updated while the work happens, and kept afterwards as the record of what was built and why.

The overall plan is [`../shopping-agent/phases.md`](../shopping-agent/phases.md) (milestones M1–M7). Each spec here covers one slice of one milestone. The design docs in [`../shopping-agent/`](../shopping-agent/) stay the source of truth for *what* the agent is; specs record *how* a piece of it gets built.

> The backend repo is the home for all agent docs. The copy of `docs/shopping-agent/` in `mern-frontend` is no longer updated.

---

## Workflow

1. **Draft** — copy [`_template.md`](./_template.md) to the next number, fill in the goal, scope, design and acceptance criteria. Status `Draft`.
2. **Agree** — review the spec; resolve its open questions. Status `Approved`. No code before this.
3. **Build** — tick tasks as they land and record any change of plan in the decision log. Status `In progress`.
4. **Close** — acceptance criteria met and checked. Status `Done`, with the commit or PR that finished it. Update the milestone's row in `phases.md` §0 when its last spec closes.

A spec that's dropped or replaced keeps its file, with status `Superseded by NNN` or `Abandoned` and the reason.

## Naming

`NNN-mX-short-title.md` — a three-digit sequence number (never reused), the milestone, and a few words. Example: `001-m1-langchain-binding-check.md`.

## Index

Add a row when a spec is created; update its status as it moves.

| # | Spec | Milestone | Status | Closed by |
|---|---|---|---|---|
| 001 | [LangChain binding check](./001-m1-langchain-binding-check.md) | M1 | In progress | — |
| 002 | [Interrupt and resume across requests](./002-m1-interrupt-resume-across-requests.md) | M1 | Done | `6ec320b` |
| 003 | [Agent config and checkpointer setup](./003-m1-agent-config-and-checkpointer-setup.md) | M1 | Done | `f336c69` |
| 004 | [Vercel streaming check](./004-m1-vercel-streaming-check.md) | M1 | In progress | — |
| 005 | [Read tools](./005-m2-read-tools.md) | M2 | Done | `2f97266` |
| 006 | [Agent graph and chat endpoint](./006-m2-agent-graph-and-chat-endpoint.md) | M2 | In progress — code complete; real-model check pending | — |
| 007 | [Chat panel](./007-m3-chat-panel.md) | M3 | Done | `mern-frontend` `d08968f` |
| 008 | [Confirmation gate and cart writes](./008-m4-confirmation-gate-and-cart-writes.md) | M4 | Done | `f528bf6` |
| 009 | [Confirm card](./009-m4-confirm-card.md) | M4 | Done | `mern-frontend` `daf99b4` + `7b26e98` |
| 010 | [place_order](./010-m4-place-order.md) | M4 | Done | `d7ad0af` + `mern-frontend` `d5ff830` |
| 011 | [update_profile and submit_support_request](./011-m4-profile-and-support.md) | M4 | Done | `3d106d9` + `mern-frontend` `b6f62dd` |
| 012 | [Avatar upload](./012-m4-avatar-upload.md) | M4 | Done | `8db0052` + `mern-frontend` `5514a92` |
| 013 | [Store knowledge (`ask_store_knowledge`)](./013-m5-store-knowledge.md) | M5 | Done | `bed57d4` |
