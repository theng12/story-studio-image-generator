// Durable bytes stay outside the JSON queue and survive MV3 suspension.
let database;
function openDatabase() {
  return (database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('gateway-image-artifacts', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('artifacts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(new Error('Gateway artifact storage is unavailable.')); };
  }));
}
async function access(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('artifacts', mode);
    const request = operation(transaction.objectStore('artifacts'));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(new Error('Gateway artifact storage failed; work is held.'));
  });
}
export const getGatewayArtifact = (jobId) => access('readonly', (store) => store.get(jobId));
export const putGatewayArtifact = (jobId, value) => access('readwrite', (store) => store.put(value, jobId));
export const deleteGatewayArtifact = (jobId) => access('readwrite', (store) => store.delete(jobId));
