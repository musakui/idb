/** @typedef {import('./types').IDBPCursor} IDBPCursor */

/** @typedef {import('./types').IDBProxyable} IDBProxyable */

const advanceMethods = ['advance', 'continue', 'continuePrimaryKey'];
const readMethods = ['get', 'getKey', 'getAll', 'getAllKeys', 'count'];
const writeMethods = ['put', 'add', 'delete', 'clear'];

const transformCache = new WeakMap();
const reverseTransformCache = new WeakMap();

/**
 * Revert an enhanced IDB object to a plain old miserable IDB one.
 *
 * Will also revert a promise back to an IDBRequest.
 *
 * @type {import('./types').Unwrap}
 */
export const unwrap = (value) => reverseTransformCache.get(value);

/** @type {IDBProxyable[]} */
const idbProxyableTypes = [];

/** @type {Map<string, Function>} */
const cachedMethods = new Map();

/** @type {WeakMap<IDBPCursor, Promise<IDBPCursor | null>>} */
const advanceResults = new WeakMap();

/** @type {WeakSet<Function>} */
const cursorFunctions = new WeakSet();

/** @type {WeakMap<IDBTransaction, Promise<void>>} */
const transactionDoneMap = new WeakMap();

/** @type {WeakMap<IDBPCursor, IDBPCursor>} */
const proxiedCursorLookup = new WeakMap();

const isStoreLike = (v) => v instanceof IDBObjectStore || v instanceof IDBIndex;

/**
 * @returns {val is IDBProxyable}
 */
const isProxyable = (val) => {
  if (!idbProxyableTypes.length) {
    idbProxyableTypes.push(IDBDatabase, IDBCursor, IDBTransaction);
  }

  return isStoreLike(val) || idbProxyableTypes.some((c) => val instanceof c);
};

/**
 * @param {IDBProxyable} target
 * @param {string | symbol} prop
 */
const isIteratorProp = (target, prop) => {
  if (prop === Symbol.asyncIterator) {
    return isStoreLike(target) || target instanceof IDBCursor;
  }
  return prop === 'iterate' && isStoreLike(target);
};

/**
 * @type {ProxyHandler<IDBCursor | IDBIndex | IDBObjectStore>}
 */
const cursorIteratorTraps = {
  get(target, prop) {
    if (typeof prop !== 'string' || !advanceMethods.includes(prop)) {
      return target[prop];
    }

    if (!cachedMethods.has(prop)) {
      /** @this {IDBPCursor} */
      function func(...args) {
        const result = proxiedCursorLookup.get(this)[prop](...args);
        advanceResults.set(this, result);
      }

      cachedMethods.set(prop, func);
    }

    return cachedMethods.get(prop);
  },
};

/**
 * @this {import('./types').IDBPObjectStore | import('./types').IDBPIndex | IDBPCursor}
 */
async function* iterate(...args) {
  // tslint:disable-next-line:no-this-assignment
  let cursor = this;

  if (!(cursor instanceof IDBCursor)) {
    cursor = await cursor.openCursor(...args);
  }

  if (!cursor) return;

  const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
  proxiedCursorLookup.set(proxiedCursor, cursor);
  // Map this double-proxy back to the original, so other cursor methods work.
  reverseTransformCache.set(proxiedCursor, unwrap(cursor));

  while (cursor) {
    yield proxiedCursor;
    // If one of the advancing methods was not called, call continue().
    cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
    advanceResults.delete(proxiedCursor);
  }
}

/**
 * @template {Function} T
 * @param {T} func
 * @return {T}
 */
const wrapFunction = (func) => {
  // Due to expected object equality (which is enforced by the caching in `wrap`),
  // we only create one new func per func.

  // Calling the original function with the proxy as 'this' causes ILLEGAL INVOCATION
  // so we use the original object.

  if (cursorFunctions.has(func)) {
    /**
     * @this {IDBPCursor}
     * @param {Parameters<T>} args
     */
    return function (...args) {
      func.apply(unwrap(this), args);
      return wrap(this.request);
    };
  }

  /**
   * @param {Parameters<T>} args
   */
  return function (...args) {
    return wrap(func.apply(unwrap(this), args));
  };
};

/**
 * @template T
 * @param {IDBRequest<T>} request
 */
const promisifyRequest = (request) => {
  /** @type {Promise<T>} */
  const promise = new Promise((resolve, reject) => {
    const unlisten = () => {
      request.removeEventListener('success', success);
      request.removeEventListener('error', error);
    };
    const success = () => {
      resolve(wrap(request.result));
      unlisten();
    };
    const error = () => {
      reject(request.error);
      unlisten();
    };
    request.addEventListener('success', success);
    request.addEventListener('error', error);
  });

  // This mapping exists in reverseTransformCache but doesn't doesn't exist in transformCache.
  // This is because we create many promises from a single IDBRequest.
  reverseTransformCache.set(promise, request);
  return promise;
};

/**
 * @type {ProxyHandler<IDBProxyable>}
 */
const idbProxyTraps = {
  get(target, prop, receiver) {
    if (isIteratorProp(target, prop)) return iterate;

    if (typeof prop !== 'string') return wrap(target[prop]);

    const method = getMethod(target, prop);
    if (method) return method;

    if (target instanceof IDBCursor && advanceMethods.includes(prop)) {
      // Cursor methods are special, as the behaviour is a little more different to standard IDB. In
      // IDB, you advance the cursor and wait for a new 'success' on the IDBRequest that gave you the
      // cursor. It's kinda like a promise that can resolve with many values. That doesn't make sense
      // with real promises, so each advance methods returns a new promise for the cursor object, or
      // undefined if the end of the cursor has been reached.
      cursorFunctions.add(target[prop]);
      return wrap(target[prop]);
    }

    if (target instanceof IDBTransaction) {
      // Special handling for transaction.done.
      if (prop === 'done') return transactionDoneMap.get(target);

      // Make tx.store return the only store in the transaction, or undefined if there are many.
      if (prop === 'store') {
        return receiver.objectStoreNames[1]
          ? undefined
          : receiver.objectStore(receiver.objectStoreNames[0]);
      }
    }

    // Else transform whatever we get back.
    return wrap(target[prop]);
  },
  has(target, prop) {
    if (isIteratorProp(target, prop) || getMethod(target, prop)) return true;

    if (target instanceof IDBTransaction) {
      if (prop === 'done' || prop === 'store') return true;
    }

    return prop in target;
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
};

/** @param {unknown} value */
const transformCachableValue = (value) => {
  if (typeof value === 'function') return wrapFunction(value);

  // This doesn't return, it just creates a 'done' promise for the transaction,
  // which is later returned for transaction.done (see idbObjectHandler).
  if (value instanceof IDBTransaction && !transactionDoneMap.has(value)) {
    /** @type {Promise<void>} */
    const done = new Promise((resolve, reject) => {
      const unlisten = () => {
        value.removeEventListener('complete', complete);
        value.removeEventListener('error', error);
        value.removeEventListener('abort', error);
      };
      const complete = () => {
        resolve();
        unlisten();
      };
      const error = () => {
        reject(value.error || new DOMException('AbortError', 'AbortError'));
        unlisten();
      };
      value.addEventListener('complete', complete);
      value.addEventListener('error', error);
      value.addEventListener('abort', error);
    });

    // Cache it for later retrieval.
    transactionDoneMap.set(value, done);
  }

  return isProxyable(value) ? new Proxy(value, idbProxyTraps) : value;
};

/**
 * Enhance an IDB object with helpers.
 *
 * @type {import('./types').WrapItem}
 */
export function wrap(value) {
  // We sometimes generate multiple promises from a single IDBRequest (eg when cursoring), because
  // IDB is weird and a single IDBRequest can yield many responses, so these can't be cached.
  if (value instanceof IDBRequest) return promisifyRequest(value);

  // If we've already transformed this value before, reuse the transformed value.
  // This is faster, but it also provides object equality.
  if (transformCache.has(value)) return transformCache.get(value);
  const newValue = transformCachableValue(value);

  // Not all types are transformed.
  // These may be primitive types, so they can't be WeakMap keys.
  if (newValue !== value) {
    transformCache.set(value, newValue);
    reverseTransformCache.set(newValue, value);
  }

  return newValue;
}

/**
 * @param {IDBProxyable} target
 * @param {string | symbol} prop
 */
function getMethod(target, prop) {
  if (!(target instanceof IDBDatabase)) return;
  if (prop in target || typeof prop !== 'string') return;

  if (cachedMethods.has(prop)) return cachedMethods.get(prop);

  const targetFuncName = prop.replace(/FromIndex$/, '');
  const useIndex = prop !== targetFuncName;
  const isWrite = writeMethods.includes(targetFuncName);

  if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) ||
    !(isWrite || readMethods.includes(targetFuncName))
  ) {
    return;
  }

  /**
   * @this {import('./types').IDBPDatabase}
   * @param {string} storeName
   */
  const method = async function (storeName, ...args) {
    // isWrite ? 'readwrite' : undefined gzipps better, but fails in Edge :(
    const tx = this.transaction(storeName, isWrite ? 'readwrite' : 'readonly');
    /** @type {typeof tx.store | import('./types').IDBPIndex<unknown, string[], string, string, 'readwrite' | 'readonly'>} */
    let target = tx.store;
    if (useIndex) target = target.index(args.shift());

    // Must reject if op rejects.
    // If it's a write operation, must reject if tx.done rejects.
    // Must reject with op rejection first.
    // Must resolve with op value.
    // Must handle both promises (no unhandled rejections)
    return (
      await Promise.all([target[targetFuncName](...args), isWrite && tx.done])
    )[0];
  };

  cachedMethods.set(prop, method);
  return method;
}
