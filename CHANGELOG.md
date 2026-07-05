# What's new — Story Studio Bulk Asset

Most recent first. Reload the extension (`chrome://extensions` → Reload) to pick up a new version.

## 0.23 — Qwen phase note + character toggle
- **Qwen shows its live sub-phase** in the status line — "uploading reference…" vs "generating…" — so a long img2img batch is easy to watch.
- **"Use character reference this run"** toggle — flip the character reference on/off per run without losing the picked character.

## 0.22 — Generation status bar
- **A prominent status bar above the Queue**: green + glowing while generating, **orange while paused**, grey when idle — so you can tell at a glance whether it's running or stopped.
- Live **done / failed / left** counts right in the bar.

## 0.21 — Qwen img2img + unblock
- **Qwen auto-dismisses the "which response do you prefer?" A/B prompt** so batches no longer stall waiting for you to pick a side.
- **Qwen character reference (img2img)** — pick a character in the panel and its Story Studio sheet is uploaded into Qwen before each character scene. Qwen consumes the image per generation, so it re-uploads every time.

## 0.20 — What's new
- **This panel.** A "✨ What's new" button in the header opens the changelog, with a red dot when there are updates you haven't seen yet.

## 0.19 — Qwen provider
- **New provider: Qwen Studio** for image generation.
- Aspect-ratio prompting reinforced so Qwen honours the scene's ratio.

## 0.18 — AI Studio, pacing & reCAPTCHA resilience
- **New provider: Google AI Studio** (Imagen/Gemini image generation).
- **Human-pace controls in the panel** — set the min/max delay between requests without opening Settings. Slower, more human-looking cadence reduces the chance of tripping Flow's abuse detection.
- **Live wait countdown** — the "waiting Ns before the next request" status now ticks down live.
- **Flow reCAPTCHA: auto-resume after a cooldown** and a **configurable retry count**, so a temporary score dip pauses and recovers instead of failing scenes.
- **Extension version now shows in the panel header.**
- **Custom queue selection quantity** — pick your own batch size, not just the presets.
- AI Studio: better prompt-error detection; fewer unnecessary page reloads.
- Fixed the Leonardo tab connection.

## 0.17 — Flow character reference
- **Character reference for Flow images**, gated by `scene_type` so it only applies where it should.

## 0.16 — Big side-panel UX pass
- **Episode progress counts** in the dropdown (e.g. `EP0026 — Title · 66/115`).
- **Queue all pending** — queue every missing scene across all pending episodes at once.
- **Live per-scene status** — each scene row shows ✓ done / ⟳ running / ✗ failed as the queue runs.
- **Edit prompts inline** — double-click a scene prompt to tweak it before queueing.
- **Select failed** — one click re-selects only the scenes that failed.
- **Scene search** — filter a loaded episode's scenes by number or text.
- **Tab-visibility reminder** while a tab-based provider is running.
- Episodes now **sort numerically**, and the To do / Done / All filter stays accurate using live counts.

## 0.15 — Episode filter & prompt preview
- **To do / Done / All** episode filter so you can skip finished episodes without loading them.
- **Click a scene prompt to expand** the full text (hover for a tooltip).

## 0.14 — Pollinations (headless)
- **New provider: Pollinations** — a keyless image API that runs **with no browser tab at all** (fully background), sidestepping the keep-the-tab-visible requirement. Rate-limit aware.
- Flow: retry image generation on an intermittent reCAPTCHA rejection instead of failing the scene.

## 0.13 — Per-provider controls in the panel
- **Google Flow, FreeGen, and Perchance controls moved into the side panel** (model, aspect ratio, style, images, etc.) — no more Options round-trips.
- **Grok note**: its options are set on the Grok page and applied automatically.
- Fixed Grok capturing the wrong request as its generate template.

## 0.8–0.12 — Leonardo & queue foundations
- Leonardo: **live model refresh**, **adaptive per-model controls**, **images-per-generation**, reference-image detection, and limit-aware pausing.
- Queue **Pause / Resume**, persistent failed-job "Technical details", and batch quick-select.

## 0.1–0.7 — Initial build
- Flow image + Veo video generation, Grok Imagine, thumbnails, image-to-video, the resumable/dedupe queue, portable Story Studio connection, and the side-panel workflow.
