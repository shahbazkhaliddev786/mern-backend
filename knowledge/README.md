# Store knowledge

Source documents for the shopping agent's `ask_store_knowledge` tool (milestone M5 in `docs/shopping-agent`). They live next to the code that will index them, so a policy change and the code change behind it ship together.

## Rules for editing

- **One question per chunk.** Every `##` heading is a question a customer would ask, and the text under it is one chunk. The ingestion step prefixes each chunk with its file's `#` title, so each answer must make sense on its own: no "see above", no leaning on a neighbouring section.
- **Facts only.** Write only what the live site already tells customers or what the code actually does. Each chunk ends with an HTML comment naming its source; the ingestion step strips HTML comments.
- **Unknowns are `TODO(owner)`.** If customers will ask something nobody has answered yet, keep the heading and put `TODO(owner): …` in the body. The ingestion step skips any chunk containing `TODO(owner)`, so the agent never cites a placeholder and falls back to the contact options instead.
- **Change the site and these files together.** When a policy changes, update the page that shows it and the chunk that states it in the same change. The contact details live in `mern-frontend/src/shared/config/store.ts`.

## Publishing changes

The agent reads these files from the database, not from disk (spec 013). After editing them, run this once per environment, with that environment's `DATABASE_URL`, `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`:

```bash
npm run agent:ingest            # adds, updates and removes chunks; unchanged chunks cost nothing
npm run agent:ingest -- --dry-run   # just lists the chunks and the skipped TODOs, no keys needed
```

The search indexes come from `npm run agent:setup` (once per database; Atlas only). When a `TODO(owner)` is answered, also add a golden for it in `evals/knowledge.goldens.json`: a test fails until every live chunk has one.

## Owner checklist

**Blocking.** These chunks are skipped until answered:

| File | Question | What we know today |
|---|---|---|
| `shipping.md` | Where do you ship? | Prices are in USD; the checkout form accepts an address in any country. |
| `shipping.md` | How long does delivery take? | Nothing on the site. |
| `shipping.md` | Can I track my order? | Orders have a status on My Orders but no tracking number, and no email is sent when an order ships. |
| `returns.md` | Return conditions, how to start a return, refund timing, exchanges | The home page says "You can return any product within 30 days." |
| `orders.md` | Can I cancel or change my order? | No self-service cancellation yet; it is planned for pending and processing orders (roadmap step 3). |
| `contact-and-support.md` | Phone number | The contact page shows +1 (555) 234-5678, but 555 numbers are reserved for fiction. |
| `contact-and-support.md` | Where are you located, and can customers visit? | The contact page says 123 Fifth Avenue, New York, NY; until 2026-10-10 the footer said 877 The Bronx, NY 14568. |

**Please confirm.** These chunks are live and restate what the site says:

- The support email (hello@aljostore.com), hours (Mon – Fri, 9am – 6pm EST) and "typically responds within one business day" (`contact-and-support.md`).
- The 30-day return window (`returns.md`).
- That charging no sales tax is intended (`shipping.md`). It is the current rule in `src/services/pricing.service.ts`.
- The About page claims restated in `about.md` (founded 2020, small batches, materials, packaging).
