# Image Provider Cleanup Design

## Goal

Reduce the Image Generator to five maintained providers and make provider-specific
behavior discoverable from one small registry instead of repeated lists and
conditionals across the worker and side panel.

## Provider Scope

Keep:

- Google Flow (`flow`)
- Google AI Studio (`aistudio`)
- Qwen Studio (`qwen`)
- Leonardo AI (`leonardo`)
- ChatGPT (`chatgpt`)

Remove:

- Grok Imagine (`grok`)
- Perchance (`perchance`)
- FreeGen (`freegen`)
- Pollinations (`pollinations`)
- PicLumen (`piclumen`)

Removal includes adapters, bridges, manifest hosts and content scripts, settings,
cooldowns, panel controls, dispatch branches, error copy, and documentation. Stored
queues using a removed provider must not silently fall through to another provider;
pending items are marked failed with a clear removed-provider message. Historical
completed items remain readable.

## Architecture

Create `src/lib/providers.js` as the single source for maintained provider metadata:

- stable ID and display label;
- provider page URL and tab match pattern when a page is required;
- optional content-script reinjection metadata;
- capabilities such as character reference, live model discovery, cooldown support,
  and whether the active tab must remain visible;
- the small settings schema needed to render ordinary provider controls.

The registry is data, not a plugin framework. Provider execution remains explicit
code because Flow, conversational providers, and Leonardo have materially different
contracts. `background.js` uses a handler map instead of a provider `if/else` chain,
and `popup.js` derives the provider picker, shared capability behavior, and ordinary
settings controls from the registry.

Leonardo keeps its custom live-sync controls because they are genuinely model-aware.
The other four providers use only the settings they need:

- Flow: known model, ratio, and reCAPTCHA-attempt settings.
- AI Studio: requested ratio; model remains selected on the provider page.
- Qwen: requested ratio; model remains provider-controlled.
- ChatGPT: requested ratio and maximum wait; model remains provider-controlled.

No dependency, generic plugin loader, runtime manifest generator, or remote provider
configuration is introduced.

## Model Discovery

Model behavior is explicit per provider:

- Leonardo implements optional live discovery through `listModels()` and
  `modelControls()`. A sync refresh can expose new models without an extension
  release while the site's selectors remain compatible.
- AI Studio, Qwen, and ChatGPT use the model selected or supplied by their website.
  A provider-side model addition needs no extension change unless its workflow or DOM
  contract changes.
- Flow's internal model IDs are not safely discoverable. Its validated model mapping
  stays local and requires a code update when Google adds or changes an internal ID.

Adding a completely new provider always requires an extension release because Chrome
Manifest V3 host permissions and content scripts are static.

## Queue And Storage

Queue persistence, sequential processing, deduplication, pacing, cooldown behavior,
Fleet Hub reporting, Story Studio ingestion, standalone downloads, and character
reference behavior remain unchanged for maintained providers.

Settings normalization removes obsolete provider defaults and cooldown entries while
preserving all maintained settings. Existing stored selections for a removed provider
fall back to Flow only for future UI selections; already queued removed-provider work
fails explicitly instead of being regenerated elsewhere.

## Interface

The side panel shows only the five maintained providers. Shared controls are driven by
capabilities, so unsupported settings are absent rather than hidden through repeated
provider-specific checks. Leonardo's custom sync panel remains visible only for
Leonardo.

The visual layout and established Story Studio styling remain unchanged. This is a
behavioral and maintenance cleanup, not a redesign.

## Verification

Add dependency-free tests using Node's built-in test runner for:

- the exact maintained provider set and unique IDs;
- registry defaults and capability lookup;
- normalization of a removed saved provider to Flow;
- preservation of maintained provider settings;
- explicit rejection of queued removed-provider items;
- manifest absence of removed hosts and content scripts;
- manifest presence of every required maintained provider script.

Run all tests, `node --check` for every JavaScript file, manifest parsing and declared
file checks, `git diff --check`, and the repository's full verification commands.
Reload the unpacked extension and smoke-test at least one maintained web provider when
Chrome control is available.

## Release

Bump the extension version and add a changelog entry describing the five-provider
catalog, removed-provider queue handling, and centralized provider configuration.
Commit and push verified implementation to `main`.
