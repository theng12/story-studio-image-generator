const sameQueue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function createQueueStore({ load, save, normalize = (queue) => queue } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new TypeError('Queue store needs load and save functions.');
  }

  let tail = Promise.resolve();
  const serialized = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const current = async () => {
    const raw = await load();
    const stored = Array.isArray(raw) ? raw : [];
    return { stored, queue: normalize(structuredClone(stored)) };
  };

  return {
    read: () => serialized(async () => {
      const { stored, queue } = await current();
      if (!sameQueue(stored, queue)) await save(queue);
      return queue;
    }),
    update: (mutator) => {
      if (typeof mutator !== 'function') {
        return Promise.reject(new TypeError('Queue update needs a mutator function.'));
      }
      return serialized(async () => {
        const { stored, queue } = await current();
        const next = await mutator(queue);
        if (!Array.isArray(next)) throw new TypeError('Queue mutator must return an array.');
        if (!sameQueue(stored, next)) await save(next);
        return next;
      });
    },
  };
}
