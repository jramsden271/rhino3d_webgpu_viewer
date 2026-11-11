// Zip archives, for projects saved as a zip and opened from one. Entries are written stored (not
// compressed), so a large Rhino file inside one can be read later by slicing the zip, without unpacking
// it or holding the archive in memory. ZIP64 fields are used where a size or an offset passes 4 GB.
// Archives made elsewhere read too, with their compressed (deflated) entries inflated when read.
//
//   await Zip.write([{ name, data }], onProgress)  -> Blob of the archive. data: Blob (a File is one),
//                                                     Uint8Array or string. onProgress(fraction, name).
//   await Zip.entries(blob)                        -> [{ name, method, size, compressedSize, crc, localOffset }]
//   await Zip.read(blob, entry)                    -> Blob of the entry's contents

const Zip = (() => {
  const MAX32 = 0xffffffff;
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crcUpdate = (crc, bytes) => {
    let c = crc ^ MAX32;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ MAX32) >>> 0;
  };
  // The CRC of a Blob, read a piece at a time (a Rhino file can be gigabytes).
  async function crcOf(blob, onBytes) {
    const reader = blob.stream().getReader();
    let crc = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return crc;
      crc = crcUpdate(crc, value);
      onBytes?.(value.length);
    }
  }

  const toBlob = (data) => (data instanceof Blob ? data : new Blob([typeof data === 'string' ? new TextEncoder().encode(data) : data]));
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

  async function write(files, onProgress) {
    const now = new Date(), time = dosTime(now), date = dosDate(now), enc = new TextEncoder();
    const parts = [], central = [];
    const total = files.reduce((n, f) => n + toBlob(f.data).size, 0) || 1;
    let offset = 0, done = 0;
    for (const f of files) {
      const blob = toBlob(f.data), name = enc.encode(f.name), size = blob.size;
      onProgress?.(done / total, f.name);
      const crc = await crcOf(blob, (n) => { done += n; onProgress?.(done / total, f.name); });
      const big = size >= MAX32, farOff = offset >= MAX32;
      // Local header: ZIP64 sizes when the entry is 4 GB or more.
      const local = new DataView(new ArrayBuffer(30 + name.length + (big ? 20 : 0)));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, big ? 45 : 20, true);
      local.setUint16(6, 0x0800, true); // names are UTF-8
      local.setUint16(8, 0, true);      // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, big ? MAX32 : size, true);
      local.setUint32(22, big ? MAX32 : size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, big ? 20 : 0, true);
      new Uint8Array(local.buffer, 30).set(name);
      if (big) {
        const x = 30 + name.length;
        local.setUint16(x, 1, true);
        local.setUint16(x + 2, 16, true);
        local.setBigUint64(x + 4, BigInt(size), true);
        local.setBigUint64(x + 12, BigInt(size), true);
      }
      parts.push(local.buffer, blob);
      central.push({ name, crc, size, offset, big: big || farOff });
      offset += local.byteLength + size;
    }
    // Central directory.
    const cdStart = offset;
    for (const e of central) {
      const extra = e.big ? 28 : 0;
      const h = new DataView(new ArrayBuffer(46 + e.name.length + extra));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 45, true);
      h.setUint16(6, e.big ? 45 : 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, time, true);
      h.setUint16(14, date, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.big ? MAX32 : e.size, true);
      h.setUint32(24, e.big ? MAX32 : e.size, true);
      h.setUint16(28, e.name.length, true);
      h.setUint16(30, extra, true);
      h.setUint32(42, e.big ? MAX32 : e.offset, true);
      new Uint8Array(h.buffer, 46).set(e.name);
      if (e.big) {
        const x = 46 + e.name.length;
        h.setUint16(x, 1, true);
        h.setUint16(x + 2, 24, true);
        h.setBigUint64(x + 4, BigInt(e.size), true);
        h.setBigUint64(x + 12, BigInt(e.size), true);
        h.setBigUint64(x + 20, BigInt(e.offset), true);
      }
      parts.push(h.buffer);
      offset += h.byteLength;
    }
    const cdSize = offset - cdStart, n = central.length;
    if (n >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32) {
      const z = new DataView(new ArrayBuffer(56 + 20));
      z.setUint32(0, 0x06064b50, true);
      z.setBigUint64(4, 44n, true);
      z.setUint16(12, 45, true);
      z.setUint16(14, 45, true);
      z.setBigUint64(24, BigInt(n), true);
      z.setBigUint64(32, BigInt(n), true);
      z.setBigUint64(40, BigInt(cdSize), true);
      z.setBigUint64(48, BigInt(cdStart), true);
      z.setUint32(56, 0x07064b50, true);  // locator
      z.setBigUint64(64, BigInt(offset), true);
      z.setUint32(72, 1, true);
      parts.push(z.buffer);
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, Math.min(n, 0xffff), true);
    end.setUint16(10, Math.min(n, 0xffff), true);
    end.setUint32(12, Math.min(cdSize, MAX32), true);
    end.setUint32(16, Math.min(cdStart, MAX32), true);
    parts.push(end.buffer);
    onProgress?.(1, '');
    return new Blob(parts, { type: 'application/zip' });
  }

  const view = async (blob, from, to) => new DataView(await blob.slice(from, to).arrayBuffer());
  const big = (v, n) => Number(v.getBigUint64(n, true));

  async function entries(blob) {
    // The end of central directory record is in the last 64 KB (after any comment).
    const tailFrom = Math.max(0, blob.size - 65557), tail = await view(blob, tailFrom, blob.size);
    let at = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { at = i; break; }
    if (at < 0) throw new Error('This is not a zip file, or it is damaged.');
    let count = tail.getUint16(at + 10, true), cdSize = tail.getUint32(at + 12, true), cdStart = tail.getUint32(at + 16, true);
    if (count === 0xffff || cdSize === MAX32 || cdStart === MAX32) {
      const loc = at - 20;
      if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
        const z = await view(blob, big(tail, loc + 8), big(tail, loc + 8) + 56);
        if (z.getUint32(0, true) !== 0x06064b50) throw new Error('The zip file is damaged (ZIP64 record).');
        count = big(z, 32); cdSize = big(z, 40); cdStart = big(z, 48);
      }
    }
    const cd = await view(blob, cdStart, cdStart + cdSize), dec = new TextDecoder(), out = [];
    for (let p = 0, k = 0; k < count && p + 46 <= cd.byteLength; k++) {
      if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('The zip file is damaged (central directory).');
      const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
      const e = { name: dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen)), method: cd.getUint16(p + 10, true),
        crc: cd.getUint32(p + 16, true), compressedSize: cd.getUint32(p + 20, true), size: cd.getUint32(p + 24, true), localOffset: cd.getUint32(p + 42, true) };
      // ZIP64 extra field: the 64-bit values, in order, for each one set to 0xFFFFFFFF above.
      for (let x = p + 46 + nameLen, endX = x + extraLen; x + 4 <= endX;) {
        const id = cd.getUint16(x, true), len = cd.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (e.size === MAX32) { e.size = big(cd, q); q += 8; }
          if (e.compressedSize === MAX32) { e.compressedSize = big(cd, q); q += 8; }
          if (e.localOffset === MAX32) { e.localOffset = big(cd, q); q += 8; }
        }
        x += 4 + len;
      }
      if (!e.name.endsWith('/')) out.push(e); // folders are not entries of their own here
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  }

  async function read(blob, entry) {
    const h = await view(blob, entry.localOffset, entry.localOffset + 30);
    if (h.getUint32(0, true) !== 0x04034b50) throw new Error(`The zip file is damaged (${entry.name}).`);
    const start = entry.localOffset + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    const data = blob.slice(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    throw new Error(`${entry.name} is compressed in a way this viewer cannot read.`);
  }

  return { write, entries, read, crc: (bytes) => crcUpdate(0, bytes) };
})();
