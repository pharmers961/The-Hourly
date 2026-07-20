// Offline capture queue. When an upload fails because the device has no
// connection, the fully-prepared capture (compressed image, thumbnail,
// metadata, chosen groups, and the original capture time) is parked in
// IndexedDB — localStorage can't hold blobs — and retried automatically
// whenever connectivity returns or the app comes back to the foreground.
import { PhotoMetadata } from './types';

export interface PendingCapture {
  id: string;
  imageBlob: Blob;
  thumbBlob: Blob | null;
  metadata: PhotoMetadata;
  groupIds: string[];
  takenAt: string; // ISO — preserves the hour slot the photo belongs to
  attempts: number; // non-network failures only; item is dropped after too many
}

const DB_NAME = 'the-hourly-offline';
const STORE = 'pending-captures';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

// put() upserts, so this both enqueues new items and updates retry counts.
export function saveQueuedCapture(item: PendingCapture): Promise<void> {
  return withStore('readwrite', s => s.put(item)).then(() => undefined);
}

export function listQueuedCaptures(): Promise<PendingCapture[]> {
  return withStore('readonly', s => s.getAll() as IDBRequest<PendingCapture[]>);
}

export function removeQueuedCapture(id: string): Promise<void> {
  return withStore('readwrite', s => s.delete(id)).then(() => undefined);
}

// Distinguishes "no connection" (worth queueing and retrying) from a real
// server rejection (which would fail identically on every retry).
export function looksOffline(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'object' && err && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
  return /failed to fetch|load failed|networkerror|network error|network request failed|fetch failed|timed? ?out/i.test(message);
}
