# What's new — Story Studio Bulk Asset

Most recent first. Reload the extension (`chrome://extensions` → Reload) to pick up a new version.

## 0.31 — Fleet Hub picker support
- **Pick projects and episodes in the hub instead of typing codes.** The hub can't reach your Story Studio directly (it's behind login), so when you open the Distribute picker an online machine fetches the project/episode list for it on demand and reports it back. No more copy-pasting slugs and episode codes — choose from dropdowns, with a ✓ marking episodes that already have images.

## 0.30 — Fleet dispatch (scene-level fan-out)
- **The Fleet Hub can split one episode across all your machines.** Pick a project + episode + provider in the hub and it hands each online machine (on that provider) small batches of the episode's missing scenes, topping them up as they finish — so one episode completes ~Nx faster instead of each machine taking a whole episode. Scenes from a machine that goes offline or into cooldown are reclaimed and reassigned, and failures retry elsewhere. Requires all machines to share one Story Studio.

## 0.29 — Fleet Hub agent
- **Report to a Fleet Hub**: with a hub URL + machine name in Settings, the extension reports this machine's queue status (progress, state, cooldown) to a central dashboard and obeys pause/resume/retry/clear commands — so you can watch and control several Minis from one computer. See the separate story-studio-fleet-hub app.

## 0.28.4 — Qwen reference double-upload fix + pacing
- Fixed Qwen attaching the character reference **twice** (then stalling after 2–3 scenes). A slow upload of a large character sheet timed out the old 10s wait and fired a second paste, leaving two references. Now it waits up to 25s before any retry, waits for the chip count to **settle and trims to exactly one**, and **paces the steps** — upload → settle → type prompt → settle → (verify one chip) → send — with generous leeway so nothing races.

## 0.28.3 — Completion-wait safety net across providers
- Made "finish + save before the next prompt" a uniform guarantee. The queue already saved each image before starting the next item for **every** provider; this hardens **AI Studio** — the one image adapter that accepted the first frame it saw — to wait for the image to settle before returning, matching Qwen / FreeGen / Leonardo / Perchance / ChatGPT, which already wait for their generator to finish.

## 0.28.2 — ChatGPT waits for generation to finish
- ChatGPT now **waits until the image has fully finished generating** (its stop button clears) before it saves and moves on — so the queue never fires the next prompt while the previous image is still cooking. Send → wait → receive → save → *then* the human-pace gap → next. (A stability safety-net still applies if the stop button can't be detected.)

## 0.28.1 — ChatGPT image-capture fix
- Fixed ChatGPT jobs getting stuck on **"running"** after the image had already generated: the "still generating?" check was fooled by the composer's voice/dictation button, so the finished image was never accepted and saved. Now it keys off the real generation stop button plus a stabilization fallback (accept once the image URL is stable for a few seconds), and detects the image more robustly. **Reload the ChatGPT tab** after updating so the new adapter loads.

## 0.28 — New provider: ChatGPT
- **ChatGPT (chatgpt.com) added as an image provider (text-to-image).** Drives your signed-in chat like the AI Studio/Qwen providers: it sends "Create a &lt;ratio&gt; image of …" and reads back the generated image. **Keep the ChatGPT tab visible** while it runs.
- **Pin which ChatGPT chat to drive:** open the chat you want and click **Use current tab** in the ChatGPT card — the queue navigates to that exact conversation before each generation (so it's not confused by your other open chats).
- The free image quota is small; when it's hit the queue **pauses** (auto-resume off by default) so you can rotate to the next provider.
- Character-reference (img2img via paste, like Qwen) is planned for a later update.
- **Aspect-ratio control for the chat providers.** AI Studio and ChatGPT now have their own aspect-ratio dropdown (16:9 / 9:16 / 1:1 / 4:3 / 3:4), and all chat-driven providers (AI Studio, Qwen, ChatGPT) reinforce it in the prompt ("Create a &lt;ratio&gt; image of …") — AI Studio previously ignored the ratio.
- ChatGPT and PicLumen tabs now **auto-recover their connection** if the tab was open from before the extension loaded (previously they'd loop "Provider tab interrupted"). Reloading the provider tab still works as before.
- **QoL: "↗ Open <provider>" shortcut** under the provider selector — one click focuses that provider's generation tab (or opens it), and it updates as you switch providers. Hidden for Pollinations (no tab).

## 0.27 — New provider: PicLumen
- **PicLumen (piclumen.com) added as an image provider (text-to-image).** Uses your signed-in session and its API (model *PicLumen Art V1*); aspect ratios pass straight through. Free tier is ~10 **Lumens**/day (1 per image).
- When the free daily quota runs out the queue **pauses** (auto-resume off by default) so you can rotate to the next provider — flip on auto-resume in the Provider cooldown card if you'd rather it retry after the daily reset.
- Character-reference (img2img) support on PicLumen is planned for a later update.

## 0.26 — Unified per-provider auto-resume, cooldown & retries
- **One place to control what happens when a provider hits a limit.** A new **Provider cooldown** card (under Human Pace) replaces the scattered Flow (Options page) and Qwen (Qwen card) cooldown settings. It follows the selected provider, so each one — Flow, Qwen, AI Studio, Grok, Leonardo, FreeGen — gets its own setting.
- **Auto-resume is now available for every provider that detects its limit** (previously only Flow & Qwen). It **defaults off** (the queue pauses and waits for Resume, as before). Turn it on and the extension suggests a recommended cooldown — **15m / 30m / 1h / 8h / 12h / 24h / Custom** — that you can change per provider.
- **Retries on failure.** When a provider's auto-resume is on, you can also set how many times a failed generation is retried before it's marked failed.
- **Live cooldown countdown** shows in the card and status line, and can always be overridden by pressing **Resume**.
- Note: because auto-resume now defaults off, re-enable it per provider in the panel if you relied on Flow/Qwen auto-resuming before. Each provider starts from a recommended cooldown you can adjust.

## 0.25 — Panel reorder + per-provider cooldown
- **The panel now follows how you actually work, top to bottom:** provider → what to make → save target → that provider's options (image model, aspect ratio, character reference) → human pace → Studio connection / project / episode → scenes → Queue selected. Picking the provider is now the first thing you do.
- **A provider's quota cooldown no longer blocks the other providers.** A Qwen quota wait used to pause the *whole* queue, so switching to Google Flow still sat idle. Now a cooldown only holds items for the provider that hit the limit, and pressing **Resume** clears every provider's cooldown.
- Fixed the character-reference row not hiding in Flow video mode (it pointed at an element that no longer existed).

## 0.24.5 — Qwen send reliability
- **Waits for Qwen's Send button to be ready before clicking.** After typing a prompt, the extension now polls up to 8s for Send to be present/visible/enabled instead of a single quick check — so a slow post-attachment enable can't be mistaken for an unavailable button.

## 0.24.4 — Qwen reference double-paste on large sheets
- **No more double references on large character sheets.** The retry could fire a second paste while a big sheet was still uploading, leaving two references attached at generation time. Now it pastes once, waits up to 10s for the attachment chip, only clears + re-pastes if none landed, and trims to exactly one as a safety net.

## 0.24.3 — Fixes
- Guarded content-script relays against "Extension context invalidated" after an extension reload.

## 0.24.2 — Qwen reference upload reliability
- **Qwen img2img reference now attaches via paste** (the drag-drop worked on the first scene but failed on the ones right after a generation). Paste attaches reliably every scene, with a retry if it doesn't land.

## 0.24.1 — Fix Qwen reference upload
- **Qwen img2img now actually attaches.** The reference is added by a real drag-drop (a plain file-input set was silently ignored inside a conversation) and detected via Qwen's own attachment chip — fixing "did not accept the reference image upload." Leftover attachments are cleared first so they don't stack.

## 0.24 — Qwen quota auto-resume
- **Qwen auto-pauses on its quota and resumes itself.** When Qwen says it's out (~30 images/window), the queue waits (Qwen's stated time if given, otherwise a configurable ~8h) and resumes on its own — with a live countdown. If it resumes too early it just re-pauses, so an off estimate is harmless. Toggle + fallback hours in the Qwen card.

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
