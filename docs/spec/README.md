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
