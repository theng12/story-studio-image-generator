# What's new — Story Studio Image Generator

Most recent first. Reload the extension from `chrome://extensions` to pick up a
new version.

## 0.50.16 — 2026-11-12

- Reads the signed-in Flow account (opaque id) and remaining credits in the worker, and reports them to Gateway with each claim. Neither is derived from a profile, cookie or email.
- Claims and runs a Gateway image job once the user has entered that model's credits-per-image price. A price is never guessed: blank means unknown, and unknown work is never claimed or generated.
- Reports job progress to Gateway and adds a **Claim now** button in the side panel.
- Reads Flow's model list from the signed-in page: a bundled model counts as live only while that page shows its exact label, so an unobserved or signed-out page still claims nothing.
- Matches Flow's picker as it is now: "Nano Banana 2.1" and "Nano Banana 2 Lite". "Nano Banana Pro" is gone, and a name the picker no longer shows is never matched loosely.
- Uses the model key Flow actually receives (`BELUGA` for Nano Banana 2.1).
- Submits 16:9 and 9:16, the two ratios with a real submit behind them; 4:3, 1:1, 3:4 and any size are refused for having no observed value instead of being guessed. Counts of 1, 2 or 4 are carried.
- Records honestly that the per-image price is yours to declare: Flow shows no credits line and the balance did not move across a generated image.

## 0.50.15 — 2026-11-11

- Adds Gateway Studio mode: pair this extension with Gateway as an image worker. Off by default.
- Works on at most one Gateway image job at a time and keeps human pacing, with a default 5–15 second gap between provider requests.
- Applies Gateway's stop and pacing settings before confirming them, and keeps the stop after a browser restart.
- Labels Google Flow's bundled models honestly; Gateway jobs need a live model capture before they can run.
- Never invents account or credit details; new Gateway generation waits for an exact quote.
- Keeps already-generated Gateway images deliverable after a stop, without generating again.

## 0.50.14 — 2026-11-11

- Apply Gateway dispatch stops and pacing before acknowledging them, and retain the stop after restart.
- Report actual queue activity and pacing eligibility while paused, busy or held, without inventing account or credit observations.
- Keep quote previews read-only and refuse new Gateway generation until the exact provider account and quote can be verified. Retained results can still be delivered.
- Preserve fractional custom pacing and longer waits.
- Changing or clearing the Gateway address keeps the manual queue working instead of failing with an invalid-address error.

## 0.50.13 — 2026-11-11

- Default to a random 5–15 second gap after each generation; keep saved custom delays, including Off.
- Wait for the saved pacing gap and Flow cooldown before claiming another Gateway job, including after a restart.

## 0.50.12 — 2026-11-10

- Label Flow's bundled models honestly while keeping manual Story Studio and Standalone generation available.
- Keep Gateway work stopped when Flow's current model availability cannot be verified.

## 0.50.11 — 2026-11-10

- Keep duplicate Gateway jobs held for review after the extension restarts, without generating again.

## 0.50.10 — 2026-11-09

- Added an optional Gateway Studio mode alongside Story Studio and Standalone.
- Keep references and completed images when a connection is interrupted, without generating again.
- Deliver a retained image again from its queue entry after checking the connection.
- Gateway mode requires a compatible server with image workers enabled.

## 0.50.9 - One queue-all action

- Removed the duplicate **Queue all pending** link below the prompt list. The
  remaining boxed action continues to queue every missing image in the project.

## 0.50.8 - Earliest episodes first

- **Queue all pending** now sorts eligible episodes by episode number before
  loading prompts, so generation starts with the earliest unfinished episode.

## 0.50.7 - Queue and episode cleanup

- Added **Clear completed** to remove finished queue history without touching
  pending, running, or failed jobs.
- **Clear pending** now removes only pending jobs and preserves completed,
  failed, and currently running work.
- Scene episode filters now honor Story Studio's **Mark as done** state and
  show **Pending** instead of an unhelpful `0/0` when no image count exists.
- Refresh only the completed episode's status after its queued images settle,
  so it leaves **To do** immediately without rescanning large projects.

## 0.50.6 - Google Flow moved

- Followed Google Flow to its new home at **flow.google.com** and its rebuilt
  app: image generation and reference upload now speak the new site's own
  protocol. The old address stopped working entirely, which is what made
  every image fail and opened a useless tab per episode.
- Added **Settings → Google Flow → Flow address** with its own Grant site
  access button, so the next time Google moves Flow you paste the new address
  instead of waiting for an update.
- Flow's create-project button is not available on the new app yet; auto
  rollover keeps the current project instead of failing the batch.

## 0.50.5 - One provider tab, ever

- Stopped **Queue all pending** (and any other action that needs a provider
  tab) from opening a new Google Flow tab per episode. The extension now
  remembers the tab it opened, serialises overlapping requests, and no longer
  hangs when a tab finished loading before it started watching.

## 0.50.4 - Clear failed jobs

- Added **Clear failed** to Queue actions so a batch that finished with
  failures can be dropped and re-queued from scratch instead of lingering in
  the list. Provider cooldowns are left alone.

## 0.50.3 - Marked-done thumbnail batches

- Treated Story Studio's existing thumbnail **Mark as done** state as
  authoritative even when old image files have been removed.
- Enabled **Queue all pending** for thumbnails so one confirmed action loads
  every pending episode's Thumbnail Prompts and adds its missing images to the
  persistent queue.
- Made episode progress and helper copy follow the selected scene or thumbnail
  image type.

## 0.50.2 - Unified prompt loading

- Renamed the shared project action to **Load image prompts** so the same button
  clearly covers both Scene Plan and Thumbnail Prompts modes.

## 0.50.1 - Thumbnail asset integrity

- Filtered thumbnail episodes using Story Studio's aggregate files-on-disk
  status instead of historical workflow completion flags.
- Switching between scene and thumbnail generation now refreshes episode
  counts and selects the first episode that is actually missing that asset.
- Kept project loading to one aggregate episode request, including for large
  projects, rather than checking thumbnail status episode by episode.

## 0.50.0 - Image Generator hardening

- Serialized queue mutations so panel, alarm, recovery, and Fleet actions cannot overwrite one another.
- Deduplicated active standalone work by provider, normalized prompt, asset kind, and generation settings while allowing deliberate requeue after completed or terminal history.
- Snapshotted model IDs, labels, and generation settings at enqueue and failed closed before submission when a signed provider selection was unknown or changed.
- Discovered exact Flow model IDs and labels read-only from the signed workspace, reported live versus tested-fallback provenance, and rejected removed/stale live selections before submission.
- Kept Flow’s three tested fallback IDs and reported provider-controlled identity for web model pickers that expose no stable label.

## 0.49.3 - Aggregate episode image progress

- Replaced one Scene Review request per episode with Story Studio's aggregate
  planned-image progress from the `/episodes` response.
- Episode filtering, progress labels, and Queue all pending now use the same
  completion rule: every planned image exists, independent of review approval.

## 0.49.2 - Scene Plan safety

- Prevented project scene jobs without stable Scene Plan IDs from reaching an
  image provider or the retired scene image-ingest endpoint.
- Retired persisted Scene Prompts jobs safely and blocked them from local or
  Fleet retries while preserving completed history.
- Removed Scene Prompts fallback from current-episode and project-wide scene
  discovery; thumbnails continue to use Image Prompts.

## 0.49.1 - Safer queue recovery

- Prevented Leonardo jobs with unknown or post-submit outcomes from spending
  paid tokens again through automatic retry; the queue now asks for a manual
  tab check first.
- Rejected explicit invalid provider IDs instead of silently redirecting them
  to Flow, and preserved retired provider names in failure history.
- Fixed project-wide queueing and now reports partial per-episode failures
  without hiding successful queue counts.

## 0.49.0 - Simplified providers and Story Studio references

- Reduced the maintained catalog to Google Flow, Google AI Studio, Qwen Studio,
  Leonardo AI, and ChatGPT; retired-provider jobs now fail safely instead of
  retrying on an unsupported adapter.
- Centralized provider capabilities and reference limits in the provider
  registry.
- Added Story Studio multi-reference ingestion with per-provider caps: Flow,
  AI Studio, and ChatGPT accept up to four references; Qwen accepts one;
  Leonardo remains manually managed in its provider tab.
- Replaced the character picker with the single **Use Story Studio references**
  setting.

## 0.47.24 — Mode control consistency

- Replaced Image Generator's segmented mode switch with the shared Story Studio / Standalone dropdown.

## 0.47.23 — Standalone batch review

- Reworked standalone prompt entry into a full-width paste surface.
- Split non-empty prompt lines into reviewable image tasks before queue approval.

## 0.47.22 — Standalone mode

- Restored local-prompt generation with completed images saved to Downloads.

## 0.47.21 — Trailing disclosure controls

- Moved expandable-row chevrons to the trailing edge, matching Audio and Video.

## 0.47.20 — Compact Studio test action

- Replaced Image Generator's boxed Studio status with the shared compact test
  action row; the recovery action appears only after a failed test.

## 0.47.19 — Connection-card consistency

- Standardized the Story Studio connection guidance, actions, credentials, and
  sign-in feedback with the other generators.

## 0.47.18 — Purple product accent

- Updated Image Generator's primary, link, and focus colors to match its
  purple icon identity.

## 0.47.17 — Settings structure

- Split Appearance, Story Studio connection, and Fleet Hub into separate
  Settings sections.
- Standardized the full-width primary Save action with the other generators.

## 0.47.16 — Single provider settings surface

- Removed duplicated image-provider controls from global Settings.
- Provider model, style, ratio, workspace, pacing, cooldown, and recovery
  choices now live only in the side panel where the batch is configured.

## 0.47.15 — Connection recovery and settings

- Failed side-panel connection tests now offer a direct **Update Studio URL**
  action.
- Standardized the Settings layout and added an explicit connection test.

## 0.47.14 — Interface polish

- Unified panel spacing, controls, disclosure chevrons, and typography with the
  other Story Studio generators.
- Removed the redundant in-panel product heading; Chrome's side-panel heading
  remains the single product title.

## 0.47.13 — Story Studio KH only

- Removed standalone prompts and the Downloads save path.
- Image generation now requires a Story Studio KH project and saves back to its
  episode.

## 0.47.12 — Workspace action

- Standardized the right-aligned **Open workspace** button in the setup area.

## 0.47.11 — Working modes

- Added an explicit Story Studio / Standalone mode switch, defaulting to the
  connected Story Studio workflow.
- Standalone generation now accepts one local pasted prompt and saves only to
  Downloads.
- Story Studio connection testing is now a visible status action with its last
  tested time.

## 0.47.2 — Metadata refresh

- Simplified public metadata for **Story Studio Image Generator**.

## 0.47.1 — Product naming

- Updated the product name to **Story Studio Image Generator**.

## 0.47.0 — Product split

- Image and video workflows now live in separate, focused extensions.
- Improved security, reliability, and local handling of service data.

## Earlier releases

- Ongoing improvements to generation, queueing, asset organization, and
  integrations.
