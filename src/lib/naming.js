// Filename + download-path construction for scene assets.
//
// Goal: every generated image is saved with a name derived from the Story
// Studio episode + scene it came from, optionally inside a per-project /
// per-episode subfolder of Downloads.
//
// chrome.downloads can write into subfolders *inside* the Downloads dir
// (forward-slash paths) but NOT to arbitrary absolute paths — that's the
// browser sandbox. Writing into the real "05 Scene Images" folder is the
// "project" save target, handled by POSTing the image back to Story Studio.

function sanitizeSegment(s) {
  return String(s ?? '')
    .replace(/[\/\\:*?"<>|]/g, '-') // path-illegal -> dash
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function applyTokens(template, tokens) {
  return template.replace(/\{(\w+)\}/g, (_, key) => sanitizeSegment(tokens[key] ?? ''));
}

// Build the Downloads-relative path (no leading slash, forward slashes only).
// e.g. "StoryStudioScenes/abiding-faith/EP0110/EP0110_scene_000001.png"
export function buildDownloadPath(settings, tokens, ext = 'png') {
  const dir = applyTokens(settings.downloadSubdir || '', tokens)
    .split('/')
    .map(sanitizeSegment)
    .filter(Boolean)
    .join('/');
  let name = applyTokens(settings.filenameTemplate || '{episodeCode}_{sceneId}', tokens);
  name = sanitizeSegment(name) || 'scene';
  const file = `${name}.${ext}`;
  return dir ? `${dir}/${file}` : file;
}

export { sanitizeSegment, applyTokens };
