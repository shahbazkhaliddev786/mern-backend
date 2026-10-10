# Spec 004 results

| Run | When | URL | Seconds | Status | First byte | First tick | Ticks | Median gap | Max gap | Burst share | Ending | Total | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R1-local | 2026-10-10T08:11:22.248Z | http://localhost:4000/api/v1/agent/_stream-probe | 30 | 200 | 85 ms | 1076 ms | 30 | 1000 ms | 1002 ms | 0.03 | done | 30093 ms | **streams** |
| control-buffering-proxy | 2026-10-10T08:11:51.074Z | http://127.0.0.1:4999/api/v1/agent/_stream-probe | 6 | 200 | 6089 ms | 6089 ms | 6 | 0 ms | 0 ms | 1 | done | 6092 ms | **buffered** |
