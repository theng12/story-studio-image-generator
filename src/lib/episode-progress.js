const count = (value) => Math.max(0, Number(value) || 0);

// Story Studio accepts completion once every planned image exists; approval is separate.
export function sceneImageProgress(row) {
  const progress = row?.scene_images || {};
  return {
    total: count(progress.total),
    present: count(progress.present),
    complete: progress.complete === true,
  };
}
