// Recently opened files, kept in this browser (IndexedDB) as file handles so they can be reopened
// with a click. Needs the File System Access API (Chrome, Edge); elsewhere the list stays empty.
// The browser asks for permission to read a file again the first time it is reopened in a session.
//
//   await Recent.list()           -> [{ name, size, modified, opened, handle, custom, city, epws, weather, use, results }], newest first
//   await Recent.add(handle, file) remembers a file just opened (up to Recent.MAX)
//   await Recent.remove(index)
//   await Recent.link(handle, { custom, city, epws, weather, use, results })  a model's typed custom location, city,
//                                 attached weather files (epws: [{ id, name, bytes }]), the one used as weather data source
//                                 (weather: its id), which location source it uses and results files (any of them)
//   await Recent.links(handle)    -> { custom: { lat, lon, utcOffset } | null, city: { lat, lon, utcOffset, name } | null,
//                                      epws: [{ id, name, bytes }], weather: id | null,
//                                      use: 'custom' | 'city' | 'file' | 'epw:<id>' | null, results: [{ id, name, size }] }
//   await Recent.putResult(id, bytes), Recent.resultBytes(id), Recent.dropResults(ids)  a results file's copy
//
// A model's weather files are kept as copies, so they come back without another permission prompt. So are
// its results files, each under its own key, as they can be large and the list is read often. Records
// saved before weather files were a list (one epw: { name, bytes }, and a city saved as custom) still read.

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
        custom: old.custom || null, city: old.city || null, epws: old.epws || null, epw: old.epw || null, weather: old.weather ?? null,
        use: old.use || null, results: old.results || [] }, ...rest].slice(0, this.MAX));
      for (const gone of rest.slice(this.MAX - 1)) await this.dropResults((gone.results || []).map((r) => r.id));
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
      if (changes.epws) delete list[i].epw; // replaced by the list: the old single weather file goes
      await this.save(list);
    });
  },

  async links(handle) {
    const list = await this.list(), i = await this.find(list, handle), r = list[i] || {};
    const old = r.epws ? null : r.epw; // saved before weather files were a list
    const custom = r.custom && !r.custom.name ? r.custom : null;
    const city = r.city || (r.custom?.name ? r.custom : null);
    const epws = r.epws || (old ? [{ id: 'legacy', name: old.name, bytes: old.bytes }] : []);
    const weather = r.weather ?? (old ? 'legacy' : null);
    const use = r.use === 'epw' ? 'epw:legacy' : r.use === 'custom' && !custom ? 'city' : r.use || null;
    return { custom, city, epws, weather, use, results: r.results || [] };
  },

  remove(index) {
    return this.serial(async () => {
      const list = await this.list();
      const [gone] = list.splice(index, 1);
      await this.save(list);
      await this.dropResults((gone?.results || []).map((r) => r.id));
    });
  },

  putResult(id, bytes) { return this.store('readwrite', (s) => s.put(bytes, `result:${id}`)); },
  resultBytes(id) { return this.store('readonly', (s) => s.get(`result:${id}`)); },
  async dropResults(ids) {
    try { if (ids.length) await this.store('readwrite', (s) => { for (const id of ids) s.delete(`result:${id}`); }); } catch (e) { /* storage unavailable */ }
  },
};
