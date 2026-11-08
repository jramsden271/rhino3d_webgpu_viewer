// Row selection for the side panels' lists. A click selects one row, Ctrl-click adds or removes a
// row, and Shift-click selects the rows from the last one clicked to this one. Clicks on a row's own
// controls (checkboxes, buttons) are left to them, and a click on empty space clears the selection.
//
//   const rows = new RowSelection();
//   rows.bind(listElement);            // once
//   rows.setRows([{ key, row }, ...]); // whenever the list is rebuilt: rows in order; row.hidden leaves one out of ranges
//   rows.onChange = () => { ... };     // optional: called after the selection changes
//
// From the keyboard: all() selects every shown row, step(±1, extend) moves the selection up or
// down a row (extend, as Shift: grows or shrinks it from the anchor).

class RowSelection {
  // anchor: where a Shift range starts. cursor: the row a range ends at, where a keyboard step starts.
  constructor() { this.rows = []; this.keys = new Set(); this.anchor = null; this.cursor = null; }

  bind(list) {
    list.addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      const el = e.target.closest('.layer-row'), r = el && this.rows.find((x) => x.row === el);
      if (r) this.click(r.key, e); else this.set([]);
    });
  }

  setRows(rows) { this.rows = rows; this.keys = new Set(); this.anchor = this.cursor = null; }

  has(key) { return this.keys.has(key); }

  // The selected keys, in list order.
  list() { return this.rows.filter((r) => this.keys.has(r.key)).map((r) => r.key); }

  set(keys, anchor = keys[0] ?? null, cursor = anchor) {
    this.keys = new Set(keys);
    this.anchor = anchor;
    this.cursor = cursor;
    for (const { key, row } of this.rows) row.classList.toggle('selected', this.keys.has(key));
    this.onChange?.();
  }

  shown() { return this.rows.filter((r) => !r.row.hidden).map((r) => r.key); }

  all() { const shown = this.shown(); this.set(shown, this.anchor ?? shown[0], this.cursor ?? shown.at(-1)); }

  step(d, extend) {
    const shown = this.shown();
    if (!shown.length) return;
    const at = shown.indexOf(this.cursor ?? this.anchor);
    const key = shown[at < 0 ? (d > 0 ? 0 : shown.length - 1) : Math.max(0, Math.min(shown.length - 1, at + d))];
    const from = shown.indexOf(this.anchor);
    if (extend && from >= 0) {
      const to = shown.indexOf(key);
      this.set(shown.slice(Math.min(from, to), Math.max(from, to) + 1), this.anchor, key);
    } else this.set([key]);
    this.rows.find((r) => r.key === key)?.row.scrollIntoView({ block: 'nearest' });
  }

  click(key, e) {
    const shown = this.shown();
    const from = shown.indexOf(this.anchor), to = shown.indexOf(key);
    if (e.shiftKey && from >= 0 && to >= 0) {
      this.set(shown.slice(Math.min(from, to), Math.max(from, to) + 1), this.anchor, key);
    } else if (e.ctrlKey || e.metaKey) {
      const keys = new Set(this.keys);
      if (keys.has(key)) keys.delete(key); else keys.add(key);
      this.set([...keys], key);
    } else this.set([key]);
  }

  // What an action on this row applies to: the selection if the row is in it; otherwise the row
  // alone, which becomes the selection.
  take(key) {
    if (!this.keys.has(key)) this.set([key]);
    return this.list();
  }

  // Rows that have been collapsed or filtered away leave the selection.
  keepShown() {
    const shown = this.rows.filter((r) => !r.row.hidden && this.keys.has(r.key)).map((r) => r.key);
    if (shown.length !== this.keys.size) this.set(shown, shown.includes(this.anchor) ? this.anchor : shown[0] ?? null);
  }
}
