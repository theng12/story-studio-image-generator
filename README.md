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

- Flow has no verified live inventory capture in this source. Its three bundled
  model records remain manual fallback choices; dynamic Flow discovery is not
  complete and cannot establish Gateway eligibility.
- Gateway Image currently maps the captured Flow model IDs, 16:9 output,
  up to four references and the Flow project ID. Other providers, newly exposed
  controls and other aspect ratios have no verified Gateway mapping here.
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

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

There is no build step.

## Notes

- Requires a running Story Studio KH workspace.
- The queue is designed to survive closing and reopening the side panel.
