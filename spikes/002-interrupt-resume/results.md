# Spec 002 results

Run: 2026-10-10T07:33:38.597Z · MongoDB mongodb://127.0.0.1:27017 · every request in its own process

| Check | Result | Evidence |
|---|---|---|
| I1 Pause (mongoose client) | pass | interrupt={"tool":"clear_cart","args":{},"summary":"Remove all 2 items from your cart?"} next=["gate"] effects=0  |
| I2 Resume approved in another process (mongoose client) | pass | effects=1 last={"type":"ai","content":"Done — your cart is empty."} next=[] resume took 191ms (connect 37ms)  |
| I4 Gate node re-entry | finding | gate node started 2 times for one confirmation (pause + resume) |
| I5 Duplicate confirm, sequential | pass | second resume: ok=true last={"type":"ai","content":"Done — your cart is empty."} error=undefined; effects still 1 |
| I1 Pause (own client) | pass | interrupt={"tool":"clear_cart","args":{},"summary":"Remove all 2 items from your cart?"} next=["gate"] effects=0  |
| I2 Resume approved in another process (own client) | pass | effects=1 last={"type":"ai","content":"Done — your cart is empty."} next=[] resume took 171ms (connect 35ms)  |
| I3 Resume declined | pass | effects=0 last={"type":"ai","content":"Okay, I left your cart as it is."} |
| I6 Duplicate confirm, concurrent (no guard) | finding | 20 rounds: tool ran twice in 20, once in 0 |
| I6 Duplicate confirm, concurrent (claim guard) | pass | 20 rounds: tool ran once in 20, twice in 0; replies={"resumed":20,"already confirmed":20} |
| I7 Resume with nothing pending | finding | unknown thread, plain resume: ok=true last=null next=[] error=undefined effects=0; with claim guard: "nothing pending" |
| I8 Pause and resume while streaming | pass | start: ["messages:ai","updates:agent","updates:__interrupt__"] interrupt chunk=[{"id":"b71df15ac4d26272491af707c7c6a961","value":{"tool":"clear_cart","args":{},"summary":"Remove all 2 items from your cart?"}}]; resume: ["updates:gate","messages:tool","updates:tools","messages:ai","updates:agent"] effects=1 |
| I9 TTL indexes from setup() | pass | checkpoints: {"_id":1}, {"thread_id":1,"checkpoint_ns":1,"checkpoint_id":-1}, {"upserted_at":1} ttl=2592000s \| checkpoint_writes: {"_id":1}, {"thread_id":1,"checkpoint_ns":1,"checkpoint_id":1,"task_id":1,"idx":1}, {"upserted_at":1} ttl=2592000s |
| I9 Checkpoint size for one confirmed turn | finding | checkpoints: 6 docs / 7590 bytes; checkpoint_writes: 12 docs / 4292 bytes; upserted_at present=true |
