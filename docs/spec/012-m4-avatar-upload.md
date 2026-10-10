# 012 — Avatar upload

| | |
|---|---|
| **Status** | Draft |
| **Milestone** | M4 — Write tools + confirmation gate ([`phases.md`](../shopping-agent/phases.md)) |
| **Created** | 2026-10-10 |
| **Updated** | 2026-10-10 |
| **Closed by** | — |
| **Repo** | `mern-backend` (upload endpoint, model, tool) and `mern-frontend` (attach button) |

## Goal

A customer can attach a picture in the chat and ask the agent to make it their profile picture. After they confirm, it's set exactly as the Edit Profile page sets it. The agent never sees the image's bytes, only an opaque id that works for that customer alone.

## Context

- **Design:** [`reconciliation.md`](../shopping-agent/reconciliation.md) Gap 11 ("Design for M3", moved to M4 by spec 007); [`security.md`](../shopping-agent/security.md) §9 ("File uploads never reach the LLM"); [`architecture.md`](../shopping-agent/architecture.md) §4 (`upload_avatar` row, confirm-required).
- **What exists:**
  - **Avatar rules** in `src/middlewares/multer.middleware.ts`: `uploadSingleFile` accepts one JPEG, PNG, GIF or WEBP file of up to 2 MB, in form field `profile`. Anything else gets a 400 with a message.
  - **`updateUserProfile(userId, name?, file?)`** in `src/services/auth.service.ts` uploads a multer file to Cloudinary (400×400, face crop), saves `user.profile`, and returns `{ id, name, email, profile }`.
  - **Spec 008–011 plumbing** this reuses: the confirmation gate and card, the per-user tools, the audit log, and the header name refresh.
- **What's missing:** a way to get an image from the chat to the server without the model handling it. That means an upload endpoint, a short-lived holding record, the tool, and an attach button.

## Scope

**In:**
- `POST /api/v1/agent/uploads/avatar`.
- A `PendingUpload` model with a 1-hour TTL.
- `applyAvatarUpload(userId, uploadId)`.
- The `upload_avatar` tool (confirm-required).
- An optional `uploadId` on chat messages.
- Prompt and `PROMPT_VERSION` 5.
- Frontend: an attach button, a thumbnail, the upload call, and a header avatar refresh.

**Out:**
- Other image uses, such as "find products like this photo".
- Removing a profile picture.
- `cancel_order` (013).

## Design

**Upload endpoint** — `POST /api/v1/agent/uploads/avatar` on the agent router, behind `agentAvailable` and `authMiddleware` like the chat:
- It runs the existing `uploadSingleFile` middleware (same limits and messages; form field `profile`).
- It stores a `PendingUpload { user, kind: 'avatar', data (Buffer), mimeType, size, originalName, createdAt }`, which expires after 1 hour through a TTL index on `createdAt`.
- It responds `201 { uploadId, name, size }`.
- Nothing reaches Cloudinary or the profile at this point.

**Chat request:** `{ message, threadId?, uploadId? }`. When `uploadId` is present, the server:
- loads the `PendingUpload` by `{ _id: uploadId, user }`; if it's missing or not this user's → `400 "That attachment has expired. Please attach it again."`
- appends a fixed note to the customer's message: *[The customer attached an image: "photo.png", 340 KB. upload_id: <id>]*

The note is written by the server, and the id is opaque and owner-scoped. That is the only way the model learns the id.

**Tool** — `upload_avatar({ upload_id })`, confirm-required (`src/agent/tools/account-writes.ts`, beside `update_profile`):
- **Confirmation summary** (read-only): *Set "photo.png" (340 KB) as your profile picture?* If the upload is gone → *That picture has expired. Cancel and attach it again.*
- **Runs `applyAvatarUpload(ctx.userId, upload_id)`** (`src/services/upload.service.ts`, new):
  1. `PendingUpload.findOne({ _id, user, kind: 'avatar' })`; nothing found → error "That picture has expired or isn't yours."
  2. Pass a multer-shaped file (`{ buffer, mimetype, originalname, size }`) to `updateUserProfile(userId, undefined, file)`.
  3. Delete the upload after success. If Cloudinary fails, the upload is kept so the customer can confirm again.
- **Returns** `{ profilePictureUpdated: true }`. The picture's URL isn't returned to the model.

**Prompt:** the assistant can set an attached image as the profile picture with `upload_avatar`, using the `upload_id` from the attachment note. It never invents an id. `PROMPT_VERSION` becomes 5.

**Frontend** (`src/features/shopping-agent/`):

| Change | Detail |
|---|---|
| **Composer** | Paperclip button + hidden file input (`accept` the four types). The 2 MB limit and type are checked in the browser first; the server re-checks |
| **Upload** | `uploadAvatar(file)` posts `FormData` (`profile` field) to the upload endpoint with the Bearer token, using the same refresh-once-on-401 as the chat |
| **Attachment chip** | Shows the thumbnail (object URL), name and a remove (×) button above the text box while uploading or ready |
| **Sending** | The message goes with `uploadId`. With no text, it defaults to "Here's a picture." The user's bubble shows the thumbnail; after a reload only the file name shows, since object URLs don't persist |
| **After `upload_avatar` succeeds** | The profile refresh from spec 011 also updates `profile` (the avatar URL) in the auth state |

## Tasks

- [ ] `PendingUpload` model + TTL; `upload.service.ts` (`createAvatarUpload`, `applyAvatarUpload`)
- [ ] Upload route + controller on the agent router
- [ ] Chat `uploadId`: ownership check + server-written note
- [ ] `upload_avatar` tool, summary, label; prompt + `PROMPT_VERSION` 5
- [ ] Frontend: attach button, upload service, chip, bubble thumbnail, avatar refresh
- [ ] Tests (below); browser check
- [ ] Update `phases.md` §0 and the spec index

## Acceptance criteria

- [ ] **Upload limits:** an upload over 2 MB, of a wrong type, or with two files → 400 with the existing messages; without a token → 401; agent off → 503 — HTTP tests
- [ ] **Ownership:**
  - [ ] An upload is stored for its owner only.
  - [ ] Another user's `uploadId` in a chat message → 400 "expired" (no note added).
  - [ ] `applyAvatarUpload` with another user's id → error.
  - [ ] Covered by HTTP and MongoDB tests.
- [ ] `upload_avatar` pauses with its summary, and on confirm calls `updateUserProfile` with the stored bytes and type, then deletes the upload — tool tests (Cloudinary mocked)
- [ ] A Cloudinary failure keeps the upload, and confirming again can succeed — tool test
- [ ] Uploads expire: the TTL index exists on `createdAt` (3,600 s) — MongoDB test
- [ ] The model never receives image bytes or the stored URL: tool results and the attachment note contain only the id, name and size — tests
- [ ] **Frontend:**
  - [ ] An oversize or wrong-type file is refused in the browser.
  - [ ] The upload posts `FormData` with the token.
  - [ ] The chip shows and can be removed.
  - [ ] The message carries `uploadId`.
  - [ ] The avatar refresh runs after `upload_avatar`.
  - [ ] Covered by tests.
- [ ] Backend lint 0 errors, build, tests with and without `MONGO_URL`; frontend tests, ESLint, Prettier, build; a browser check against a scripted backend

## Test plan

- **Backend:** HTTP tests with real multipart requests (like `multer.middleware.test.ts`), a MongoDB block for `PendingUpload` and ownership, and tool tests with `updateUserProfile` mocked.
- **Frontend:** component tests with a fake `fetch`.
- **Browser:** Playwright with a scripted backend, as in specs 007 and 009.

## Open questions

1. **Endpoint path:** `POST /api/v1/agent/uploads/avatar` (recommended: behind the agent's on/off switch and only used by the chat), or `/api/v1/uploads/avatar` as first sketched in reconciliation Gap 11?
2. **Upload lifetime:** 1 hour (recommended, as Gap 11 proposed), or longer?

## Results

_Filled in when the work is done._

## Decision log

| Date | Decision | Why |
|---|---|---|
