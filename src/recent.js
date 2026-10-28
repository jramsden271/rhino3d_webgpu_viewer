// Recently opened files, kept in this browser (IndexedDB) as file handles so they can be reopened
// with a click. Needs the File System Access API (Chrome, Edge); elsewhere the list stays empty.
// The browser asks for permission to read a file again the first time it is reopened in a session.
//
//   await Recent.list()           -> [{ name, size, modified, opened, handle }], newest first
//   await Recent.add(handle, file) remembers a file just opened (up to Recent.MAX)
//   await Recent.remove(index)

const Recent = {
  MAX: 5,
  supported: typeof window.showOpenFilePicker === 'function' && 'indexedDB' in window,

  db() {
    return (this.dbp ||= new Promise((resolve, reject) => {
      const r = indexedDB.open('3dm-viewer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  },

  async store(mode, fn) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', mode), req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  },

  async list() {
    if (!this.supported) return [];
    try { return (await this.store('readonly', (s) => s.get('recent'))) || []; } catch (e) { return []; }
  },

  async save(list) {
    try { await this.store('readwrite', (s) => s.put(list, 'recent')); } catch (e) { /* storage unavailable */ }
  },

  async add(handle, file) {
    if (!this.supported || !handle) return;
    const list = await this.list();
    // The same file opened again moves to the top.
    const same = await Promise.all(list.map((r) => r.handle.isSameEntry(handle).catch(() => false)));
    const rest = list.filter((_, i) => !same[i]);
    await this.save([{ name: file.name, size: file.size, modified: file.lastModified, opened: Date.now(), handle }, ...rest].slice(0, this.MAX));
  },

  async remove(index) {
    const list = await this.list();
    list.splice(index, 1);
    await this.save(list);
  },
};
