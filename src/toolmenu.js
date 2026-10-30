// Toolbar menus. ToolbarMenu is a toolbar button that opens a popup above it; the popup's body is
// an ordinary element that takes any content (a ChoiceList, checkboxes in a row, a slider, a combo
// button as on the toolbar), laid out as a column, a row or a grid. Clicks inside leave it open:
// it closes on a click elsewhere, Esc or its button, or when another menu opens.
//
//   const menu = new ToolbarMenu(button, { label: 'Camera', layout: 'column', onOpen });
//   menu.body.append(...);
//
// The popup lives outside the toolbar, which would clip it (the toolbar scrolls when narrow).

class ToolbarMenu {
  constructor(button, { label, layout = 'column', onOpen = null } = {}) {
    Object.assign(this, { button, onOpen });
    this.el = document.createElement('div');
    this.el.className = 'chrome tool-menu';
    this.el.hidden = true;
    this.el.setAttribute('role', 'group');
    if (label) this.el.setAttribute('aria-label', label);
    this.body = document.createElement('div');
    this.body.className = `tool-menu-body ${layout}`;
    this.el.append(this.body);
    document.getElementById('app').append(this.el);
    button.setAttribute('aria-haspopup', 'true');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => this.toggle());
    this.onOutside = (e) => { if (!this.el.contains(e.target) && !button.contains(e.target)) this.close(); };
    this.onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); } };
    this.place = () => this.position();
    button.closest('.toolbar')?.addEventListener('scroll', this.place);
  }

  get isOpen() { return !this.el.hidden; }
  toggle() { if (this.isOpen) this.close(); else this.open(); }

  open() {
    if (this.isOpen) return;
    ToolbarMenu.current?.close();
    ToolbarMenu.current = this;
    this.onOpen?.(this);
    this.el.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.position();
    window.addEventListener('pointerdown', this.onOutside, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('resize', this.place);
    (this.body.querySelector('[aria-checked="true"]') || this.body.querySelector('[aria-checked], button, input, select'))?.focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) return;
    if (ToolbarMenu.current === this) ToolbarMenu.current = null;
    if (this.el.contains(document.activeElement)) this.button.focus();
    this.el.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    window.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('resize', this.place);
  }

  // Above the button, kept on screen; a tall body scrolls.
  position() {
    if (!this.isOpen) return;
    const b = this.button.getBoundingClientRect(), gap = 8;
    this.el.style.maxHeight = `${Math.max(80, b.top - 2 * gap)}px`;
    const w = this.el.offsetWidth;
    this.el.style.left = `${Math.max(gap, Math.min(innerWidth - w - gap, b.left + b.width / 2 - w / 2))}px`;
    this.el.style.bottom = `${innerHeight - b.top + gap}px`;
  }
}

// A column of choices with one current, for a menu's body. Arrow keys move between them.
class ChoiceList {
  constructor({ label, onPick }) {
    this.el = document.createElement('div');
    this.el.className = 'choice-list';
    this.el.setAttribute('role', 'menu');
    if (label) this.el.setAttribute('aria-label', label);
    this.el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-id]');
      if (b) onPick(b.dataset.id);
    });
    this.el.addEventListener('keydown', (e) => {
      const all = [...this.el.querySelectorAll('button[data-id]')], at = all.indexOf(document.activeElement);
      const to = { ArrowDown: at + 1, ArrowUp: at - 1 + all.length, Home: 0, End: all.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      all[to % all.length]?.focus();
    });
  }

  // groups: [{ heading (optional), help (optional: { title, run }, a ? button on the heading's row),
  //   items: [{ id, label, hint (optional) }] }]
  setGroups(groups) {
    this.el.replaceChildren();
    groups.forEach((g, n) => {
      if (n) this.el.append(document.createElement('hr'));
      if (g.heading) {
        const h = document.createElement('div');
        h.className = 'heading';
        h.textContent = g.heading;
        if (g.help) {
          const q = document.createElement('button');
          Object.assign(q, { className: 'q', textContent: '?', title: g.help.title });
          q.setAttribute('aria-label', g.help.title);
          q.addEventListener('click', g.help.run);
          h.append(q);
        }
        this.el.append(h);
      }
      for (const it of g.items) {
        const b = document.createElement('button');
        b.dataset.id = it.id;
        b.title = it.label;
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', 'false');
        const l = document.createElement('span');
        l.className = 'label';
        l.textContent = it.label;
        b.append(l);
        if (it.hint) {
          const k = document.createElement('kbd');
          k.textContent = it.hint;
          b.append(k);
        }
        this.el.append(b);
      }
    });
  }

  setActive(id) {
    for (const b of this.el.querySelectorAll('button[data-id]')) b.setAttribute('aria-checked', String(b.dataset.id === id));
  }
}
