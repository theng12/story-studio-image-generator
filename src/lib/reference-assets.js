function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function filenameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url, 'https://story-studio.invalid').pathname.split('/').pop() || 'reference.png');
  } catch {
    return 'reference.png';
  }
}

function asset(source, label, value) {
  const url = text(record(value).url);
  return url ? { source, label, url, filename: filenameFromUrl(url) } : null;
}

function characterImages(character) {
  const refs = record(character.references);
  const images = Array.isArray(refs.images) ? refs.images : Array.isArray(character.reference_images) ? character.reference_images : [];
  return images
    .map((image) => {
      const item = record(image);
      const filename = text(typeof image === 'string' ? image : item.filename || item.name);
      const url = text(item.url);
      return filename && url ? { filename, url } : null;
    })
    .filter(Boolean);
}

function matchesName(prompt, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(prompt);
}

export function normalizeReferenceContext({ continuity, listing, characters } = {}) {
  const continuityRoot = record(continuity);
  const config = record(continuityRoot.config || continuityRoot);
  const references = record(config.references);
  const refs = record(listing);
  const assets = {
    master: asset('master', 'Episode master reference', refs.master),
    thumbnail: asset('thumbnail', 'Thumbnail reference', refs.thumbnail),
    style: asset('style', 'Style reference', refs.style),
    composition: asset('composition', 'Composition reference', refs.composition),
    scenes: (Array.isArray(refs.scenes) ? refs.scenes : [])
      .map((scene) => {
        const item = record(scene);
        const number = Number(item.number);
        const descriptor = asset('scene', `Scene ${Number.isFinite(number) ? number : ''} reference`.trim(), item);
        return Number.isFinite(number) && descriptor ? { number, ...descriptor } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.number - b.number),
  };
  const normalizedCharacters = (Array.isArray(characters) ? characters : [])
    .map((character) => {
      const item = record(character);
      const id = text(item.id);
      const name = text(item.name);
      const images = characterImages(item);
      return id && name && images.length ? { id, name, images } : null;
    })
    .filter(Boolean);

  return {
    assets,
    characters: normalizedCharacters,
    continuity: {
      anchors: (Array.isArray(config.anchor_character_ids) ? config.anchor_character_ids : []).map(text).filter(Boolean),
      sheet: references.sheet === true || (references.sheet == null && config.use_episode_sheet === true),
      characters: references.characters === true,
      style: references.style === true,
      composition: references.composition === true,
    },
  };
}

function characterDescriptors(characters) {
  return characters.flatMap((character) =>
    character.images.map((image) => ({
      source: 'character',
      label: `Character reference: ${character.name}`,
      url: image.url,
      characterId: character.id,
      filename: image.filename,
    }))
  );
}

export function resolveReferenceDescriptors({ kind, sceneKey, prompt, context, maxReferences } = {}) {
  const normalized = record(context).assets && Array.isArray(record(context).characters)
    ? context
    : normalizeReferenceContext(context);
  const cap = Math.max(0, Math.floor(Number(maxReferences) || 0));
  if (!cap) return [];
  if (kind === 'thumbnail') return normalized.assets.thumbnail ? [normalized.assets.thumbnail] : [];
  if (kind !== 'scene') return [];

  const sceneNumber = Number(sceneKey);
  const matchingScene = normalized.assets.scenes.find((scene) => scene.number === sceneNumber);
  const matchingCharacters = normalized.continuity.characters
    ? normalized.characters.filter((character) => matchesName(String(prompt || ''), character.name))
    : [];
  const matchedIds = new Set(matchingCharacters.map((character) => character.id));
  const anchors = normalized.continuity.characters
    ? normalized.characters.filter((character) => normalized.continuity.anchors.includes(character.id) && !matchedIds.has(character.id))
    : [];
  const candidates = [
    normalized.continuity.sheet && normalized.assets.master,
    matchingScene,
    ...characterDescriptors(matchingCharacters),
    ...characterDescriptors(anchors),
    normalized.continuity.composition && normalized.assets.composition,
    normalized.continuity.style && normalized.assets.style,
  ].filter(Boolean);
  const seen = new Set();
  return candidates.filter((descriptor) => {
    if (seen.has(descriptor.url)) return false;
    seen.add(descriptor.url);
    return true;
  }).slice(0, cap);
}

export function legacyCharacterReferenceDescriptor(slug, characterRef) {
  const project = text(slug);
  const reference = record(characterRef);
  const characterId = text(reference.characterId);
  const filename = text(reference.filename);
  if (!project || !characterId || !filename) return null;
  return {
    source: 'character',
    label: `Character reference: ${characterId}`,
    url: `/api/projects/${encodeURIComponent(project)}/characters/${encodeURIComponent(characterId)}/reference-image/${encodeURIComponent(filename)}`,
    characterId,
    filename,
  };
}
