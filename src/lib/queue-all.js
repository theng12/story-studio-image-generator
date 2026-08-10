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

export function summarizeQueueAll({ queued = 0, episodes = 0, failures = [] } = {}) {
  const success = `Queued ${countLabel(queued, 'scene')} across ${countLabel(episodes, 'episode')}.`;
  if (!failures.length) return { kind: 'done', text: success };

  const codes = failures.slice(0, 8).map(({ code }) => String(code || 'unknown')).join(', ');
  const remaining = failures.length > 8 ? ` +${failures.length - 8} more` : '';
  const firstError = safeError(failures[0]?.error);
  return {
    kind: 'err',
    text: `${success} Failed ${countLabel(failures.length, 'episode')} (${codes}${remaining}). First error: ${firstError}`,
  };
}
