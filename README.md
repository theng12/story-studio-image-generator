# Story Studio Image Generator

A Chrome extension for creating and organizing scene images for Story Studio projects.

## What It Does

- Works with scenes from a connected Story Studio project.
- Lets you choose an episode, select the scenes to process, and configure the available image settings for a batch.
- Runs selected work through a persistent queue with progress, pause, retry, and recovery controls.
- Saves finished images back to the connected Story Studio project workspace.

## Workflow

1. Open the side panel and connect a Story Studio project.
2. Select an episode, then choose the scenes to create images for.
3. Queue the selected work and monitor its status in the active batch view.
4. Let the extension save each completed image back to its episode.

## Availability

Image generation uses a compatible signed-in browser session. Available settings, capacity, and limits depend on the session you are using.

## Providers And References

The maintained image providers are Google Flow, Google AI Studio, Qwen Studio,
Leonardo AI, and ChatGPT. The extension keeps its provider catalog in one
registry so removed providers never receive new work or retries.

- Google Flow accepts up to 4 Story Studio references per image.
- Google AI Studio and ChatGPT each paste and verify up to 4 references.
- Qwen Studio uses the first reference only and keeps its one-attachment safety
  check.
- Leonardo AI does not support Story Studio auto-ingest. Attach references in
  the Leonardo page when needed.

Enable **Use Story Studio references** in the side panel to pull available
episode, scene, character, composition, and style assets. The queue stores
only reference descriptors and downloads the bounded image bytes when a job
runs.

New provider integrations and most new provider models require an extension
update. Flow currently uses bundled model records for manual work; its model
list does not verify current availability or sign-in. Leonardo reads its
signed-in page when you refresh models in the side panel.

## Model Identity And Queue Safety

Queued work snapshots its model identity and generation settings, so active
batch diagnostics show the configuration that was actually queued. Flow's
three bundled model IDs remain available for manual Story Studio and Standalone
work with fallback provenance. There is currently no verified Flow live inventory
capture. Gateway claims and submissions require captured live inventory and
refuse bundled or unavailable data. Opening a tab or retaining an old inventory
does not meet that requirement. Google AI Studio, Qwen Studio, and ChatGPT
remain website-controlled, while Leonardo is live-discovered. Unknown or
changed verifiable selections fail before submission and require refresh and
re-queue.

## Discovery And Control Parity

The current requirement is for all three sibling extensions to refresh provider
model listings as new models appear and to account for newly exposed controls
and duration choices. A known model, an observed control, an authenticated
current listing, a supported request schema, and verified generation are separate
facts. Preserve that distinction when showing or forwarding provider data.

Image's remaining gaps are explicit:

- Flow's model list is observed from the page, not from a backend listing: a
  bundled record counts as live only while the signed-in Flow page shows its exact
  label as a line of its own. A closed picker, a signed-out tab or an unlabelled
  page leaves both records as manual fallback choices and claims nothing. The
  catalogue carries the two labels the picker shows — "Nano Banana 2.1" and
  "Nano Banana 2 Lite" — and a label it no longer shows is never fuzzy-matched.
- Gateway Image maps the observed Flow model keys (`BELUGA` for Nano Banana 2.1,
  `HARBOR_SEAL` for Nano Banana 2 Lite), the two ratios with a real submit behind
  them (16:9 sends 3, 9:16 sends 2), counts of 1, 2 or 4, up to four references and
  the Flow project ID. 4:3, 1:1, 3:4 and `size` have no observed submit value and
  are refused at claim rather than guessed. The count slot is unproven: the
  capture carried `null` there with a count of 1.
- Flow images are **free**: an unset price quotes 0 credits, and 0 is a real
  price, never "unknown". The Settings field only overrides it for anyone who
  wants to declare something else. Nothing is read from the page: Flow shows no
  credits line and the balance did not move across generated images (50 before
  and after one run, 30 before and after another). A zero balance never refuses a
  free job.
- Story Scene Review rows are reduced to image identity, prompt and image-state
  fields in `loadScenePlan`, then mapped again at enqueue. Scene duration and
  additional caller controls have no preservation mapping in that path yet.
  `durationMs` measures queue processing time; it is not scene duration.
- No Story/Gateway scene-duration field contract has been verified for this
  image path. Preserve caller-supplied duration/control values once their actual
  contract is known; report a missing counterpart mapping rather than silently
  dropping, defaulting, coercing or inventing a field. Scene duration is metadata
  and does not introduce image-to-video generation into this extension.

Before a release claims parity, trace each supported control through provider
capture, selection, queue snapshot and the applicable Story/Gateway caller.
Record unsupported fields and counterpart dependencies explicitly. Source and
offline fixtures alone do not complete live discovery or control acceptance.

## Pacing And Manager Contract

New settings default to a random 5–15 second gap after generation. The side
panel's Human pace controls retain nonnegative finite custom seconds, including
fractions, longer waits and Off (0–0). Bounds are ordered minimum to maximum;
random deadlines use millisecond resolution. A chosen wait keeps its persisted
deadline across worker restarts; edits during generation apply to the next gap.

The local `nextProviderRunAt` value is an epoch-millisecond deadline. Generation
waits for it and rechecks provider cooldown before starting. Gateway checks both
that deadline and `cooldownUntil.flow` before discovery/claim. Its existing
30-second polling alarm can add idle time after eligibility. Health and telemetry
continue during pauses, cooldowns and retained work so manager stops can apply.

Gateway schema-1 controls arrive on authenticated worker health/telemetry/claim
replies. `gatewayWorkerControl` persists a connection-bound dispatch stop before
applying new pacing and storing the acknowledged revision. Unknown or invalid
controls stop dispatch without acknowledging an unapplied revision. Local Resume
cannot override the manager stop. New provider submissions recheck the stop at
the persisted submission checkpoint; active generation may finish. Close requests
never kill Chrome, erase holds or clear unknown outcomes. Retained bytes can still
be delivered without generation. Desired pacing never shortens a chosen deadline
or provider cooldown, and an unchanged revision preserves explicit local edits.

`POST /api/workers/telemetry` sends `{workerId,kind:'image',telemetry}`. Its
`telemetry.state` reports actual activity, enabled/paused state, applied
`controlRevision`, observed timestamp, current pacing and `nextEligibleAt` as a
zoned ISO timestamp (null when paused/held). Connection and sign-in stay unknown
on a tick that is not claiming, because the account is only read when the worker
is eligible to claim.

`POST /api/workers/claim` adds `account` and, once priced, `quote`. The account is
the opaque Flow identity and remaining credits (`o30O0e`, `nzlxg`) read from the
signed-in Flow page in that same request; nothing is derived from a profile,
cookie or email, and the account block must repeat `telemetry.state` exactly.
`quoteRequired` is an unclaimed, read-only preview, never a generation request.
An unexpected executable offer is durably held, and legacy pending Gateway work
is retained for review. A quote needs the user's own credits-per-image price for
that model (Settings, blank by default): a price is never guessed, and an unknown
price means nothing is claimed or generated. Executable claims require a fresh
observation of that same provider/account in that same request, a matching exact
price, and the current applied control revision; a cached observation or
server-returned account binding cannot replace them. Progress is reported along
the job, and a quoted claim enqueues one ordinary queue item.
A pause acknowledgement during generating/recovering work does not authorize
closing Chrome. Gateway alone decides safe closure from fresh exact-revision
paused state, known idle/cooling/resting/waiting activity and absence of active,
held or durable unknown work.

Worker IDs and tokens identify a connection, not a Chrome profile/provider
account or shared credit pool. Fleet v2 separately sends extension-local
agent/machine/session IDs and configured pacing; those IDs are not attested
account identities. Relay owns shared image/video browser/account mapping,
account enablement and scheduling through Gateway's supplied account-worker
contract. The account ID must be provider-observed and opaque; profile IDs,
emails and cookies cannot substitute. No balance, universal allowance, reset
timezone or per-worker duplicate balance is inferred. Actual account/quote
capture and cross-extension scheduling still require integration and live proof.
Browser TTS is outside this image extension and remains optional/off in Relay.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

There is no build step.

## Notes

- Requires a running Story Studio KH workspace.
- The queue is designed to survive closing and reopening the side panel.
