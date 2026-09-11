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
  const progress = assetProgress(row, 'scene_images');
  const markedDone = row?.status?.images === true || row?.st?.images === true;
  return {
    ...progress,
    complete: markedDone || progress.complete,
    markedDone: markedDone && !progress.complete,
  };
}

export function thumbnailImageProgress(row) {
  const progress = assetProgress(row, 'thumbnail_images');
  const markedDone = row?.status?.thumbnails === true || row?.st?.thumbnails === true;
  return {
    ...progress,
    complete: markedDone || progress.complete,
    markedDone,
  };
}

export function thumbnailAvailability(rows) {
  const withPrompts = rows.filter((row) => (row?.st || row?.status || {}).thumb_prompts === true);
  const done = withPrompts.filter((row) => thumbnailImageProgress(row).complete).length;
  return {
    withPrompts: withPrompts.length,
    done,
    pending: withPrompts.length - done,
    withoutPrompts: rows.length - withPrompts.length,
  };
}

export function episodeProgressLabel(progress) {
  if (progress.markedDone) return 'Marked done ✓';
  if (progress.total === 0) return progress.complete ? 'Done ✓' : 'Pending';
  return `${progress.present}/${progress.total}${progress.complete ? ' ✓' : ''}`;
}

export function newlySettledEpisodeCodes(previousQueue, queue, slug = null) {
  if (!Array.isArray(previousQueue)) return [];
  const previousById = new Map(previousQueue.map((item) => [item.id, item]));
  const currentIds = new Set(queue.map((item) => item.id));
  const byEpisode = new Map();
  const transitioned = new Set();
  const savedEvidence = new Set();
  const removedDone = new Set();

  for (const item of queue) {
    if ((slug && item.slug !== slug) || !item.episodeCode) continue;
    const items = byEpisode.get(item.episodeCode) || [];
    items.push(item);
    byEpisode.set(item.episodeCode, items);
    if (item.status === 'done') savedEvidence.add(item.episodeCode);
    if (
      ['pending', 'running'].includes(previousById.get(item.id)?.status)
      && ['done', 'failed'].includes(item.status)
    ) transitioned.add(item.episodeCode);
  }

  for (const item of previousQueue) {
    if ((slug && item.slug !== slug) || !item.episodeCode || currentIds.has(item.id)) continue;
    if (['pending', 'running', 'done'].includes(item.status)) transitioned.add(item.episodeCode);
    if (item.status === 'done') {
      savedEvidence.add(item.episodeCode);
      removedDone.add(item.episodeCode);
    }
  }

  return [...transitioned].filter((code) => {
    const items = byEpisode.get(code) || [];
    const settled = items.every((item) => !['pending', 'running'].includes(item.status));
    return removedDone.has(code) || (savedEvidence.has(code) && settled);
  });
}

export function createEpisodeRefreshQueue() {
  const pending = new Map();
  return {
    add(codes) {
      for (const code of codes) if (code && !pending.has(code)) pending.set(code, 0);
    },
    snapshot(now = Date.now()) {
      return [...pending]
        .filter(([, retryAt]) => retryAt <= now)
        .map(([code]) => code);
    },
    complete(codes) {
      for (const code of codes) pending.delete(code);
    },
    defer(codes, delayMs, now = Date.now()) {
      for (const code of codes) if (pending.has(code)) pending.set(code, now + delayMs);
    },
    clear() {
      pending.clear();
    },
  };
}

export function createVisibleEpisodeIndex() {
  const links = new Map();
  let firstCode = '';
  let lastCode = '';

  function add(code) {
    if (!code || links.has(code)) return;
    links.set(code, { previous: lastCode, next: '' });
    if (lastCode) links.get(lastCode).next = code;
    else firstCode = code;
    lastCode = code;
  }

  return {
    reset(codes) {
      links.clear();
      firstCode = '';
      lastCode = '';
      for (const code of codes) add(code);
    },
    remove(code) {
      const link = links.get(code);
      if (!link) return firstCode;
      if (link.previous) links.get(link.previous).next = link.next;
      else firstCode = link.next;
      if (link.next) links.get(link.next).previous = link.previous;
      else lastCode = link.previous;
      links.delete(code);
      return link.next || firstCode;
    },
    has(code) {
      return links.has(code);
    },
    first() {
      return firstCode;
    },
  };
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

export function createEpisodeAssetLoadRunner() {
  let revision = 0;
  return {
    cancel() {
      revision++;
    },
    async run(load, { onStart, onSuccess, onError, onFinish = () => {} }) {
      const current = ++revision;
      onStart();
      try {
        const value = await load();
        if (current !== revision) return false;
        onSuccess(value);
        return true;
      } catch (error) {
        if (current !== revision) return false;
        onError?.(error);
        return false;
      } finally {
        if (current === revision) onFinish();
      }
    },
  };
}
