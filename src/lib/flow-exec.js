// One-shot Google Flow MAIN-world command.
//
// This function is passed directly to chrome.scripting.executeScript. Keep every
// dependency inside the function: Chrome serializes the function body and does
// not preserve module closures. Unlike the old window.postMessage bridge, this
// exposes no long-lived page-callable command listener and does not broadcast
// prompts, media bytes, or command results to page scripts.
//
// Contract (captured live 2026-09-07 on flow.google.com): the app is a Google
// "boq" Angular front end. Every call is a same-origin, cookie-authenticated
// POST to /_/AiSandboxAngularFrontend/data/batchexecute carrying one RPC id and
// a positional-array payload, plus the page's anti-forgery token. Image
// generation (ogiZ0b) answers synchronously with a flow-content.google URL;
// reference upload (maseQ) answers with the media id generation then cites.
export async function flowCommand(command) {
  try {
    const SITEKEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
    const payload = command?.payload || {};
    // Flow's RPC ids are internals that move between builds. They are resolved per page load
    // from exchanges the recorder observed, with settings.rpcIds as a configurable fallback;
    // a miss is named with what was tried, never collapsed into "signed out".
    const RPC_NAMES = ['account', 'credits', 'generate', 'upload'];
    const classifyExchange = ({ rpcid, request = '', response = '' } = {}) => {
      if (typeof rpcid !== 'string' || !rpcid) return null;
      const req = String(request);
      const res = String(response);
      if (/person\.(photo|name|email|metadata)/.test(req) || /"me"/.test(req)) return 'account';
      if (/flow-content\.google/.test(res)) return 'generate';
      if (/[A-Za-z0-9+/]{400,}={0,2}/.test(req)) return 'upload';
      if (!req.trim() || req.trim() === '[]') {
        if (/^\s*\[/.test(res) || /"\d+"/.test(res)) return 'credits';
      }
      return null;
    };
    const resolveRpc = () => {
      const fallback = payload.rpcFallback || {};
      const observations = Array.isArray(window.__relayRpcLog) ? window.__relayRpcLog : [];
      const discovered = {};
      for (const row of observations) {
        const name = classifyExchange(row);
        if (name && !discovered[name]) discovered[name] = row.rpcid;
      }
      const ids = {};
      const problems = [];
      for (const name of RPC_NAMES) {
        if (discovered[name]) ids[name] = discovered[name];
        else if (typeof fallback[name] === 'string' && fallback[name]) ids[name] = fallback[name];
        else problems.push(`${name}: no id was observed on the page and no fallback is configured`);
      }
      return { ids, problems };
    };
    const rpcResolution = resolveRpc();
    const RPC = rpcResolution.ids;
    const requireRpc = (name) => {
      const id = RPC[name];
      if (!id) {
        throw new Error(`Flow RPC id "${name}" is unresolved: ${rpcResolution.problems.join('; ') || 'not observed and no fallback configured'}.`);
      }
      return id;
    };
    // Slot 4 is the aspect for ogiZ0b, proven by paired 9:16 and 16:9 runs at the
    // same model and count (2026-11-12) and matching `aspectRatio` in the app's own
    // stored settings. It is per-RPC: video's YhhmEf sends 2 for 16:9, so never copy
    // these values across. 4:3, 1:1 and 3:4 have no body yet and are refused.
    const IMAGE_ASPECT = { '16:9': 3, '9:16': 2 };
    // Labels exactly as the picker renders them; the keys are ours.
    const KNOWN_MODELS = [
      ['BELUGA', 'Nano Banana 2.1'],
      ['HARBOR_SEAL', 'Nano Banana 2 Lite'],
    ];

    const uuid = () =>
      crypto.randomUUID
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
          });
    const normalizeProjectId = (value) => {
      const raw = String(value || '').trim();
      const match = raw.match(
        /(?:\/project\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
      );
      return match ? match[1].toLowerCase() : raw;
    };
    const currentProjectId = () => {
      const match = location.pathname.match(/\/project\/([0-9a-f-]{36})/i);
      return match ? match[1] : '';
    };
    const projectIdFor = (value) => normalizeProjectId(value || currentProjectId());
    const randomSeed = () => Math.floor(Math.random() * 2_000_000_000);
    const bufToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    // The page's own anti-forgery + session values. They exist only on a
    // signed-in app page, which is exactly the "are we signed in" signal.
    const wiz = () => {
      const data = window.WIZ_global_data || {};
      if (!data.SNlM0e) throw new Error('Not signed in to Flow, or this is not the Flow app page. Open a Flow project and sign in.');
      return { at: data.SNlM0e, sid: data.FdrFJe || '', bl: data.cfb2h || '' };
    };
    const mintToken = async (action) => {
      const enterprise = window.grecaptcha?.enterprise;
      if (!enterprise?.execute) throw new Error('grecaptcha not loaded yet — reload the Flow tab.');
      return new Promise((resolve, reject) => {
        try {
          enterprise.ready(() => enterprise.execute(SITEKEY, { action }).then(resolve, reject));
        } catch (error) {
          reject(error);
        }
      });
    };
    const clientContext = (projectId, token) =>
      [null, 22, null, null, null, projectId, null, null, null, null, [token, 1]];
    // Parse a batchexecute body: ")]}'" then length-prefixed JSON chunks; the
    // answer is the ["wrb.fr", rpcId, <json string>] row.
    const parseRpc = (text, rpcId) => {
      const rows = [];
      for (const line of String(text).replace(/^\)\]\}'/, '').split('\n')) {
        if (!line.startsWith('[')) continue;
        try { rows.push(...JSON.parse(line)); } catch { /* length prefix or partial */ }
      }
      const row = rows.find((entry) => Array.isArray(entry) && entry[0] === 'wrb.fr' && entry[1] === rpcId);
      if (!row) throw new Error(`Flow returned no ${rpcId} result.`);
      if (typeof row[2] !== 'string') {
        const code = Array.isArray(row[5]) ? row[5][0] : null;
        throw Object.assign(new Error(`Flow rejected ${rpcId}${code != null ? ` (error ${code})` : ''}.`), { flowErrorCode: code });
      }
      return JSON.parse(row[2]);
    };
    const rpc = async (rpcId, args, projectId) => {
      const { at, sid, bl } = wiz();
      const query = new URLSearchParams({
        rpcids: rpcId,
        'source-path': projectId ? `/project/${projectId}` : '/',
        bl,
        'f.sid': sid,
        hl: 'en',
        _reqid: String(Math.floor(Math.random() * 900000) + 100000),
        rt: 'c',
      });
      const body = new URLSearchParams({
        'f.req': JSON.stringify([[[rpcId, JSON.stringify(args), null, 'generic']]]),
        at,
      });
      const response = await fetch(`/_/AiSandboxAngularFrontend/data/batchexecute?${query}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Same-Domain': '1', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
      });
      const text = await response.text();
      if (!response.ok) throw Object.assign(new Error(`Flow ${rpcId} failed (${response.status}).`), { status: response.status });
      return parseRpc(text, rpcId);
    };
    const findUrl = (value) => {
      if (typeof value === 'string') return value.startsWith('https://flow-content.google/image/') ? value : null;
      if (!Array.isArray(value)) return null;
      for (const entry of value) {
        const found = findUrl(entry);
        if (found) return found;
      }
      return null;
    };
    const downloadImage = async (value) => {
      const url = new URL(String(value || ''));
      if (
        url.protocol !== 'https:' ||
        !(url.hostname === 'flow-content.google' || url.hostname.endsWith('.flow-content.google'))
      ) {
        throw new Error('Flow returned an untrusted image URL.');
      }
      const response = await fetch(url.href, { credentials: 'omit', redirect: 'error' });
      if (!response.ok) throw new Error(`Asset download failed (${response.status}).`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error('Flow returned a non-image asset.');
      const buffer = await response.arrayBuffer();
      if (!buffer.byteLength) throw new Error('Downloaded asset was empty.');
      if (buffer.byteLength > 50 * 1024 * 1024) throw new Error('Downloaded image exceeded 50 MB.');
      return { base64: bufToBase64(buffer), mime: contentType || 'image/png' };
    };
    // Model keys never appear in a capturable RPC; the app renders their labels
    // from its own bundle. A bundled record counts as live only while the signed-in
    // page shows its exact label as a line of its own. The key still comes from us.
    // shortcut: a closed model picker shows no labels, so it stays fallback;
    // move to a backend listing once Flow exposes one.
    const listImageModels = async () => {
      let signedIn = false;
      try {
        wiz();
        signedIn = true;
      } catch { /* a signed-out tab still needs a state result */ }
      const lines = new Set(typeof document === 'undefined' ? []
        : String(document.body?.innerText || '').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()));
      const entries = signedIn ? KNOWN_MODELS.filter(([, label]) => lines.has(label)).map(([id, label]) => ({ id, label })) : [];
      return { entries, source: entries.length ? 'live' : 'fallback', signedIn, projectId: currentProjectId() };
    };
    const preparedRequests = window.__STORY_STUDIO_FLOW_IMAGE_PREPARATIONS__ ||= new Map();
    const prepareGenerateImage = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      if (!String(payload.prompt || '').trim()) throw new Error('Empty image prompt.');
      const modelId = String(payload.modelId || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/.test(modelId)) {
        throw new Error('Flow model ID is malformed. Refresh the signed-in Flow page and choose an advertised model before retrying.');
      }
      const aspect = IMAGE_ASPECT[payload.aspectRatio || '16:9'];
      if (!aspect) throw new Error(`Flow aspect ratio ${payload.aspectRatio} has no observed submit value — 16:9 and 9:16 only.`);
      const count = payload.count === undefined ? 1 : payload.count;
      if (![1, 2, 4].includes(count)) throw new Error(`Flow image count ${count} is not 1, 2 or 4.`);
      const seed = Number.isFinite(payload.seed) ? payload.seed : randomSeed();
      const maxAttempts = Math.min(10, Math.max(1, Math.round(Number(payload.recaptchaMaxAttempts) || 4)));
      wiz(); // fail before minting if the page cannot sign requests
      const token = await mintToken('IMAGE_GENERATION');
      const preparationId = uuid();
      const now = Date.now();
      for (const [id, prepared] of preparedRequests) {
        if (now - prepared.createdAt > 120000) preparedRequests.delete(id);
      }
      const imageInputs = (Array.isArray(payload.imageInputs) ? payload.imageInputs : [])
        .map((input) => String(input?.name || input || '').trim())
        .filter(Boolean)
        .map((mediaId) => [mediaId, null, null, null, 1]);
      preparedRequests.set(preparationId, {
        projectId,
        prompt: String(payload.prompt),
        modelId,
        aspect,
        count,
        seed,
        maxAttempts,
        imageInputs,
        token,
        createdAt: now,
      });
      return { preparationId };
    };

    const submitPreparedImage = async (preparationId) => {
      const prepared = preparedRequests.get(String(preparationId || ''));
      if (!prepared || Date.now() - prepared.createdAt > 120000) {
        preparedRequests.delete(String(preparationId || ''));
        throw new Error('Flow generation preparation expired. Re-queue this item after checking the Flow tab.');
      }
      // One-shot consumption prevents a transport retry from replaying a request
      // whose provider outcome is unknown.
      preparedRequests.delete(String(preparationId));
      let result;
      for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
        const token = attempt === 1 ? prepared.token : await mintToken('IMAGE_GENERATION');
        const context = clientContext(prepared.projectId, token);
        const request = [
          null,
          [[
            null,
            null,
            prepared.imageInputs.length ? prepared.imageInputs : null,
            prepared.seed,
            prepared.aspect,
            prepared.modelId,
            prepared.count, // unproven: [6] was null at count 1, and a count of 2 did not move [4] either
            context,
            [[[prepared.prompt]]],
            null,
            null,
            null,
            uuid().toUpperCase(),
            uuid().toUpperCase(),
          ]],
          1,
          context,
          [uuid().toUpperCase()],
        ];
        try {
          result = await rpc(requireRpc('generate'), request, prepared.projectId);
          break;
        } catch (error) {
          const detail = String(error?.message || error);
          const recaptchaFailure = error?.status === 403 || /recaptcha|captcha|evaluation failed/i.test(detail);
          if (recaptchaFailure && attempt < prepared.maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
            continue;
          }
          if (recaptchaFailure) {
            throw Object.assign(
              new Error(`Flow reCAPTCHA failed after ${attempt} fresh-token attempts: ${detail}`),
              { providerRejectedBeforeGeneration: true }
            );
          }
          throw new Error(`Flow image generation failed: ${detail}`);
        }
      }
      const media = result?.[0]?.[0];
      const imageUrl = findUrl(media);
      if (!imageUrl) throw new Error('Flow returned no image URL.');
      const image = await downloadImage(imageUrl);
      const dims = Array.isArray(media?.[8]) ? media[8] : [];
      return {
        ...image,
        mediaId: typeof media?.[0] === 'string' ? media[0] : undefined,
        seed: prepared.seed,
        width: dims[0],
        height: dims[1],
      };
    };
    const submitGenerateImage = () => submitPreparedImage(payload.preparationId);
    const generateImage = async () => {
      const prepared = await prepareGenerateImage();
      return submitPreparedImage(prepared.preparationId);
    };
    const uploadImage = async () => {
      const projectId = projectIdFor(payload.projectId);
      if (!projectId) throw new Error('No Flow project selected.');
      if (!payload.base64) throw new Error('uploadImage needs base64 image bytes.');
      const token = await mintToken('UPLOAD_IMAGE');
      const result = await rpc(requireRpc('upload'), [
        clientContext(projectId, token),
        String(payload.base64),
        payload.mime || 'image/png',
        1,
        null,
        null,
        null,
        null,
        payload.fileName || 'scene.png',
        null,
        uuid().toUpperCase(),
        uuid().toUpperCase(),
      ], projectId);
      const mediaId = result?.[0]?.[0];
      if (typeof mediaId !== 'string' || !mediaId) throw new Error('Flow upload returned no media id.');
      return { mediaId };
    };
    // The account/credit RPC ids are Flow internals captured 2025-11-05 and can move
    // between Flow builds. A page that is visibly signed in and on a real project still counts
    // as signed in even when the probe fails; images are free, so the balance stays unknown.
    const visibleSignedIn = () => {
      try {
        return Boolean(document.querySelector(
          '[aria-label*="Google Account" i], a[href*="accounts.google.com"], [data-email], img[alt*="profile" i]'));
      } catch {
        return false;
      }
    };
    const inspectAccount = async () => {
      let projectId = null;
      try { projectId = projectIdFor(payload.projectId); } catch { /* no real project: no fallback */ }
      let probeError = null;
      try {
        wiz();
        const observedAt = new Date().toISOString();
        const me = await rpc(requireRpc('account'),
          [['me'], [[['person.photo', 'person.name', 'person.email', 'person.metadata']], null, [1, 7, 10]]], projectId);
        const identity = me?.[0]?.[0] === 'me' ? me[0][2]?.[0] : null;
        if (typeof identity === 'string' && identity) {
          let balance = null;
          try {
            const credits = RPC.credits ? await rpc(RPC.credits, [], projectId) : null;
            const value = Array.isArray(credits) ? credits[0] : null;
            if (Number.isFinite(value) && value >= 0) {
              balance = { value, unit: 'credits', source: 'flow.nzlxg', observedAt };
            }
          } catch { /* credits stay unknown, never zero */ }
          return { account: {
            schema: 1, provider: 'flow', accountId: identity, source: 'flow.account', observedAt,
            connection: 'connected', signIn: 'signed_in',
            // Images are free, so an empty balance still claims; an unreadable
            // balance stays unknown, never zero. If Flow ever charges for images,
            // readiness must weigh the balance again before this can claim.
            readiness: 'ready', balance,
          }, probe: { fallback: false, error: null } };
        }
        probeError = 'Flow returned no account identity for this tab.';
      } catch (error) {
        probeError = String(error?.message || error);
      }
      // A visibly signed-in page on a real project is a working worker: claim with an
      // honest unknown balance instead of blaming the person for being signed out.
      if (projectId && visibleSignedIn()) {
        return { account: {
          schema: 1, provider: 'flow', accountId: 'flow-visible-signed-in', source: 'flow.visible-signed-in',
          observedAt: new Date().toISOString(), connection: 'connected', signIn: 'signed_in',
          readiness: 'ready', balance: null,
        }, probe: { fallback: true, error: probeError } };
      }
      return { account: null, probe: { fallback: false, error: probeError } };
    };
    const getContext = async () => {
      let signedIn = false;
      try {
        wiz();
        signedIn = true;
      } catch {
        // The panel needs a state result, not an exception, for signed-out tabs.
      }
      return { projectId: currentProjectId(), signedIn, url: location.href };
    };
    // ponytail: the new app's create-project RPC has not been captured yet.
    // The worker treats this failure as "keep the current project".
    const createProject = async () => {
      throw new Error('Creating Flow projects is not supported on the new Flow yet — create one in Flow and pick it in the panel.');
    };

    const handlers = {
      listImageModels,
      prepareGenerateImage,
      submitGenerateImage,
      generateImage,
      uploadImage,
      inspectAccount,
      getContext,
      createProject,
    };
    const handler = handlers[command?.op];
    if (!handler) throw new Error(`Unknown Flow operation: ${command?.op || ''}`);
    return { ok: true, result: await handler() };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error),
      providerRejectedBeforeGeneration: error?.providerRejectedBeforeGeneration === true,
    };
  }
}
