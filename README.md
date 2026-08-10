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
update. Leonardo is the exception: its model list is read from the signed-in
Leonardo page when you refresh models in the side panel.

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

There is no build step.

## Notes

- Requires a running Story Studio KH workspace.
- The queue is designed to survive closing and reopening the side panel.
