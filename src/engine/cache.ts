// Small IndexedDB wrapper. Every call tolerates IndexedDB being unavailable
// (Node, private windows): reads return undefined and writes are dropped.

const DB_NAME = 'eta-benchmarks'
const STORES = ['fileIndex', 'days'] as const
type Store = typeof STORES[number]

let dbPromise: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function run<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return open().then(db => new Promise<T | undefined>(resolve => {
    if (!db) return resolve(undefined)
    try {
      const tx = db.transaction(store, mode)
      const req = fn(tx.objectStore(store))
      req.onsuccess = () => resolve(req.result as T)
      req.onerror = () => resolve(undefined)
      tx.onabort = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  }))
}

export const cacheGet = <T>(store: Store, key: string) => run<T>(store, 'readonly', s => s.get(key))
export const cachePut = (store: Store, key: string, value: unknown) => run(store, 'readwrite', s => s.put(value, key))
export const cacheKeys = (store: Store) => run<IDBValidKey[]>(store, 'readonly', s => s.getAllKeys()).then(k => (k ?? []) as string[])
export const cacheClear = async () => { for (const s of STORES) await run(s, 'readwrite', st => st.clear()) }
