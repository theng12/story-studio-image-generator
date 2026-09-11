function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function safeError(value, max = 180) {
  return String(value || 'Unknown queue error')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function summarizeQueueAll({ queued = 0, episodes = 0, failures = [], kind = 'scene' } = {}) {
  const asset = kind === 'thumbnail' ? 'thumbnail' : 'scene';
  const success = `Queued ${countLabel(queued, asset)} across ${countLabel(episodes, 'episode')}.`;
  if (!failures.length) return { kind: 'done', text: success };

  const codes = failures.slice(0, 8).map(({ code }) => String(code || 'unknown')).join(', ');
  const remaining = failures.length > 8 ? ` +${failures.length - 8} more` : '';
  const firstError = safeError(failures[0]?.error);
  return {
    kind: 'err',
    text: `${success} Failed ${countLabel(failures.length, 'episode')} (${codes}${remaining}). First error: ${firstError}`,
  };
}

export function pendingEpisodeRows(rows, kind) {
  const progress = kind === 'thumbnail' ? thumbnailImageProgress : sceneImageProgress;
  return rows
    .filter((row) => kind === 'thumbnail'
      ? (row?.status || row?.st || {}).thumb_prompts === true
      : (row?.status || row?.st || {}).scene_plan === true)
    .filter((row) => !progress(row).complete)
    .sort((a, b) => {
      const aCode = String(a?.episode_code || a?.code || '');
      const bCode = String(b?.episode_code || b?.code || '');
      const aNumber = Number(aCode.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);
      const bNumber = Number(bCode.match(/\d+/)?.[0] || Number.MAX_SAFE_INTEGER);
      return aNumber - bNumber || aCode.localeCompare(bCode);
    });
}

export async function queuePendingEpisodes({ context, loadAssets, enqueue }) {
  let queued = 0;
  let episodes = 0;
  const failures = [];
  for (const episode of context.episodes) {
    try {
      const result = await loadAssets({
        kind: context.kind,
        slug: context.project.slug,
        episode,
      });
      const missing = (result.scenes || []).filter((scene) => !scene.hasImage && (scene.prompt || '').trim());
      if (!missing.length) continue;
      const payload = captureSceneEnqueueContext({
        project: context.project,
        episode,
        source: result.source,
        scenes: missing,
        kind: context.kind,
        target: 'project',
        provider: context.provider,
        flowModelApproval: context.flowModelApproval,
      });
      const response = await enqueue(payload);
      if (!response?.ok) {
        failures.push({ code: episode.code, error: response?.error || 'The extension did not accept this episode.' });
      } else {
        queued += response.added || 0;
        episodes++;
      }
    } catch (error) {
      failures.push({ code: episode.code, error: error?.message || error });
    }
  }
  return { queued, episodes, failures, kind: context.kind };
}
import { captureSceneEnqueueContext } from './enqueue-context.js';
import { sceneImageProgress, thumbnailImageProgress } from './episode-progress.js';
