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

## Install

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository folder.
3. Open the extension from the Chrome toolbar to use the side panel.

There is no build step.

## Notes

- Requires a running Story Studio KH workspace.
- The queue is designed to survive closing and reopening the side panel.
