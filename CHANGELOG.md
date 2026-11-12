# What's new — Story Studio Image Generator

Most recent first. Reload the extension from `chrome://extensions` to pick up a
new version. Older releases live in `git log`.

## 0.50.22 — 2026-11-12

- The side panel says "Gateway connection is saved, but Gateway mode is not selected" when a worker id and token exist while the mode is Studio or Standalone. That state looked paired and silently never claimed.

## 0.50.21 — 2026-11-12

- Fleet Hub was removed: if you had it enabled, this extension no longer reports to or accepts queue controls from a Hub.

## 0.50.20 — 2026-11-12

- Fixes the Flow tab the claim tick opens: Chrome rejects `autoDiscardable` on `tabs.create`, which stopped every claim before it reached Gateway. The tab is created and then marked non-discardable.

## 0.50.19 — 2026-11-12

- The Gateway claim alarm exists from worker start and is recreated on any local or synced settings change, including restored or externally written settings; it is no longer cleared when gateway mode is off.
- Any context — including a worker with no panel open — can request a claim by writing `gatewayClaimNowAt` to local storage. `gateway:claimNow` remains the panel message.
- Boot and ready markers (`workerBootAt`, `workerReadyAt`) and `gatewayLastTickAt` make a silent worker diagnosable from storage.

## 0.50.18 — 2026-11-12

- The Gateway claim alarm is recreated on browser startup and on extension update, not only when settings are saved. A worker whose settings arrive by restore or sync now starts ticking by itself.
- The side panel says whether the claim loop is ticking (`last check <time>`) or not ticking at all, so an armed but silent worker is visible instead of merely absent.

## 0.50.17 — 2026-11-12

- An armed Gateway worker no longer idles when no Flow tab is open: the claim tick opens the Flow workspace itself, waits for it to load, then claims. A panel-closed or headless worker can take jobs.
- While the Flow tab or model inventory blocks a claim, the worker reports activity "waiting" instead of "idle", so Gateway and Relay show that it is armed but blocked rather than healthy and silent.

## 0.50.16 — 2026-11-12

- Gateway image worker reads the signed-in Flow account (opaque id) and remaining credits and sends them with each claim; nothing comes from a profile, cookie or email.
- Claims and runs a Gateway image job once it can quote a price. Images are free: an unset price quotes 0 credits and claims proceed, and 0 is a real price, never "unknown". Settings only overrides it.
- Reports job progress to Gateway and adds a **Claim now** button in the side panel.
- Flow's model list is read from the signed-in page: a bundled model counts as live only while that page shows its exact label, so an unobserved or signed-out page claims nothing.
- Matches the picker as it is now — "Nano Banana 2.1" and "Nano Banana 2 Lite", keys `BELUGA` and `HARBOR_SEAL`. "Nano Banana Pro" is gone and no label is matched loosely.
- Submits 16:9 and 9:16, the two ratios with a real submit behind them; 4:3, 1:1, 3:4 and any size are refused rather than guessed. Counts of 1, 2 or 4 are carried.
- A zero balance does not refuse a free job.

## 0.50.15 — 2026-11-11

- Adds Gateway Studio mode: pair this extension with Gateway as an image worker. Off by default, one job at a time, with human pacing (5–15 s default gap).
- Applies Gateway's stop and pacing before confirming them, and keeps the stop after a browser restart.
- Keeps already-generated Gateway images deliverable after a stop, without generating again.

## 0.50.14 — 2026-11-11

- Applies dispatch stops and pacing before acknowledging them, and retains the stop after restart.
- Reports actual queue activity and pacing eligibility while paused, busy or held, without inventing account or credit observations.
- Keeps quote previews read-only; retained results can still be delivered.
- Preserves fractional custom pacing and longer waits.
- Changing or clearing the Gateway address keeps the manual queue working.

## 0.50.13 — 2026-11-11

- Defaults to a random 5–15 second gap after each generation; saved custom delays, including Off, are kept.
- Waits for the saved pacing gap and Flow cooldown before claiming another Gateway job, including after a restart.
