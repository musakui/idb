export type IndexOptions = {
	path: string | Iterable<string>
	unique?: boolean
	multiEntry?: boolean
}

type DeleteStore = {
	type: 'store.delete'
	name: string
}

type CreateStore = {
	type: 'store.create'
	name: string
	opts?: IDBObjectStoreParameters
	indexes?: Record<string, IndexOptions>
}

type DeleteIndex = {
	type: 'index.delete'
	store: string
	name: string
}

type CreateIndex = {
	type: 'index.create'
	store: string
	name: string
	opts: IndexOptions
}

export type IDBMigration = CreateStore | DeleteStore | CreateIndex | DeleteIndex

export function applyMigrations(tx: IDBTransaction, migrations: IDBMigration[]) {
	for (const m of migrations) {
		switch (m.type) {
			case 'store.create': {
				const store = tx.db.createObjectStore(m.name, m.opts)
				for (const [name, { path, ...opts }] of Object.entries(m.indexes ?? {})) {
					store.createIndex(name, path, opts)
				}
			}
			case 'store.delete': {
				tx.db.deleteObjectStore(m.name)
				break
			}
			case 'index.create': {
				const { path, ...opts } = m.opts
				tx.objectStore(m.store).createIndex(m.name, path, opts)
				break
			}
			case 'index.delete': {
				tx.objectStore(m.store).deleteIndex(m.name)
				break
			}
		}
	}
}
