// Flow's batchexecute RPC ids are internals that can move between builds. Nothing here assumes a
// specific id: ids come from exchanges observed on the live page, with a configurable fallback
// (settings.rpcIds) used only when discovery cannot identify one. A miss is named, never silent.
export const RPC_NAMES = ['generate', 'upload'];

// Classify one observed batchexecute exchange by markers in its request or response.
export function classifyExchange({ rpcid, request = '', response = '' } = {}) {
  if (typeof rpcid !== 'string' || !rpcid) return null;
  const req = String(request);
  const res = String(response);
  if (/flow-content\.google/.test(res)) return 'generate';
  // Upload bodies carry a long base64 media blob.
  if (/[A-Za-z0-9+/]{400,}={0,2}/.test(req)) return 'upload';
  return null;
}

// observations: [{ rpcid, request, response }] recorded on this page.
// fallback: { account, credits, generate, upload } configured ids.
export function resolveRpcIds({ observations = [], fallback = {} } = {}) {
  const discovered = {};
  for (const row of observations) {
    const name = classifyExchange(row);
    if (name && !discovered[name]) discovered[name] = row.rpcid;
  }
  const ids = {};
  const sources = {};
  const problems = [];
  for (const name of RPC_NAMES) {
    if (discovered[name]) {
      ids[name] = discovered[name];
      sources[name] = 'discovered';
    } else if (typeof fallback[name] === 'string' && fallback[name]) {
      ids[name] = fallback[name];
      sources[name] = 'fallback';
    } else {
      sources[name] = 'missing';
      problems.push(`${name}: no id was observed on the page and no fallback is configured`);
    }
  }
  return { ids, sources, problems };
}
