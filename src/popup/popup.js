// Side-panel controller.
//
// The panel reads projects/episodes/scenes straight from the Story Studio
// server (it's an extension page, so it has host-permission to localhost), and
// hands batches to the background worker, which owns the Flow generation + the
// persistent queue. A confirmation step guards every batch so an accidental
// click can't burn work/credits.

import { getSettings, saveSettings } from '../lib/config.js';
import { StudioClient } from '../lib/story-studio.js';

const $ = (id) => document.getElementById(id);
let settings = null;
let client = null;
// Normalized items: { source, kind, key, label, prompt, hasImage, stale }
let currentScenes = [];
let currentSource = 'plan'; // 'plan' (scene_plan.json) | 'prompts' (03/04 prompts)
let loadedKind = 'scene'; // 'scene' | 'thumbnail' — what's currently loaded
let currentEpisode = null; // { code, title }
let currentProject = null; // { slug, name }

// The "Make:" selector encodes both the asset kind and media type.
const currentKind = () => ($('mediaType').value.startsWith('thumbnail') ? 'thumbnail' : 'scene');
const isVideoSel = () => $('mediaType').value === 'scene-video';
// Combined selection identity: 'scene' | 'video' | 'thumbnail'.
const selKind = () => (isVideoSel() ? 'video' : currentKind());
const humanDelayLabel = () => {
  const min = Number(settings?.humanDelayMinSec) || 0;
  const max = Number(settings?.humanDelayMaxSec) || 0;
  return min === max ? `${min}s` : `${Math.min(min, max)}-${Math.max(min, max)}s`;
};

async function init() {
  settings = await getSettings();
  client = new StudioClient(settings.studioBaseUrl);
  $('saveTarget').value = settings.saveTarget;
  $('provider').value = settings.provider || 'flow';
  $('includeExisting').checked = !!settings.includeExisting;
  $('showDoneEpisodes').checked = !!settings.showDoneEpisodes;
  await refreshFlowProject();
  await loadProjects();
  wire();
  onProviderChange();
  pollQueue();
  setInterval(pollQueue, 1500);
}

function wire() {
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('project').onchange = onProjectChange;
  $('loadScenes').onclick = loadScenes;
  $('refreshScenes').onclick = loadScenes;
  $('selectAll').onchange = (e) => {
    document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
      if (!c.disabled) c.checked = e.target.checked;
    });
    updateQueueButton();
  };
  $('batchControls').querySelectorAll('.batch-n').forEach((b) => {
    b.onclick = () => selectNextMissing(Number(b.dataset.n));
  });
  $('selectRemaining').onclick = selectRemaining;
  $('queueSelected').onclick = confirmQueue;
  $('clearQueue').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
    pollQueue();
  };
  $('retryFailed').onclick = async () => {
    const res = await chrome.runtime.sendMessage({ type: 'retryFailed' });
    if (res?.skippedPaid) setStatus(`Retrying ${res.retried}; ${res.skippedPaid} paid video needs its row Retry button.`, 'info');
    else if (!res?.retried) setStatus('No failed jobs to retry.', 'info');
    pollQueue();
  };
  $('saveTarget').onchange = () => {
    saveSettings({ saveTarget: $('saveTarget').value });
    flashSaved();
  };
  $('mediaType').onchange = onMediaTypeChange;
  $('provider').onchange = onProviderChange;
  $('includeExisting').onchange = () => {
    saveSettings({ includeExisting: $('includeExisting').checked });
    if (currentScenes.length) renderScenes();
    flashSaved();
  };
  $('showDoneEpisodes').onchange = async () => {
    await saveSettings({ showDoneEpisodes: $('showDoneEpisodes').checked });
    flashSaved();
    if ($('project').value) await onProjectChange();
  };
  $('useCurrentProject').onclick = useCurrentFlowProject;
  $('testConn').onclick = testConnection;
  $('confirmCancel').onclick = () => $('confirm').classList.add('hidden');
}

// ── Flow project ──────────────────────────────────────────────────────────
async function refreshFlowProject() {
  if (settings.flowProjectId) {
    $('flowProjectName').textContent =
      settings.flowProjectName || settings.flowProjectId.slice(0, 8) + '…';
  } else {
    $('flowProjectName').textContent = 'none selected';
  }
}

async function useCurrentFlowProject() {
  $('useCurrentProject').disabled = true;
  try {
    const ctx = await chrome.runtime.sendMessage({ type: 'flowContext' });
    if (!ctx?.ok) throw new Error(ctx?.error || 'Could not reach a Flow tab.');
    $('flowSignin').classList.toggle('hidden', !!ctx.signedIn);
    if (!ctx.projectId) {
      setStatus('Open a Flow project tab first (a /project/… URL), then try again.', 'err');
      return;
    }
    settings = await saveSettings({ flowProjectId: ctx.projectId, flowProjectName: '' });
    await refreshFlowProject();
    setStatus('Flow project captured.', 'done');
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  } finally {
    $('useCurrentProject').disabled = false;
  }
}

// ── Story Studio connection test ────────────────────────────────────────────
// Verifies the whole chain from where you actually work: for a remote/Tailscale
// URL it first checks host access was granted (Settings), then reaches the API.
async function testConnection() {
  const out = $('connStatus');
  const setConn = (t, color) => {
    out.textContent = t;
    out.style.color = color;
  };
  $('testConn').disabled = true;
  setConn('Testing…', 'var(--muted)');
  try {
    const url = settings.studioBaseUrl || '';
    const local = /localhost|127\.0\.0\.1/.test(url);
    if (!local) {
      let pat = null;
      try {
        const u = new URL(url);
        pat = `${u.protocol}//${u.hostname}/*`;
      } catch {
        /* invalid url */
      }
      const granted = pat ? await chrome.permissions.contains({ origins: [pat] }).catch(() => false) : false;
      if (!granted) {
        setConn('✗ No host access — open Settings → Grant access to this server.', 'var(--err)');
        return;
      }
    }
    const projects = await client.listProjects();
    const n = Array.isArray(projects) ? projects.length : (projects.projects || []).length;
    setConn(`✓ Connected — ${n} project${n !== 1 ? 's' : ''}.`, 'var(--ok)');
    await loadProjects(); // refresh the dropdown now that we're reachable
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    setConn(
      `✗ ${e.message}. ${local ? 'Is Story Studio running?' : "Check it's running, access granted, and you're logged in."}`,
      'var(--err)'
    );
  } finally {
    $('testConn').disabled = false;
  }
}

// ── projects / episodes ─────────────────────────────────────────────────────
async function loadProjects() {
  try {
    const projects = await client.listProjects();
    const sel = $('project');
    sel.innerHTML = '<option value="">— pick a project —</option>';
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.slug;
      opt.textContent = p.name || p.slug;
      opt.dataset.name = p.name || p.slug;
      sel.appendChild(opt);
    }
    if (settings.lastProject) {
      sel.value = settings.lastProject;
      if (sel.value) await onProjectChange();
    }
  } catch (e) {
    const local = /localhost|127\.0\.0\.1/.test(settings.studioBaseUrl || '');
    const hint = local ? 'is it running?' : 'is it running, did you Grant access + log in (Settings)?';
    setStatus(`Can't reach Story Studio at ${settings.studioBaseUrl} — ${hint} (${e.message})`, 'err');
  }
}

async function onProjectChange() {
  const sel = $('project');
  const slug = sel.value;
  $('episode').innerHTML = '';
  if (!slug) return;
  currentProject = { slug, name: sel.selectedOptions[0]?.dataset.name || slug };
  await saveSettings({ lastProject: slug });
  try {
    const rows = await client.listEpisodes(slug);
    // Default: only episodes that still need images (scene plan present, images
    // not all done). Toggle "Show episodes with all images" to include finished.
    const showDone = $('showDoneEpisodes').checked;
    // Qualifies if it has any prompt source (scene plan, scene prompts, or
    // thumbnail prompts). Default hides episodes whose scene images AND
    // thumbnails are both done; the toggle shows everything.
    const eps = (Array.isArray(rows) ? rows : rows.episodes || []).filter((e) => {
      const st = e.status || {};
      const hasSource = st.scene_plan || st.scene_prompts || st.thumb_prompts;
      const needsWork = !st.images || !st.thumbnails;
      return hasSource && (showDone || needsWork);
    });
    const esel = $('episode');
    esel.innerHTML = eps.length
      ? ''
      : `<option value="">— no episodes ${showDone ? 'with a scene plan' : 'needing images'} —</option>`;
    for (const e of eps) {
      const code = e.episode_code || e.code;
      const opt = document.createElement('option');
      opt.value = code;
      opt.dataset.title = e.title || '';
      const done = e.status?.images ? ' ✓' : '';
      opt.textContent = `${code} — ${e.title || ''}${done}`;
      esel.appendChild(opt);
    }
    if (settings.lastEpisode) esel.value = settings.lastEpisode;
  } catch (e) {
    setStatus(`Couldn't load episodes: ${e.message}`, 'err');
  }
}

// ── scenes ──────────────────────────────────────────────────────────────────
async function loadScenes() {
  const slug = $('project').value;
  const esel = $('episode');
  const code = esel.value;
  if (!slug || !code) {
    setStatus('Pick a project and episode first.', 'err');
    return;
  }
  currentEpisode = { code, title: esel.selectedOptions[0]?.dataset.title || '' };
  await saveSettings({ lastEpisode: code });
  const kind = currentKind();
  const video = isVideoSel();
  $('loadScenes').disabled = true;
  $('refreshScenes').disabled = true;
  setStatus(`Loading ${video ? 'scene clips' : kind === 'thumbnail' ? 'thumbnails' : 'scenes'}…`, 'running');
  try {
    let scenes;
    let label;
    if (video) {
      scenes = await loadSceneVideos(slug, currentEpisode);
      currentSource = 'plan';
      label = 'Scene Plan · motion';
    } else if (kind === 'thumbnail') {
      scenes = await loadThumbnails(slug, currentEpisode);
      currentSource = 'prompts';
      label = 'Thumbnail Prompts';
    } else {
      const r = await loadScenesFromEither(slug, currentEpisode);
      scenes = r.scenes;
      currentSource = r.source;
      label = r.source === 'plan' ? 'Scene Plan' : 'Scene Prompts';
    }
    currentScenes = scenes;
    loadedKind = selKind();
    renderScenes();
    const done = scenes.filter((s) => s.hasImage).length;
    const noun = video ? 'Clips' : kind === 'thumbnail' ? 'Thumbnails' : 'Scenes';
    const have = video ? 'have clips' : 'have images';
    $('scenesSummary').textContent = `${noun} (${label}) — ${done}/${scenes.length} ${have}`;
    const emptyMsg = video
      ? 'No animatable scenes. A scene must be approved, have an image, a motion prompt, and meet the minimum duration.'
      : `No ${noun.toLowerCase()} found for this episode.`;
    setStatus(scenes.length ? '' : emptyMsg, scenes.length ? 'info' : 'err');
  } catch (e) {
    setStatus(`Couldn't load: ${e.message}`, 'err');
  } finally {
    $('loadScenes').disabled = false;
    // Refresh stays live once an episode is loaded, so a cut-off run can be
    // re-pulled in place without touching the tab.
    $('refreshScenes').disabled = false;
  }
}

// Scene video (image-to-video). The SPEND GATE (enforced here — Story Studio
// can't block an external Veo spend after the fact): only show scenes that are
//   approved === true, motion_prompt non-empty, image exists, and
//   (end_sec − start_sec) >= animate_min_seconds.
// Among those, "done" = a fresh clip already exists; stale = clip rendered from a
// now-changed motion prompt (the soft gate — re-renderable via "include existing").
async function loadSceneVideos(slug, ep) {
  const data = await client.sceneReview(slug, ep.code);
  const scenes = data?.scenes || [];
  const minSec = Number(data?.animate_min_seconds) || 0;
  return scenes
    .filter(
      (s) =>
        s.approved === true &&
        (s.motion_prompt || '').trim() &&
        s.image_filename != null &&
        Number(s.end_sec) - Number(s.start_sec) >= minSec
    )
    .map((s) => ({
      source: 'plan',
      kind: 'scene',
      key: s.id,
      label: `Scene ${s.scene_index}`,
      prompt: s.motion_prompt || '', // motion prompt drives image-to-video
      imagePrompt: s.visual_prompt || '', // used only in "generate fresh image" mode
      durationSec: Math.max(0, Number(s.end_sec) - Number(s.start_sec)), // request clip ≈ scene window
      hasImage: !!s.clip_exists && !s.clip_stale, // "done" = a fresh clip exists
      stale: !!s.clip_stale,
    }));
}

// Thumbnails always come from the Image Prompts generator's `thumbnails` array
// (04 Thumbnail Prompts) and save to 06 Thumbnail Images as {CODE}_Thumb{NN}_v1.png.
async function loadThumbnails(slug, ep) {
  const data = await client.imagePrompts(slug, ep.code, ep.title);
  const thumbs = data?.thumbnails || [];
  const present = new Set();
  try {
    const st = await client.imageStatus(slug, ep.code);
    const missing = new Set((st?.thumbnails?.missing || []).map(Number));
    const total = st?.thumbnails?.total || thumbs.length;
    for (let n = 1; n <= total; n++) if (!missing.has(n)) present.add(n);
  } catch {
    /* status optional */
  }
  return thumbs.map((t) => ({
    source: 'prompts',
    kind: 'thumbnail',
    key: t.number,
    label: `Thumb ${t.number}${t.title ? ` — ${t.title}` : ''}`,
    prompt: t.prompt || '',
    hasImage: present.has(Number(t.number)),
    stale: false,
  }));
}

// An episode has EITHER a scene plan OR scene prompts (mutually exclusive).
// Try scene_plan first; fall back to the Scene Prompts generator. Normalize both.
async function loadScenesFromEither(slug, ep) {
  // 1) Scene Plan
  try {
    const data = await client.sceneReview(slug, ep.code);
    if (data?.scenes?.length) {
      return {
        source: 'plan',
        scenes: data.scenes.map((s) => ({
          source: 'plan',
          kind: 'scene',
          key: s.id,
          label: `Scene ${s.scene_index}`,
          prompt: s.visual_prompt || '',
          hasImage: !!s.image_filename,
          stale: !!s.stale,
        })),
      };
    }
  } catch (e) {
    if (e.status && e.status !== 404) throw e;
  }
  // 2) Scene Prompts ("03 Scene Prompts")
  const data = await client.imagePrompts(slug, ep.code, ep.title);
  const promptScenes = data?.scenes || [];
  let present = new Set();
  try {
    const st = await client.imageStatus(slug, ep.code);
    const missing = new Set((st?.scenes?.missing || st?.missing || []).map(Number));
    const total = st?.scenes?.total || promptScenes.length;
    for (let n = 1; n <= total; n++) if (!missing.has(n)) present.add(n);
  } catch {
    /* status optional */
  }
  return {
    source: 'prompts',
    scenes: promptScenes.map((s) => ({
      source: 'prompts',
      kind: 'scene',
      key: s.number,
      label: `Scene ${s.number}${s.title ? ` — ${s.title}` : ''}`,
      prompt: s.prompt || '',
      hasImage: present.has(Number(s.number)),
      stale: false,
    })),
  };
}

function renderScenes() {
  const includeExisting = $('includeExisting').checked;
  const video = loadedKind === 'video';
  const wrap = $('scenes');
  wrap.innerHTML = '';
  for (const s of currentScenes) {
    const has = s.hasImage; // image (image modes) or fresh clip (video)
    const div = document.createElement('div');
    div.className = 'scene';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.key = String(s.key);
    // Pre-select scenes that still need the asset. For video, a fresh clip is
    // HARD-skipped (re-render by editing the motion prompt → it becomes stale →
    // eligible) — so "include existing" doesn't re-enable fresh clips, only the
    // image modes honour it.
    cb.checked = video ? !has : includeExisting || !has;
    cb.disabled = video ? has : has && !includeExisting;
    cb.onchange = updateQueueButton;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = s.label;
    const prm = document.createElement('div');
    prm.className = 'prompt';
    prm.textContent = s.prompt || '(no prompt)';
    meta.append(idx, prm);
    div.append(cb, meta);
    if (has) {
      const b = document.createElement('span');
      b.className = 'badge ' + (s.stale ? 'stale' : 'has');
      b.textContent = s.stale ? 'stale' : loadedKind === 'video' ? 'has clip' : 'has image';
      div.appendChild(b);
    }
    wrap.appendChild(div);
  }
  updateQueueButton();
}

function selectedScenes() {
  const keys = new Set(
    [...document.querySelectorAll('.scene input[type=checkbox]')]
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.dataset.key)
  );
  return currentScenes.filter((s) => keys.has(String(s.key)) && (s.prompt || '').trim());
}

// Batch quick-select. "Missing" = still needs the asset (!hasImage) and is
// queueable (checkbox not disabled). Preset buttons check the FIRST n missing in
// display order and clear the rest — so after a batch generates + the list is
// reloaded, those drop out and the next click grabs the following n.
function missingCheckboxes() {
  const done = new Set(currentScenes.filter((s) => s.hasImage).map((s) => String(s.key)));
  return [...document.querySelectorAll('.scene input[type=checkbox]')].filter(
    (c) => !c.disabled && !done.has(c.dataset.key)
  );
}

function selectNextMissing(n) {
  document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
    if (!c.disabled) c.checked = false;
  });
  missingCheckboxes()
    .slice(0, n)
    .forEach((c) => (c.checked = true));
  $('selectAll').checked = false;
  updateQueueButton();
}

// Reset to "only what's left": every missing scene checked, done ones cleared.
function selectRemaining() {
  const done = new Set(currentScenes.filter((s) => s.hasImage).map((s) => String(s.key)));
  document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
    if (!c.disabled) c.checked = !done.has(c.dataset.key);
  });
  $('selectAll').checked = false;
  updateQueueButton();
}

function updateQueueButton() {
  const n = selectedScenes().length;
  const btn = $('queueSelected');
  btn.disabled = n === 0;
  btn.textContent = n ? `Queue selected (${n})` : 'Queue selected';
}

// Only Flow supports video; all other providers use their image-generator UI.
function onProviderChange() {
  const provider = $('provider').value;
  const imageOnly = provider !== 'flow';
  saveSettings({ provider });
  const videoOpt = $('mediaType').querySelector('option[value="scene-video"]');
  if (videoOpt) videoOpt.disabled = imageOnly;
  if (imageOnly && isVideoSel()) $('mediaType').value = 'scene-image';
  $('flowProjectCard').classList.toggle('hidden', provider !== 'flow');
  onMediaTypeChange();
  if (provider === 'grok') checkGrok();
  else if (provider !== 'flow') checkWebGenerator(provider);
  else setStatus('', 'info');
}

async function checkGrok() {
  setStatus('Checking Grok…', 'running');
  try {
    const ctx = await chrome.runtime.sendMessage({ type: 'grokContext' });
    if (!ctx?.ok) throw new Error(ctx?.error || 'no Grok tab');
    if (!ctx.signedIn) setStatus('Grok: not signed in — open grok.com and sign in.', 'err');
    else if (!ctx.hasTemplate)
      setStatus('Grok: sign-in OK. Generate ONE image at grok.com/imagine (free daily quota) so the extension can learn the API, then batch here.', 'err');
    else setStatus('Grok ready (template captured). Free tier has a daily limit — it pauses & resumes.', 'done');
  } catch (e) {
    setStatus(`Grok check failed: ${e.message}`, 'err');
  }
}

async function checkWebGenerator(provider) {
  const names = { perchance: 'Perchance', freegen: 'FreeGen', leonardo: 'Leonardo AI' };
  const name = names[provider] || provider;
  setStatus(`Checking ${name}…`, 'running');
  try {
    const ctx = await chrome.runtime.sendMessage({ type: 'webGeneratorContext', provider });
    if (!ctx?.ok) throw new Error(ctx?.error || `Could not reach ${name}.`);
    if (!ctx.ready) {
      setStatus(`${name}: open the image generator, complete any sign-in/browser check, and leave the tab open.`, 'err');
      return;
    }
    const quota =
      provider === 'leonardo'
        ? 'Free accounts currently produce four images per prompt and deduct the displayed token cost.'
        : 'Free web generation ready.';
    setStatus(`${name} ready. ${quota}`, 'done');
  } catch (e) {
    setStatus(`${name} check failed: ${e.message}`, 'err');
  }
}

// Reload the list when the selection kind changes (scene image / scene video /
// thumbnail all read different prompts). Save target stays user-controlled —
// video now writes clips back via upload-clip too.
async function onMediaTypeChange() {
  $('saveTarget').disabled = false;
  if (currentEpisode && currentScenes.length && selKind() !== loadedKind) {
    await loadScenes();
  }
}

// ── confirm + enqueue ───────────────────────────────────────────────────────
function confirmQueue() {
  const scenes = selectedScenes();
  if (!scenes.length) return;
  const provider = $('provider').value;
  const isGrok = provider === 'grok';
  const isFlow = provider === 'flow';
  const kind = currentKind();
  const isVideo = isFlow && isVideoSel();
  const noun = kind === 'thumbnail' ? 'thumbnail' : 'scene';
  const folder = kind === 'thumbnail' ? 'Thumbnail Images folder' : 'scene folder';
  const target = $('saveTarget').value;
  if (target === 'project' && !currentProject) return;
  if (isFlow && !settings.flowProjectId) {
    setStatus('Set a Flow project first (use “Use current tab”).', 'err');
    return;
  }
  const n = `${scenes.length} ${noun}${scenes.length > 1 ? 's' : ''}`;
  if (isGrok) {
    $('confirmTitle').textContent = `Queue these ${noun}s on Grok?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via Grok Imagine → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. Free tier has a DAILY LIMIT — ` +
      `the queue pauses when it's hit and resumes later. ${humanDelayLabel()} between each. Continue?`;
    $('confirmOk').textContent = 'Queue on Grok';
  } else if (isFlow) {
    $('confirmTitle').textContent = isVideo ? '⚠︎ Generate video — uses credits' : `Queue these ${noun}s?`;
    $('confirmBody').textContent = isVideo
      ? `${scenes.length} clip${scenes.length > 1 ? 's' : ''} from ${currentEpisode.code} — image-to-video ` +
        `(${settings.videoSource === 'generate' ? 'fresh image' : 'existing image'} + motion prompt) → ` +
        `${target === 'project' ? '“11 Video Assets”' : 'Downloads'}. Each clip costs credits ` +
        `(Veo ~20, Omni Flash ~7). One at a time, ~1–3 min each. Continue?`
      : `${n} from ${currentEpisode.code} → ` +
        `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. ` +
        `Images use Nano Banana 2 (free). One at a time.`;
    $('confirmOk').textContent = isVideo ? 'Spend credits & generate' : 'Queue';
  } else {
    const names = { perchance: 'Perchance', freegen: 'FreeGen', leonardo: 'Leonardo AI' };
    const name = names[provider] || provider;
    $('confirmTitle').textContent = `Queue these ${noun}s on ${name}?`;
    $('confirmBody').textContent =
      `${n} from ${currentEpisode.code} via the ${name} website → ` +
      `${target === 'project' ? `Story Studio ${folder}` : 'Downloads'}. ` +
      `Keep the generator tab open; jobs run one at a time with a ${humanDelayLabel()} gap.`;
    $('confirmOk').textContent = `Queue on ${name}`;
  }
  const dlg = $('confirm');
  dlg.classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    dlg.classList.add('hidden');
    await doEnqueue(scenes, target, isVideo ? 'video' : 'image', provider, kind);
  };
}

async function doEnqueue(scenes, target, assetType, provider, kind) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'enqueueScenes',
      payload: {
        slug: currentProject.slug,
        episodeCode: currentEpisode.code,
        episodeTitle: currentEpisode.title,
        projectName: currentProject.name,
        scenes,
        source: currentSource,
        kind,
        target,
        assetType,
        provider,
      },
    });
    if (!res?.ok) throw new Error(res?.error || 'enqueue failed');
    setStatus(`Queued ${res.added}${res.skipped ? `, skipped ${res.skipped} already queued` : ''}.`, 'done');
    pollQueue();
  } catch (e) {
    setStatus(String(e.message || e), 'err');
  }
}

// ── queue view ──────────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function itemQueuedAt(item) {
  if (Number.isFinite(item.queuedAt)) return item.queuedAt;
  const legacy = Number(String(item.id || '').split('_')[0]);
  return Number.isFinite(legacy) ? legacy : null;
}

function renderQueueTiming(queue) {
  const el = $('queueTiming');
  if (!queue.length) {
    el.textContent = '';
    return;
  }
  const starts = queue.map(itemQueuedAt).filter(Number.isFinite);
  const sessionStart = starts.length ? Math.min(...starts) : Date.now();
  const active = queue.some((i) => i.status === 'pending' || i.status === 'running');
  const finishes = queue.map((i) => i.finishedAt).filter(Number.isFinite);
  const sessionEnd = active ? Date.now() : finishes.length ? Math.max(...finishes) : Date.now();
  const done = queue.filter((i) => i.status === 'done');
  const measured = done.map((i) => i.durationMs).filter((n) => Number.isFinite(n) && n >= 0);
  const avg = measured.length ? measured.reduce((sum, n) => sum + n, 0) / measured.length : null;
  const remaining = queue.filter((i) => i.status === 'pending' || i.status === 'running').length;
  const episodes = [...new Set(queue.map((i) => i.episodeCode).filter(Boolean))];
  const scope = episodes.length === 1 ? episodes[0] : `${episodes.length} episodes`;
  const parts = [scope, `${done.length}/${queue.length} done`, `${active ? 'elapsed' : 'total'} ${formatDuration(sessionEnd - sessionStart)}`];
  if (avg != null) parts.push(`avg ${formatDuration(avg)}/asset`);
  if (active && avg != null && remaining) parts.push(`ETA ~${formatDuration(avg * remaining)}`);
  el.textContent = parts.join(' · ');
}

let lastQueueSig = '';
async function pollQueue() {
  const [{ queue = [] } = {}, st] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'getQueue' }).then((r) => r || {}),
    chrome.storage.local.get('lastStatus'),
  ]);
  renderQueueTiming(queue);
  const s = st.lastStatus;
  if (s && Date.now() - s.ts < 600000) setStatus(s.text, s.kind);
  // Only rebuild the list when its contents actually change. A blind 1.5 s
  // re-render would wipe an open "Technical details" panel (and any text the
  // user is mid-selection on) — the raw error would flash for one tick and vanish.
  const sig = JSON.stringify(
    queue.map((it) => [it.id, it.status, it.durationMs, it.savedAs, it.error, it.failure?.code])
  );
  if (sig === lastQueueSig) return;
  lastQueueSig = sig;
  const wrap = $('queue');
  wrap.innerHTML = '';
  for (const it of queue) {
    const row = document.createElement('div');
    row.className = 'qitem' + (it.status === 'failed' ? ' has-failure' : '');
    const info = document.createElement('div');
    info.className = 'qinfo';
    const label = document.createElement('div');
    label.className = 'qlabel';
    const timing = Number.isFinite(it.durationMs) ? ` · ${formatDuration(it.durationMs)}` : '';
    label.textContent = it.label + (it.savedAs ? ` → ${it.savedAs}` : '') + timing;
    label.title = label.textContent;
    info.appendChild(label);
    if (it.status === 'failed' && it.failure) {
      const diagnosis = document.createElement('div');
      diagnosis.className = 'failure-diagnosis';
      const title = document.createElement('strong');
      title.textContent = it.failure.title;
      const hint = document.createElement('span');
      hint.textContent = ` — ${it.failure.hint}`;
      diagnosis.append(title, hint);
      const details = document.createElement('details');
      details.className = 'failure-details';
      const summary = document.createElement('summary');
      summary.textContent = 'Technical details';
      const raw = document.createElement('div');
      raw.textContent = it.failure.raw || it.error || 'No raw error was provided.';
      details.append(summary, raw);
      info.append(diagnosis, details);
    } else if (it.error) {
      const raw = document.createElement('div');
      raw.className = 'failure-diagnosis';
      raw.textContent = it.error;
      info.appendChild(raw);
    }
    const stat = document.createElement('span');
    stat.className = 'qstatus ' + it.status;
    stat.textContent = it.status === 'failed' && it.failure ? it.failure.code : it.status;
    row.append(info, stat);
    if (it.status === 'pending') {
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'Remove';
      x.onclick = async () => {
        await chrome.runtime.sendMessage({ type: 'removeItem', id: it.id });
        pollQueue();
      };
      row.appendChild(x);
    } else if (it.status === 'failed') {
      const retry = document.createElement('button');
      retry.className = 'retry';
      retry.textContent = '↻';
      retry.title = 'Retry this failed job';
      retry.onclick = async () => {
        const ambiguousPaid = it.assetType === 'video' && it.phase === 'submitting' && !it.videoMediaId;
        if (ambiguousPaid) {
          const dlg = $('confirm');
          $('confirmTitle').textContent = 'Retry paid video submission?';
          $('confirmBody').textContent =
            'Flow may have accepted the previous request before the page refreshed. Retrying could spend credits twice.';
          $('confirmOk').textContent = 'Retry and accept risk';
          dlg.classList.remove('hidden');
          $('confirmOk').onclick = async () => {
            dlg.classList.add('hidden');
            await chrome.runtime.sendMessage({ type: 'retryFailed', id: it.id });
            pollQueue();
          };
          return;
        }
        await chrome.runtime.sendMessage({ type: 'retryFailed', id: it.id });
        pollQueue();
      };
      row.appendChild(retry);
    }
    wrap.appendChild(row);
  }
}

// Brief confirmation when a panel setting changes (pollQueue restores the live
// queue status on its next tick, ~1.5 s later).
function flashSaved() {
  setStatus('Saved ✓', 'done');
}

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind === 'running' ? 'running' : kind === 'done' ? 'done' : kind === 'err' ? 'err' : '');
}

init();
