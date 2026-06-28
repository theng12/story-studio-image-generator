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
let currentScenes = []; // [{ id, scene_index, visual_prompt, image_filename, stale }]
let currentEpisode = null; // { code, title }
let currentProject = null; // { slug, name }

async function init() {
  settings = await getSettings();
  client = new StudioClient(settings.studioBaseUrl);
  $('saveTarget').value = settings.saveTarget;
  $('provider').value = settings.provider || 'flow';
  $('includeExisting').checked = !!settings.includeExisting;
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
  $('selectAll').onchange = (e) => {
    document.querySelectorAll('.scene input[type=checkbox]').forEach((c) => {
      if (!c.disabled) c.checked = e.target.checked;
    });
    updateQueueButton();
  };
  $('queueSelected').onclick = confirmQueue;
  $('clearQueue').onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clearQueue' });
    pollQueue();
  };
  $('saveTarget').onchange = () => saveSettings({ saveTarget: $('saveTarget').value });
  $('mediaType').onchange = onMediaTypeChange;
  $('provider').onchange = onProviderChange;
  $('includeExisting').onchange = () => saveSettings({ includeExisting: $('includeExisting').checked });
  $('useCurrentProject').onclick = useCurrentFlowProject;
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
    setStatus(`Can't reach Story Studio at ${settings.studioBaseUrl} — is it running? (${e.message})`, 'err');
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
    const eps = (Array.isArray(rows) ? rows : rows.episodes || []).filter((e) => e.status?.scene_plan);
    const esel = $('episode');
    esel.innerHTML = eps.length ? '' : '<option value="">— no episodes with a scene plan —</option>';
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
  $('loadScenes').disabled = true;
  setStatus('Loading scenes…', 'running');
  try {
    const data = await client.sceneReview(slug, code);
    currentScenes = data.scenes || [];
    renderScenes();
    const s = data.stats || {};
    $('scenesSummary').textContent = `Scenes — ${s.with_image || 0}/${s.total_scenes || currentScenes.length} have images`;
    setStatus('', 'info');
  } catch (e) {
    setStatus(`Couldn't load scenes: ${e.message}`, 'err');
  } finally {
    $('loadScenes').disabled = false;
  }
}

function renderScenes() {
  const includeExisting = $('includeExisting').checked;
  const wrap = $('scenes');
  wrap.innerHTML = '';
  for (const s of currentScenes) {
    const has = !!s.image_filename;
    const div = document.createElement('div');
    div.className = 'scene';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.sceneId = s.id;
    // Pre-select scenes that need an image; existing ones only if opted in.
    cb.checked = includeExisting || !has;
    cb.disabled = has && !includeExisting;
    cb.onchange = updateQueueButton;
    const meta = document.createElement('div');
    meta.className = 'meta';
    const idx = document.createElement('div');
    idx.className = 'idx';
    idx.textContent = `Scene ${s.scene_index}`;
    const prm = document.createElement('div');
    prm.className = 'prompt';
    prm.textContent = s.visual_prompt || '(no prompt)';
    meta.append(idx, prm);
    div.append(cb, meta);
    if (has) {
      const b = document.createElement('span');
      b.className = 'badge ' + (s.stale ? 'stale' : 'has');
      b.textContent = s.stale ? 'stale' : 'has image';
      div.appendChild(b);
    }
    wrap.appendChild(div);
  }
  updateQueueButton();
}

function selectedScenes() {
  const ids = new Set(
    [...document.querySelectorAll('.scene input[type=checkbox]')]
      .filter((c) => c.checked && !c.disabled)
      .map((c) => c.dataset.sceneId)
  );
  return currentScenes.filter((s) => ids.has(s.id) && (s.visual_prompt || '').trim());
}

function updateQueueButton() {
  $('queueSelected').disabled = selectedScenes().length === 0;
}

// Provider switch: Grok is image-only and has a daily limit; reflect that.
function onProviderChange() {
  const grok = $('provider').value === 'grok';
  saveSettings({ provider: $('provider').value });
  const videoOpt = $('mediaType').querySelector('option[value="video"]');
  if (videoOpt) videoOpt.disabled = grok;
  if (grok && $('mediaType').value === 'video') $('mediaType').value = 'image';
  onMediaTypeChange();
  if (grok) checkGrok();
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

// Video can't write back to the scene folder yet — force Downloads + warn.
function onMediaTypeChange() {
  const isVideo = $('mediaType').value === 'video';
  const st = $('saveTarget');
  if (isVideo) {
    st.value = 'download';
    st.disabled = true;
  } else {
    st.disabled = false;
    st.value = settings.saveTarget;
  }
}

// ── confirm + enqueue ───────────────────────────────────────────────────────
function confirmQueue() {
  const scenes = selectedScenes();
  if (!scenes.length) return;
  const provider = $('provider').value;
  const isGrok = provider === 'grok';
  const isVideo = !isGrok && $('mediaType').value === 'video';
  const target = isVideo ? 'download' : $('saveTarget').value;
  if (target === 'project' && !currentProject) return;
  if (!isGrok && !settings.flowProjectId) {
    setStatus('Set a Flow project first (use “Use current tab”).', 'err');
    return;
  }
  if (isGrok) {
    $('confirmTitle').textContent = 'Queue these scenes on Grok?';
    $('confirmBody').textContent =
      `${scenes.length} scene${scenes.length > 1 ? 's' : ''} from ${currentEpisode.code} via Grok Imagine → ` +
      `${target === 'project' ? 'Story Studio scene folder' : 'Downloads'}. Free tier has a DAILY LIMIT — ` +
      `the queue pauses when it's hit and resumes later. 2–6 s between each. Continue?`;
    $('confirmOk').textContent = 'Queue on Grok';
  } else {
    $('confirmTitle').textContent = isVideo ? '⚠︎ Generate video — uses credits' : 'Queue these scenes?';
    $('confirmBody').textContent = isVideo
      ? `${scenes.length} Veo clip${scenes.length > 1 ? 's' : ''} from ${currentEpisode.code} → Downloads. ` +
        `Each clip costs Google AI credits (~20 for Veo 3.1 Fast). One at a time, ~1–3 min each. Continue?`
      : `${scenes.length} scene${scenes.length > 1 ? 's' : ''} from ${currentEpisode.code} → ` +
        `${target === 'project' ? 'Story Studio scene folder' : 'Downloads'}. ` +
        `Images use Nano Banana 2 (free). One at a time.`;
    $('confirmOk').textContent = isVideo ? 'Spend credits & generate' : 'Queue';
  }
  const dlg = $('confirm');
  dlg.classList.remove('hidden');
  $('confirmOk').onclick = async () => {
    dlg.classList.add('hidden');
    await doEnqueue(scenes, target, isVideo ? 'video' : 'image', provider);
  };
}

async function doEnqueue(scenes, target, assetType, provider) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'enqueueScenes',
      payload: {
        slug: currentProject.slug,
        episodeCode: currentEpisode.code,
        episodeTitle: currentEpisode.title,
        projectName: currentProject.name,
        scenes,
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
async function pollQueue() {
  const [{ queue = [] } = {}, st] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'getQueue' }).then((r) => r || {}),
    chrome.storage.local.get('lastStatus'),
  ]);
  const wrap = $('queue');
  wrap.innerHTML = '';
  for (const it of queue) {
    const row = document.createElement('div');
    row.className = 'qitem';
    const label = document.createElement('div');
    label.className = 'qlabel';
    label.textContent = it.label + (it.savedAs ? ` → ${it.savedAs}` : '') + (it.error ? ` — ${it.error}` : '');
    label.title = label.textContent;
    const stat = document.createElement('span');
    stat.className = 'qstatus ' + it.status;
    stat.textContent = it.status;
    row.append(label, stat);
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
    }
    wrap.appendChild(row);
  }
  const s = st.lastStatus;
  if (s && Date.now() - s.ts < 600000) setStatus(s.text, s.kind);
}

function setStatus(text, kind = 'info') {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + (kind === 'running' ? 'running' : kind === 'done' ? 'done' : kind === 'err' ? 'err' : '');
}

init();
