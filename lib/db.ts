interface IndexParams extends IDBIndexParameters {
	path: string | Iterable<string>
}

interface StoreParams extends IDBObjectStoreParameters {
	indexes?: Record<string, IndexParams>
}

export function createStores(db: IDBDatabase, stores: Record<string, StoreParams>) {
	for (const [name, { indexes, ...dbopts }] of Object.entries(stores)) {
		const store = db.createObjectStore(name, dbopts)
		if (!indexes) continue
		for (const [name, { path, ...opts }] of Object.entries(indexes)) {
			store.createIndex(name, path, opts)
		}
	}
}

type ExtractStoreKey<T extends Record<string, unknown>, P extends StoreParams> = P extends { keyPath: infer K } ? T[K] : unknown

type A = ExtractStoreKey<{ id: number, name: string }, { keyPath: 'name' }>

function makeDb<Stores extends Record<string, StoreParams>>(name: string, opts: { version?: number; stores: Stores }) {
}