// One-shot Google Flow MAIN-world command.
//
// This function is passed directly to chrome.scripting.executeScript. Keep every
// dependency inside the function: Chrome serializes the function body and does
// not preserve module closures. Unlike the old window.postMessage bridge, this
// exposes no long-lived page-callable command listener and does not broadcast
// prompts, media bytes, or command results to page scripts.
export async function flowCommand(command) {
  try {
    const API = 'https://aisandbox-pa.googleapis.com/v1';
    const SITEKEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
    const IMAGE_ASPECT = {
      '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
      '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
      '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
      '4:3': 'IMAGE_ASPECT_RATIO_FULL',
      '3:4': 'IMAGE_ASPECT_RATIO_PORTRAIT_FULL',
    };
    const payload = command?.payload || {};

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
    const randomSeed = () => Math.floor(Math.random() * 1_000_000);
    const sessionId = () => `;${Date.now()}`;
    const bufToBase64 = (buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      return btoa(binary);
    };
    const accessToken = async () => {
      const response = await fetch('/fx/api/auth/session', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`Not signed in to Flow (session ${response.status}). Open labs.google/fx and sign in.`);
      }
      const json = await response.json();
      if (!json?.access_token) throw new Error('Flow session has no access_token — sign in again.');
      return json.access_token;
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
    const recaptchaContext = (token) => ({
      token,
      applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
    });
    const errorDetail = async (response) => {
      try {
        const json = await response.json();
        return json?.error?.message || String(response.status);
      } catch {
        return String(response.status);
      }
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
    const listImageModels = async () => {
      const entries = [];
      const add = (id, label) => entries.push({ id: String(id || ''), label: String(label || '') });
      const nextData = window.__NEXT_DATA__ || (() => {
        try { return JSON.parse(document.querySelector('script#__NEXT_DATA__')?.textContent || 'null'); }
        catch { return null; }
      })();
      const configs = nextData?.props?.pageProps?.imageModelConfigs;
      for (const config of Array.isArray(configs) ? configs : []) add(config.imageModelKey, config.displayName);
      for (const element of document.querySelectorAll('[role="option"][data-image-model-key]')) {
        add(element.getAttribute('data-image-model-key'), element.textContent);
      }
      return { entries };
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
      const aspect = IMAGE_ASPECT[payload.aspectRatio] || 'IMAGE_ASPECT_RATIO_LANDSCAPE';
      const seed = Number.isFinite(payload.seed) ? payload.seed : randomSeed();
      const maxAttempts = Math.min(10, Math.max(1, Math.round(Number(payload.recaptchaMaxAttempts) || 4)));
      const token = await mintToken('IMAGE_GENERATION');
      const authorization = await accessToken();
      const preparationId = uuid();
      const now = Date.now();
      for (const [id, prepared] of preparedRequests) {
        if (now - prepared.createdAt > 120000) preparedRequests.delete(id);
      }
      preparedRequests.set(preparationId, {
        projectId,
        prompt: String(payload.prompt),
        modelId,
        aspect,
        seed,
        maxAttempts,
        imageInputs: Array.isArray(payload.imageInputs) ? payload.imageInputs : [],
        token,
        authorization,
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
      let json;
      for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
        const token = attempt === 1 ? prepared.token : await mintToken('IMAGE_GENERATION');
        const clientContext = {
          recaptchaContext: recaptchaContext(token),
          projectId: prepared.projectId,
          tool: 'PINHOLE',
          sessionId: sessionId(),
        };
        const response = await fetch(
          `${API}/projects/${encodeURIComponent(prepared.projectId)}/flowMedia:batchGenerateImages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${attempt === 1 ? prepared.authorization : await accessToken()}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              clientContext,
              mediaGenerationContext: { batchId: uuid() },
              useNewMedia: true,
              requests: [
                {
                  clientContext,
                  imageModelName: prepared.modelId,
                  imageAspectRatio: prepared.aspect,
                  structuredPrompt: { parts: [{ text: prepared.prompt }] },
                  seed: prepared.seed,
                  imageInputs: prepared.imageInputs,
                },
              ],
            }),
          }
        );
        if (response.ok) {
          json = await response.json();
          break;
        }
        const detail = await errorDetail(response);
        const recaptchaFailure =
          response.status === 403 || /recaptcha|captcha|evaluation failed/i.test(detail);
        if (recaptchaFailure && attempt < prepared.maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
          continue;
        }
        if (recaptchaFailure) {
          throw Object.assign(
            new Error(`Flow reCAPTCHA failed after ${attempt} fresh-token attempts (${response.status}): ${detail}`),
            { providerRejectedBeforeGeneration: true }
          );
        }
        throw new Error(`Flow image generation failed (${response.status}): ${detail}`);
      }
      const generated = json?.media?.[0]?.image?.generatedImage;
      if (!generated?.fifeUrl) throw new Error('Flow returned no image URL.');
      const image = await downloadImage(generated.fifeUrl);
      return {
        ...image,
        mediaId: generated.mediaId || json.media[0].name,
        seed: generated.seed ?? prepared.seed,
        width: json.media[0]?.image?.dimensions?.width,
        height: json.media[0]?.image?.dimensions?.height,
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
      const response = await fetch(`${API}/flow/uploadImage`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientContext: { projectId, tool: 'PINHOLE' },
          imageBytes: payload.base64,
          isUserUploaded: true,
          isHidden: false,
          mimeType: payload.mime || 'image/png',
          fileName: payload.fileName || 'scene.png',
        }),
      });
      if (!response.ok) throw new Error(`Flow image upload failed (${response.status}).`);
      const json = await response.json();
      if (!json?.media?.name) throw new Error('Flow upload returned no media id.');
      return { mediaId: json.media.name };
    };
    const getContext = async () => {
      let signedIn = false;
      try {
        await accessToken();
        signedIn = true;
      } catch {
        // The panel needs a state result, not an exception, for signed-out tabs.
      }
      return { projectId: currentProjectId(), signedIn, url: location.href };
    };
    const createProject = async () => {
      const title =
        payload.title ||
        new Date().toLocaleString('en-US', {
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      const response = await fetch('/fx/api/trpc/project.createProject', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ json: { projectTitle: title, toolName: 'PINHOLE' } }),
      });
      if (!response.ok) throw new Error(`Flow createProject failed (${response.status}).`);
      const json = await response.json();
      const projectId = json?.result?.data?.json?.result?.projectId;
      if (!projectId) throw new Error('Flow createProject returned no projectId.');
      return { projectId, title };
    };

    const handlers = {
      listImageModels,
      prepareGenerateImage,
      submitGenerateImage,
      generateImage,
      uploadImage,
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
