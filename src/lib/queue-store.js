const sameQueue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function storedState(raw) {
  if (Array.isArray(raw)) return { queue: raw, revision: 0 };
  return {
    queue: Array.isArray(raw?.queue) ? raw.queue : [],
    revision: Math.max(0, Number(raw?.revision) || 0),
  };
}

function staleRevisionError(expectedRevision, actualRevision) {
  return Object.assign(
    new Error(`Queue revision ${expectedRevision} is stale; current revision is ${actualRevision}.`),
    { code: 'stale-queue-revision', expectedRevision, actualRevision }
  );
}

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
    const state = storedState(raw);
    return {
      stored: state.queue,
      queue: normalize(structuredClone(state.queue)),
      revision: state.revision,
    };
  };

  const snapshot = () => serialized(async () => {
    const state = await current();
    if (!sameQueue(state.stored, state.queue)) {
      state.revision++;
      await save(state.queue, state.revision);
    }
    return { queue: state.queue, revision: state.revision };
  });

  const mutate = (mutator, { expectedRevision, touch = false } = {}) => {
    if (typeof mutator !== 'function') {
      return Promise.reject(new TypeError('Queue update needs a mutator function.'));
    }
    return serialized(async () => {
      const state = await current();
      if (!sameQueue(state.stored, state.queue)) {
        state.revision++;
        await save(state.queue, state.revision);
        state.stored = structuredClone(state.queue);
      }
      if (expectedRevision !== undefined && expectedRevision !== state.revision) {
        throw staleRevisionError(expectedRevision, state.revision);
      }
      const next = await mutator(state.queue);
      if (!Array.isArray(next)) throw new TypeError('Queue mutator must return an array.');
      if (touch || !sameQueue(state.stored, next)) {
        state.revision++;
        await save(next, state.revision);
      }
      return next;
    });
  };

  return {
    read: async () => (await snapshot()).queue,
    snapshot,
    update: (mutator, options) => mutate(mutator, options),
    updateIfRevision: (expectedRevision, mutator, options) =>
      mutate(mutator, { ...options, expectedRevision }),
  };
}
