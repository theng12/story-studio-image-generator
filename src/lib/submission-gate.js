export function createSubmissionGate({ persist, createToken = () => crypto.randomUUID() } = {}) {
  if (typeof persist !== 'function') throw new TypeError('Submission gate needs a persistence function.');
  const requests = new Map();

  return {
    arm({ itemId, provider, tabId }) {
      const token = String(createToken());
      if (!token || requests.has(token)) throw new Error('Submission checkpoint token is invalid or duplicated.');
      const request = { token, itemId, provider, tabId, checkpointed: false, checkpointPromise: null };
      requests.set(token, request);
      return request;
    },

    async checkpoint({ token, tabId }) {
      const request = requests.get(String(token || ''));
      if (!request) throw new Error('Provider submission was not armed.');
      if (request.tabId !== tabId) throw new Error('Submission checkpoint came from the wrong provider tab.');
      if (!request.checkpointPromise) {
        request.checkpointPromise = Promise.resolve()
          .then(() => persist(request))
          .then(() => { request.checkpointed = true; })
          .catch((error) => {
            request.checkpointPromise = null;
            throw error;
          });
      }
      await request.checkpointPromise;
      return request;
    },

    canReplayTransport(token) {
      const request = requests.get(String(token || ''));
      return request ? !request.checkpointed : false;
    },

    release(token) {
      const request = requests.get(String(token || '')) || null;
      requests.delete(String(token || ''));
      return request;
    },
  };
}
