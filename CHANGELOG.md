# What's new — Story Studio Image Generator

Most recent first. Reload the extension from `chrome://extensions` to pick up a
new version. Older releases live in `git log`.

## 0.50.35 — 2026-11-24
- Settings no longer shows the **Account** and **Credits** Flow request-id fields. 0.50.32 said those ids were dropped, and they were dropped from the resolver, but the two boxes stayed on the page taking a value nothing read. Both fields and their shipped defaults are gone, and a test now checks the Settings fields against the ids the resolver actually uses, so a field that does nothing cannot come back quietly.

## 0.50.34 — 2026-11-20
- An uncertain Gateway claim no longer needs a person to unstick it. If a claim went unanswered, this extension used to refuse every new claim until someone reviewed it in Gateway. It now expires on Gateway's own lease clock: past the lease Gateway has already let the job go, so this worker claims again and says what happened. The error is still shown; only the wait for a human is gone. An unreadable lease is never guessed at, so a live claim is never dropped early.

## 0.50.33 — 2026-11-13
- Contrast and layering pass: the border ramp separates cards from the panel ground in light and dark, and every text, muted, accent, primary-button and status pair measures at least 5.1:1 in both themes.

## 0.50.32 — 2026-11-13
- The RPC id list used by tests and tooling no longer carries the retired account/credits ids; only generate and upload are discovered.

## 0.50.31 — 2026-11-13
- The tab's project address is the only account source; the in-page identity probe, sign-in selectors and account/credits RPC ids are gone. A home tab is `no_project` with its own message, never "unreadable".
- Heartbeats now carry the real account and the project id, so Gateway sees connected/ready instead of unknown on every beat.
- A refused claim (HTTP 4xx) clears the unsettled-claim marker instead of holding every later tick, and every tick writes a status, including idle.
- One readiness object (`gatewayReadiness`) is written by the background each tick and at startup; the panel shows its reason when blocked, and Relay reads the same object.
- The manifest carries a fixed key, so the extension id and its storage survive versioned folders.

## 0.50.30 — 2026-11-13
- The Flow tab's own project address is the primary account source: a tab whose URL carries the project id claims with a known project and unknown balance, without asking the page at all. The in-page identity probe is only consulted when the tab has no project in its address.
- Relay prefers a complete tab that is on a project before any other Flow tab, so a home tab can no longer shadow the worker's real tab.

## 0.50.29 — 2026-11-13
- Gateway claims no longer depend on reading a Flow account identity: a real Flow project tab is enough, with `balance` unknown and the probe result kept as detail. Claims are never blocked by an identity Flow does not return.
- Sign-in detection checks several markers — Google account links, the avatar and the Flow composer — instead of a single selector; a tab with no project says exactly which check failed.

## 0.50.28 — 2026-11-13
- Gateway mode can reach the Gateway again: the loopback host permissions (127.0.0.1, localhost, ::1) came out with the old Story server and are restored — a test now fails if Gateway mode ever ships without them.
- The side panel is one system: 32 px controls on a 4/8/12/16 spacing scale, full-width connection fields, one primary Connect, every other control behind Details.
- "Connected through Relay" is a state, not a form: once Relay seeds the connection, the address, token and worker ID sit behind Connection details and the panel names the machine.
- A browser Relay could not connect says so and points back to Relay, instead of asking for an address you were never shown.
- "Open workspace" is a 32 px external-link icon button, and "Save to: Gateway Studio" no longer repeats Mode.

## 0.50.27 — 2026-11-13

- The extension now has exactly two modes: Standalone (the default) and Gateway Studio. The old Story Studio mode was removed.
- A saved Studio choice, or any unknown saved mode, moves to Standalone on load.
- Standalone pastes prompts, uses your chosen provider, and saves images to Downloads. Gateway Studio keeps the Gateway connection fields, dispatch controls, and the same generation settings.
- Story Studio connection, project, episode, scene, reference and save-back code was removed, along with its host permissions.

## 0.50.26 — 2026-11-13

- Flow RPC ids are no longer hard-coded in the shipped command: a MAIN-world recorder learns them from the live page's own batchexecute exchanges, resolved per page load, with the previous ids kept only as a configurable fallback in Settings (Flow request ids, advanced).
- An id that cannot be resolved is named with what was tried, in the panel and at worker start ("Account probe failed: …; manual work still works") — never collapsed into "signed out".
- Tests simulate a changed id, discovery failing to fallback, and both failing, without hard-coding any expected id.

## 0.50.25 — 2026-11-13

- A signed-in Flow project whose account probe fails is no longer treated as signed out: the extension falls back to the visible signed-in page with an unknown balance (images are free) and claims, instead of refusing every job.
- The panel now distinguishes "needs a signed-in Flow tab" from "Flow is open but Relay could not read the account (<error>). Retrying on the next check", so a moved Flow RPC id blames the probe, never the person.

## 0.50.24 — 2026-11-12

- Google Flow settings were removed; the address is fixed.
- The options page now shows only the working mode, the Story Studio connection (outside Gateway mode), and the Gateway Studio block.

## 0.50.23 — 2026-11-12

- The alarm listener writes `gatewayAlarmFiredAt` (with the alarm's period) before the claim loop runs, so an alarm that exists but never fires is visible. The panel also names a selected Gateway mode whose connection is not enabled in Settings.

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
