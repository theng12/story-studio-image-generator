# Story Studio Bulk Asset

Image-only Manifest V3 extension for Story Studio KH. It reads scene and
thumbnail prompts, generates images sequentially through the selected provider,
and saves them back to Story Studio or Downloads with canonical filenames.

Video generation is intentionally separate in the sibling
`story-studio-video-generator` extension.

## Image providers

- Google Flow
- Google AI Studio
- Qwen Studio
- Grok Imagine
- Perchance
- FreeGen
- Leonardo AI
- Pollinations
- PicLumen
- ChatGPT

The persistent background queue survives side-panel closure and service-worker
termination. It deduplicates by provider and scene identity, honors persisted
human pacing and provider cooldowns, and processes one image at a time.

Scene-plan images, scene-prompt images, and thumbnail images keep their existing
Story Studio ingestion routes and naming contracts. Character references remain
available for Flow, Qwen, AI Studio, and ChatGPT character scenes. Downloads use
the configured directory and filename templates.

## Security boundaries

- Flow commands run as one-shot MAIN-world injections; no page-visible
  `postMessage` command listener remains.
- Provider-returned image URLs are HTTPS/hostname allowlisted and fetched
  without credentials.
- The Pollinations token is stored only in local extension storage.
- Grok request headers are session-bound and are not persisted.
- Fleet Hub control commands require authenticated responses.

## Install

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this folder.
3. Configure Story Studio and provider preferences in Settings.
4. Pick a project and episode in the side panel, load scene or thumbnail
   prompts, select images, and queue the batch.

There is no build step. Reload the unpacked extension and any open provider tabs
after source changes.
