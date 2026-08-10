# What's new — Story Studio Image Generator

Most recent first. Reload the extension from `chrome://extensions` to pick up a
new version.

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
