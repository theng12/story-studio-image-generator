# Image Generator Hardening Design

## Goal

Finish the existing Image Generator cleanup without replacing its provider
architecture: make queue mutations race-safe, prevent accidental duplicate
standalone work, and make model identity truthful wherever a signed provider
session exposes it.

## Provider And Billing Boundary

Keep the released provider set unchanged:

- Google Flow
- Google AI Studio
- Qwen Studio
- Leonardo AI
- ChatGPT

The extension uses signed website sessions and their website quota or credits.
It must not accept developer API keys or add separately billed developer API
routes. Requests made by a provider's own signed web application remain allowed.

The existing provider registry remains the single metadata source. Do not add a
plugin framework, dependency, remote provider configuration, or generic form
renderer.

## Model Identity

Model behavior must match what each provider can prove:

- Leonardo keeps live model and control discovery from the signed-in page.
- AI Studio, Qwen, and ChatGPT keep the provider website as the model picker.
  When a stable selected-model label is readable, report and snapshot it for
  diagnostics and verify the same selection before execution. When no stable
  label is readable, mark the model as provider-controlled rather than inventing
  an identity. Do not maintain a duplicate catalog in the extension.
- Flow may refresh models only from exact provider-advertised internal IDs. If
  the signed session does not expose trustworthy IDs, retain the small tested
  fallback catalog and identify it as fallback data.

No queue item may silently substitute another model. An unknown or stale exact
model ID, or a changed verifiable website selection, must fail before provider
submission with instructions to refresh the signed provider page. Queue items
snapshot the model ID and available label at enqueue so later settings changes
cannot alter paid work already approved.

## Queue Correctness

Replace split `getQueue()` plus `setQueue()` read/modify/write sequences with one
serialized queue mutation boundary. The lock must cover the read, migration,
deduplication, mutation, and write so concurrent enqueue calls cannot overwrite
one another.

Deduplicate active standalone work by provider, normalized prompt, asset kind,
and generation settings. Completed and terminal history must not prevent a new
deliberate generation. Preserve project-scene identity, sequential processing,
pacing, cooldowns, recovery checkpoints, and Leonardo ambiguity handling.

## Preserved Contracts

Preserve the aggregate Story Studio episode-progress path, Scene Plan-only
project scenes, thumbnail ingestion, bounded multi-reference resolution,
standalone downloads, Fleet authentication, and all existing paid-work recovery
guards. Do not move video behavior into this extension.

## Verification And Release

Add dependency-free tests for concurrent queue mutation, active standalone
deduplication, terminal-history requeue, exact model snapshotting, and fail-closed
unknown model behavior. Retain all provider, reference, migration, manifest, and
episode-progress tests.

Run the full Node test suite, `node --check` on every JavaScript file, manifest
and declared-file validation, and `git diff --check`. Live-test one maintained
provider and Story Studio save-back when a signed tab is available. Bump the
manifest version, update the changelog, commit, and push.
