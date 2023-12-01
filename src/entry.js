import { wrap } from './wrap-idb-value.js';

/**
 * Open a database.
 *
 * @template {import('./types').DBSchema} DBTypes
 * @param {string} name Name of the database.
 * @param {number} [version] Schema version.
 * @param {import('./types').OpenDBCallbacks<DBTypes>} [cbs] Additional callbacks.
 * @return {Promise<import('./types').IDBPDatabase<DBTypes>}
 */
export function openDB(name, version, cbs = {}) {
  const request = indexedDB.open(name, version);
  const openPromise = wrap(request);

  if (cbs.upgrade) {
    request.addEventListener('upgradeneeded', (evt) => {
      cbs.upgrade(
        wrap(request.result),
        evt.oldVersion,
        evt.newVersion,
        wrap(request.transaction),
        evt,
      );
    });
  }

  if (cbs.blocked) {
    request.addEventListener('blocked', (evt) => {
      cbs.blocked(evt.oldVersion, evt.newVersion, evt);
    });
  }

  openPromise
    .then((db) => {
      if (cbs.terminated) db.addEventListener('close', () => cbs.terminated());
      if (cbs.blocking) {
        db.addEventListener('versionchange', (evt) => {
          cbs.blocking(evt.oldVersion, evt.newVersion, evt);
        });
      }
    })
    .catch(() => {});

  return openPromise;
}

/**
 * Delete a database.
 *
 * @param {string} name Name of the database.
 * @param {import('./types').DeleteDBCallbacks} [callbacks]
 */
export function deleteDB(name, callbacks = {}) {
  const request = indexedDB.deleteDatabase(name);

  if (callbacks.blocked) {
    request.addEventListener('blocked', (event) => {
      callbacks.blocked(event.oldVersion, event);
    });
  }

  return wrap(request).then(() => {});
}

export { unwrap, wrap } from './wrap-idb-value.js';
