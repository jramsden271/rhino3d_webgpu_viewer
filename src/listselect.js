// Row selection for the side panels' lists. A click selects one row, Ctrl-click adds or removes a
// row, and Shift-click selects the rows from the last one clicked to this one. Clicks on a row's own
// controls (checkboxes, buttons) are left to them, and a click on empty space clears the selection.
//
//   const rows = new RowSelection();
//   rows.bind(listElement);            // once
//   rows.setRows([{ key, row }, ...]); // whenever the list is rebuilt: rows in order; row.hidden leaves one out of ranges

class RowSelection {
  constructor() { this.rows = []; this.keys = new Set(); this.anchor = null; }

  bind(list) {
    list.addEventListener('click', (e) => {
      if (e.target.closest('input, button')) return;
      const el = e.target.closest('.layer-row'), r = el && this.rows.find((x) => x.row === el);
      if (r) this.click(r.key, e); else this.set([]);
    });
  }

  setRows(rows) { this.rows = rows; this.keys = new Set(); this.anchor = null; }

  has(key) { return this.keys.has(key); }

  // The selected keys, in list order.
  list() { return this.rows.filter((r) => this.keys.has(r.key)).map((r) => r.key); }

  set(keys, anchor = keys[0] ?? null) {
    this.keys = new Set(keys);
    this.anchor = anchor;
    for (const { key, row } of this.rows) row.classList.toggle('selected', this.keys.has(key));
  }

  click(key, e) {
    const shown = this.rows.filter((r) => !r.row.hidden).map((r) => r.key);
    const from = shown.indexOf(this.anchor), to = shown.indexOf(key);
    if (e.shiftKey && from >= 0 && to >= 0) {
      this.set(shown.slice(Math.min(from, to), Math.max(from, to) + 1), this.anchor);
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
