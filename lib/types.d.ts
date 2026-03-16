export type IndexOptions<KeyPath extends string | string[] = string> = {
	name: string
	path: KeyPath
	unique?: boolean
	multiEntry?: boolean
}

type DeleteStore = {
	type: 'store.delete'
	name: string
}

type DeleteIndex = {
	type: 'index.delete'
	store: string
	name: string
}

type CreateStore = {
	type: 'store.create'
	name: string
	indexes?: IndexOptions[]
}

type CreateIndex = {
	type: 'index.create'
	opts: IndexOptions
	store: string
}

export type IDBMigration = CreateStore | DeleteStore | CreateIndex | DeleteIndex
