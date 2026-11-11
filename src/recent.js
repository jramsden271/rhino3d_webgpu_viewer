// Projects, kept in this browser (IndexedDB). A project is what the home screen lists: a name, the
// 3dm files attached to it (kept as file handles, so they reopen with a click, never as copies, as
// they can be gigabytes), one of them active (the one open), and the model's settings: its custom
// location, city, weather files, which location source it uses and its results files.
// Needs the File System Access API (Chrome, Edge); elsewhere the list stays empty.
// The browser asks for permission to read a file again the first time it is reopened in a session.
//
//   await Recent.list()                  -> [{ id, name, opened, active, files: [{ id, name, size, modified, handle }],
//                                              custom, city, epws, weather, use, results }], newest first
//   await Recent.add(handle, file)       opens a file: its project (made if the file is new) moves to the top.
//                                        Returns the project's id.
//   await Recent.attach(projectId, handle, file)  adds a 3dm file to a project without opening it. Returns the file's id.
//   await Recent.activate(projectId, fileId)      the file the project opens next
//   await Recent.detach(projectId, fileId)        takes a file off a project (not the one open)
//   await Recent.remove(index)           removes a project (its results copies with it)
//   await Recent.link(handle, { custom, city, epws, weather, use, results })  a model's typed custom location, city,
//                                 attached weather files (epws: [{ id, name, bytes }]), the one used as weather data source
//                                 (weather: its id), which location source it uses and results files (any of them)
//   await Recent.links(handle)    -> { custom: { lat, lon, utcOffset } | null, city: { lat, lon, utcOffset, name } | null,
//                                      epws: [{ id, name, bytes }], weather: id | null,
//                                      use: 'custom' | 'city' | 'file' | 'epw:<id>' | null, results: [{ id, name, size }] }
//   await Recent.putResult(id, bytes), Recent.resultBytes(id), Recent.dropResults(ids)  a results file's copy
//
// A project's weather files are kept as copies, so they come back without another permission prompt. So are
// its results files, each under its own key, as they can be large and the list is read often. Records
// saved before projects (one file at the top level of the record) are turned into projects on read.
// Records saved before weather files were a list (one epw: { name, bytes }, and a city saved as custom) still read.

const Recent = {
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

  newId() { return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`; },

  async list() {
    if (!this.supported) return [];
    try {
      const list = (await this.store('readonly', (s) => s.get('recent'))) || [];
      if (this.toProjects(list)) await this.save(list);
      return list;
    } catch (e) { return []; }
  },

  async save(list) {
    try { await this.store('readwrite', (s) => s.put(list, 'recent')); } catch (e) { /* storage unavailable */ }
  },

  // MIGRATION (remove after 2026-12-09): a record saved before projects held one 3dm file at its top level.
  // It becomes a project of that one file, keeping its settings. Returns whether anything changed.
  toProjects(list) {
    let changed = false;
    for (const r of list) {
      if (r.files) continue;
      changed = true;
      const f = { id: this.newId(), name: r.name, size: r.size, modified: r.modified, handle: r.handle };
      Object.assign(r, { id: this.newId(), files: [f], active: f.id });
      for (const k of ['size', 'modified', 'handle']) delete r[k];
    }
    return changed;
  },

  // Changes to the list run one at a time, so one cannot overwrite another made just before it.
  serial(fn) {
    const p = (this.chain || Promise.resolve()).then(fn);
    this.chain = p.catch(() => {});
    return p;
  },

  // [project index, file index] of the file the handle is, or null.
  async locate(list, handle) {
    for (let pi = 0; pi < list.length; pi++) {
      for (let fi = 0; fi < list[pi].files.length; fi++) {
        const h = list[pi].files[fi].handle;
        if (h && await h.isSameEntry(handle).catch(() => false)) return [pi, fi];
      }
    }
    return null;
  },

  add(handle, file) {
    if (!this.supported || !handle) return Promise.resolve(null);
    return this.serial(async () => {
      const list = await this.list(), hit = await this.locate(list, handle);
      // The file opened again goes back to its project, which moves to the top, keeping its settings.
      const project = hit ? list[hit[0]] : { id: this.newId(), name: file.name, files: [], custom: null, city: null, epws: null, weather: null, use: null, results: [] };
      const rec = hit ? project.files[hit[1]] : { id: this.newId(), handle };
      Object.assign(rec, { name: file.name, size: file.size, modified: file.lastModified });
      if (!hit) project.files.push(rec);
      Object.assign(project, { name: hit ? project.name : file.name, active: rec.id, opened: Date.now() });
      await this.save([project, ...list.filter((p) => p !== project)]);
      return project.id;
    });
  },

  // A 3dm file added to a project without opening it: listed under the project's attached files.
  attach(projectId, handle, file) {
    if (!this.supported || !handle) return Promise.resolve(null);
    return this.serial(async () => {
      const list = await this.list(), project = list.find((p) => p.id === projectId);
      if (!project) return null;
      for (const f of project.files) if (f.handle && await f.handle.isSameEntry(handle).catch(() => false)) return f.id;
      const rec = { id: this.newId(), name: file.name, size: file.size, modified: file.lastModified, handle };
      project.files.push(rec);
      await this.save(list);
      return rec.id;
    });
  },

  // Takes a 3dm file off a project. The file that is open stays until another is opened.
  detach(projectId, fileId) {
    return this.serial(async () => {
      const list = await this.list(), project = list.find((p) => p.id === projectId);
      if (!project || project.active === fileId) return;
      project.files = project.files.filter((f) => f.id !== fileId);
      await this.save(list);
    });
  },

  activate(projectId, fileId) {
    return this.serial(async () => {
      const list = await this.list(), project = list.find((p) => p.id === projectId);
      if (!project?.files.some((f) => f.id === fileId)) return;
      project.active = fileId;
      await this.save(list);
    });
  },

  async find(list, handle) {
    const hit = await this.locate(list, handle);
    return hit ? hit[0] : -1;
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
