type UploadRecord = {
    datasetId: string;
    label: string;
    pipeline: string;
    preset: string;
    fingerprint: string;
    names: string[];
    totalBytes: number;
};

const DB_NAME = 'genesis-reconstruction';
const DB_VERSION = 1;
const STORE = 'uploads';

class UploadRecords {
    private db: Promise<IDBDatabase> | null = null;

    private open(): Promise<IDBDatabase> {
        if (!this.db) {
            this.db = new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = () => {
                    request.result.createObjectStore(STORE, { keyPath: 'datasetId' });
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return this.db;
    }

    private async run<T>(mode: 'readonly' | 'readwrite',
        action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const request = action(db.transaction(STORE, mode).objectStore(STORE));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    list(): Promise<UploadRecord[]> {
        return this.run('readonly', store => store.getAll() as IDBRequest<UploadRecord[]>);
    }

    async put(record: UploadRecord): Promise<void> {
        await this.run('readwrite', store => store.put(record));
    }

    async remove(datasetId: string): Promise<void> {
        await this.run('readwrite', store => store.delete(datasetId));
    }

    async reconcile(openDatasetIds: string[]): Promise<UploadRecord[]> {
        const open = new Set(openDatasetIds);
        const records = await this.list();
        const live = records.filter(record => open.has(record.datasetId));
        await Promise.all(records
        .filter(record => !open.has(record.datasetId))
        .map(record => this.remove(record.datasetId)));
        return live;
    }
}

export { UploadRecords };
export type { UploadRecord };
