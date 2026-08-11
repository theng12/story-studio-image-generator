export function createSettingsStore({ load, save, normalize = (settings) => settings } = {}) {
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new TypeError('Settings store needs load and save functions.');
  }

  let tail = Promise.resolve();
  const serialized = (operation) => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const current = async () => normalize({ ...(await load()) });

  return {
    read: () => serialized(current),
    patch: (patch) => serialized(async () => {
      const settings = await current();
      const changes = typeof patch === 'function' ? await patch({ ...settings }) : patch;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new TypeError('Settings patch must be an object.');
      }
      const next = normalize({ ...settings, ...changes });
      await save(next, changes);
      return next;
    }),
  };
}
