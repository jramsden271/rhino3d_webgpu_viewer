// Recently opened files, kept in this browser (IndexedDB) as file handles so they can be reopened
// with a click. Needs the File System Access API (Chrome, Edge); elsewhere the list stays empty.
// The browser asks for permission to read a file again the first time it is reopened in a session.
//
//   await Recent.list()           -> [{ name, size, modified, opened, handle, custom, epw }], newest first
//   await Recent.add(handle, file) remembers a file just opened (up to Recent.MAX)
//   await Recent.remove(index)
//   await Recent.link(handle, { custom, epw, use })  a model's custom location, weather file and
//                                 which location source it uses (any of them)
//   await Recent.links(handle)    -> { custom: { lat, lon, utcOffset, name } | null, epw: { name, bytes } | null,
//                                      use: 'custom' | 'epw' | 'file' | null }
//
// A model's weather file is kept as a copy, so it comes back without another permission prompt.

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

  // Changes to the list run one at a time, so one cannot overwrite another made just before it.
  serial(fn) {
    const p = (this.chain || Promise.resolve()).then(fn);
    this.chain = p.catch(() => {});
    return p;
  },

  add(handle, file) {
    if (!this.supported || !handle) return Promise.resolve();
    return this.serial(async () => {
      const list = await this.list();
      // The same file opened again moves to the top, keeping its location and weather file.
      const i = await this.find(list, handle), old = i >= 0 ? list[i] : {};
      const rest = list.filter((_, k) => k !== i);
      await this.save([{ name: file.name, size: file.size, modified: file.lastModified, opened: Date.now(), handle,
        custom: old.custom || null, epw: old.epw || null, use: old.use || null }, ...rest].slice(0, this.MAX));
    });
  },

  async find(list, handle) {
    const same = await Promise.all(list.map((r) => r.handle.isSameEntry(handle).catch(() => false)));
    return same.indexOf(true);
  },

  link(handle, changes) {
    return this.serial(async () => {
      const list = await this.list(), i = await this.find(list, handle);
      if (i < 0) return;
      Object.assign(list[i], changes);
      await this.save(list);
    });
  },

  async links(handle) {
    const list = await this.list(), i = await this.find(list, handle);
    return { custom: list[i]?.custom || null, epw: list[i]?.epw || null, use: list[i]?.use || null };
  },

  remove(index) {
    return this.serial(async () => {
      const list = await this.list();
      list.splice(index, 1);
      await this.save(list);
    });
  },
};
