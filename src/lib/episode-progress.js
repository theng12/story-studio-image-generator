const count = (value) => Math.max(0, Number(value) || 0);

function assetProgress(row, field) {
  const progress = row?.[field] || {};
  return {
    total: count(progress.total),
    present: count(progress.present),
    complete: progress.complete === true,
  };
}

// Story Studio accepts completion once every planned image exists; approval is separate.
export function sceneImageProgress(row) {
  return assetProgress(row, 'scene_images');
}

export function thumbnailImageProgress(row) {
  return assetProgress(row, 'thumbnail_images');
}

export function episodeFilterState(rows, { kind, filter, selectedCode }) {
  const progress = kind === 'thumbnail' ? thumbnailImageProgress : sceneImageProgress;
  const progressByCode = Object.fromEntries(rows.map((row) => [row.code, progress(row)]));
  const visibleCodes = rows
    .filter((row) => kind === 'thumbnail' ? row.st?.thumb_prompts : row.st?.scene_plan)
    .filter((row) => filter === 'all' || (filter === 'done') === progressByCode[row.code].complete)
    .map((row) => row.code);
  return {
    visibleCodes,
    selectedCode: visibleCodes.includes(selectedCode) ? selectedCode : (visibleCodes[0] || ''),
    progressByCode,
  };
}
