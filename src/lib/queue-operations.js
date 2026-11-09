import { activeWorkKey } from './queue-identity.js';
import { gatewayNeedsReview } from './queue-migration.js';

let sequence = 0;

export function enqueueItems(queue, items, now = Date.now()) {
  if (!items?.length) return { queue, added: 0, skipped: 0 };

  let next = queue;
  if (!next.some((item) => item.status === 'pending' || item.status === 'running')) {
    const held = next.filter(gatewayNeedsReview);
    next = [...held, ...next.filter((item) => item.status === 'failed' && !gatewayNeedsReview(item)).slice(-100)];
  }

  const incoming = new Set(items.map(activeWorkKey).filter(Boolean));
  if (incoming.size) {
    next = next.filter((item) => !(item.status === 'failed' && !gatewayNeedsReview(item) && incoming.has(activeWorkKey(item))));
  }
  const active = new Set(
    next
      .filter((item) => item.status === 'pending' || item.status === 'running')
      .map(activeWorkKey)
      .filter(Boolean)
  );

  let added = 0;
  let skipped = 0;
  for (const item of items) {
    const key = activeWorkKey(item);
    if (key && active.has(key)) {
      skipped++;
      continue;
    }
    next.push({ ...item, id: item.id || `${now}_${sequence++}`, status: 'pending', queuedAt: item.queuedAt || now });
    if (key) active.add(key);
    added++;
  }
  return { queue: next, added, skipped };
}
