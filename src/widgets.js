// Widgets: the panels in the right-hand column.
//
// A widget with a minimised state (data-min on its panel) gets a minimise/restore button beside
// its close button. Each widget's minimised design is its own, set in index.html and style.css:
// [data-full] parts show only in the normal state, [data-min-only] parts only when minimised, and
// a [data-min-move] part moves into the title bar when minimised, before the element with that id.
// Double-clicking the title bar switches between the two; right-clicking it locks the state.
//
// When the widgets need more height than the column has, the least recently used ones are
// minimised; when room comes back, those are restored, most recently used first. Locked widgets
// and the one just used are left alone. If that still isn't enough, the column scrolls.
//
// The title bar also drags a widget to a new place in the stack. A widget opened for the first
// time goes to the bottom; one opened again goes back to its place. Widgets slide as others
// open, close, change state or move.
//
// The layout is a global preference: the order, and each widget's state and lock.
const Widgets = (() => {
  const NORMAL = 0, MINIMISED = 1; // a widget's state; more may be added
  const KEY = '3dm-viewer-widgets';
  const ANIM_MS = 180, DRAG_PX = 5, EASE = 'ease-out';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const CONTROLS = 'button, input, select, label, a, output, [role="button"]';
  let side, saved, menu;
  const used = new Map(); // widget id → when it was last used, this session
  const lastHeight = new Map(); // widget → its height when last drawn, for sliding the rest up as it closes

  const load = () => {
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    if (!Array.isArray(saved.order)) saved.order = [];
    if (!saved.w || typeof saved.w !== 'object') saved.w = {};
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* storage unavailable */ } };

  const panels = () => [...side.children].filter((p) => p.classList.contains('panel') && !p.classList.contains('ghost'));
  const shown = () => panels().filter((p) => !p.hidden);
  const hasMin = (p) => p.hasAttribute('data-min');
  const blank = () => ({ state: NORMAL, lock: false, auto: false });
  const info = (p) => saved.w[p.id] || (hasMin(p) ? (saved.w[p.id] = blank()) : blank());
  const stateOf = (p) => (hasMin(p) ? info(p).state : NORMAL);
  const touch = (p) => used.set(p.id, performance.now());
  const lastUsed = (p) => used.get(p.id) ?? -1;
  const gap = () => parseFloat(getComputedStyle(side).rowGap) || 0;
  const motion = () => !reduceMotion.matches;

  // --- Drawing a state ---

  // The title bar's symbols, drawn the same on every system and centred in one 12 px box, with
  // one line weight: minimise (as Windows draws it), restore, help and close.
  const LINE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6h8"/></svg>';
  const SQUARE = '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1"/></svg>';
  const HELP = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.9 4.1a2.1 2.1 0 1 1 3 1.9c-.6.3-.9.8-.9 1.4v.3"/><circle class="dot" cx="6" cy="10" r="0.9"/></svg>';
  const CLOSE = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5l7 7M9.5 2.5l-7 7"/></svg>';
  function draw(p) {
    const s = stateOf(p), { lock } = info(p), min = s === MINIMISED;
    p.classList.toggle('min', min);
    for (const el of p._moves || []) {
      const to = min ? document.getElementById(el.dataset.minMove) : el._home;
      if (min && to && to.previousSibling !== el) to.before(el);
      else if (!min && to && to.nextSibling !== el) to.after(el);
      el.classList.toggle('in-head', min);
    }
    const b = p.querySelector('.panel-head .win');
    if (!b) return;
    // Unlocked, the button shows what it does; locked, the state it holds.
    b.innerHTML = lock ? (min ? LINE : SQUARE) : (min ? SQUARE : LINE);
    b.classList.toggle('locked', lock);
    b.setAttribute('aria-pressed', String(lock));
    b.setAttribute('aria-label', `${min ? 'Restore' : 'Minimise'} the ${p.dataset.name} widget`);
    b.title = lock ? `Locked ${min ? 'minimised' : 'open'}: right-click the title bar to unlock`
      : `${min ? 'Restore' : 'Minimise'} (or double-click the title bar)`;
  }

  // --- Fitting the column ---

  const stretches = (p) => parseFloat(getComputedStyle(p).flexGrow) > 0;
  // The height a widget needs: its content, or for a widget that stretches to share the
  // leftover height (Layers and the like), its least height.
  function need(p) {
    const cs = getComputedStyle(p);
    return stretches(p) ? parseFloat(cs.minHeight) || 0 : p.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  }
  function total() {
    const list = shown();
    return list.reduce((sum, p) => sum + need(p), 0) + gap() * Math.max(0, list.length - 1);
  }
  const set = (p, s) => { info(p).state = s; draw(p); };
  const heights = () => new Map(shown().map((p) => [p, p.getBoundingClientRect().height]));
  const stop = () => { for (const p of shown()) for (const a of p.getAnimations()) if (a.id === 'height') a.cancel(); };

  // Fits the widgets to the column. keep: the widget just used (by default the most recent),
  // never minimised here. grow: a widget just opened, which grows from nothing.
  function fit(keep = null, grow = null) {
    const list = shown();
    keep ??= list.reduce((a, p) => (!a || lastUsed(p) > lastUsed(a) ? p : a), null);
    const from = heights();
    if (grow) from.set(grow, 0);
    stop();
    const room = side.clientHeight;
    // Room to spare: restore widgets minimised to make room, most recently used first.
    for (const p of list.filter((q) => hasMin(q) && info(q).auto && !info(q).lock && stateOf(q) === MINIMISED).sort((a, b) => lastUsed(b) - lastUsed(a))) {
      set(p, NORMAL);
      if (total() <= room) info(p).auto = false;
      else set(p, MINIMISED);
    }
    // Not enough room: minimise the least recently used, where that saves height (a list that
    // stretches can be shorter than its minimised design).
    const tried = new Set();
    for (let need = total(); need > room;) {
      const p = list.filter((q) => q !== keep && !tried.has(q) && hasMin(q) && !info(q).lock && stateOf(q) === NORMAL).sort((a, b) => lastUsed(a) - lastUsed(b))[0];
      if (!p) break;
      tried.add(p);
      set(p, MINIMISED);
      const now = total();
      if (now >= need - 0.5) { set(p, NORMAL); continue; }
      info(p).auto = true;
      need = now;
    }
    side.classList.toggle('over', total() > room + 0.5);
    save();
    slideFrom(from, grow);
  }

  // Animates each widget from the height it had to the one it has now. Pinning both its least and
  // most height does it for widgets that stretch as well as those that don't; the widgets
  // below slide with it. A widget growing from nothing also closes the gap above it as it goes.
  let animating = 0, pending = false;
  function slideFrom(from, grow = null) {
    if (!motion()) return;
    for (const [p, a] of from) {
      const b = p.getBoundingClientRect().height;
      if (p.hidden || Math.abs(a - b) < 1) continue;
      const start = { minHeight: a + 'px', maxHeight: a + 'px' }, end = { minHeight: b + 'px', maxHeight: b + 'px' };
      if (p === grow) { Object.assign(start, { marginTop: -gap() + 'px', opacity: 0 }); Object.assign(end, { marginTop: '0px', opacity: 1 }); }
      p.classList.add('anim');
      animating++;
      const anim = p.animate([start, end], { duration: ANIM_MS, easing: EASE, id: 'height' });
      anim.id = 'height';
      const done = () => {
        p.classList.remove('anim');
        if (--animating === 0 && pending) { pending = false; refit(); }
      };
      anim.onfinish = done;
      anim.oncancel = done;
    }
  }

  // A widget closing: main.js has hidden it already, so a copy takes its place, shrinking and
  // fading out, and the rest slide up. The copy comes after the widget, so its ids still find
  // the widget itself.
  function closeUp(p) {
    const h = lastHeight.get(p);
    if (!motion() || !h) return;
    const g = p.cloneNode(true);
    g.hidden = false;
    g.classList.add('ghost');
    g.inert = true;
    g.setAttribute('aria-hidden', 'true');
    const from = p.querySelectorAll('input, select'), to = g.querySelectorAll('input, select');
    from.forEach((el, i) => { to[i].value = el.value; if ('checked' in el) to[i].checked = el.checked; });
    p.after(g);
    const below = shown().some((q) => g.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING);
    const margin = below ? 'marginBottom' : 'marginTop';
    g.animate([{ minHeight: h + 'px', maxHeight: h + 'px', opacity: 1, [margin]: '0px' },
      { minHeight: '0px', maxHeight: '0px', opacity: 0, [margin]: -gap() + 'px' }], { duration: ANIM_MS, easing: EASE })
      .onfinish = () => g.remove();
    setTimeout(() => g.remove(), ANIM_MS * 4); // in case no frame is drawn to finish it (a hidden window)
  }

  // Sizes change (content, the window, the column width): fit again, once the animations end.
  let queued = null;
  function refit() {
    if (animating) { pending = true; return; }
    if (queued) return;
    queued = requestAnimationFrame(() => { queued = null; fit(); });
  }

  // --- Changing state ---

  function toggle(p) {
    if (!hasMin(p) || info(p).lock) return;
    const from = heights();
    stop();
    set(p, stateOf(p) === MINIMISED ? NORMAL : MINIMISED);
    info(p).auto = false;
    touch(p);
    save();
    slideFrom(from);
    refit();
  }
  function setLock(p, lock) {
    info(p).lock = lock;
    info(p).auto = false;
    draw(p);
    save();
  }

  // --- Order ---

  // Puts the widgets in the saved order, moving only the ones out of place.
  function arrange() {
    let prev = null;
    for (const id of saved.order) {
      const p = document.getElementById(id);
      if (!p || p.parentNode !== side) continue;
      const want = prev ? prev.nextElementSibling : side.firstElementChild;
      if (want !== p) side.insertBefore(p, want);
      prev = p;
    }
  }

  // Dragging a title bar moves the widget in the stack; the others slide out of its way.
  // Positions are the layout's (offsetTop), not where the sliding widgets are drawn, so the
  // stack doesn't shuffle back and forth while they move. A widget below moves above once the
  // dragged one's bottom edge passes its middle; one above moves below once the top edge does.
  function bindDrag() {
    let drag = null;
    const at = (e) => e.clientY - side.getBoundingClientRect().top - side.clientTop + side.scrollTop; // in the column's layout
    const mid = (q) => q.offsetTop + q.offsetHeight / 2;
    function move(e) {
      if (e.pointerId !== drag.id) return;
      const { p } = drag;
      if (!drag.on) {
        if (Math.abs(e.clientY - drag.y) < DRAG_PX) return;
        drag.on = true;
        drag.grab = drag.from - p.offsetTop; // where it was pressed
        p.classList.add('dragging');
        side.classList.add('reordering');
      }
      const top = at(e) - drag.grab, bottom = top + p.offsetHeight;
      const list = shown(), others = list.filter((q) => q !== p), i = list.indexOf(p);
      const above = others.filter((q) => (list.indexOf(q) < i ? top > mid(q) : bottom > mid(q))).length;
      if (above !== i) {
        const tops = new Map(others.map((q) => [q, q.getBoundingClientRect().top]));
        side.insertBefore(p, above < others.length ? others[above] : others[others.length - 1].nextElementSibling);
        if (motion()) {
          for (const [q, t] of tops) {
            const d = t - q.getBoundingClientRect().top;
            if (Math.abs(d) > 0.5) q.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: ANIM_MS, easing: EASE });
          }
        }
      }
      p.style.transform = `translateY(${top - p.offsetTop}px)`;
    }
    function end(e) {
      if (!drag || e.pointerId !== drag.id) return;
      const { p, on } = drag;
      drag = null;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      if (!on) return;
      p.classList.remove('dragging');
      side.classList.remove('reordering');
      const off = p.style.transform;
      p.style.transform = '';
      if (motion() && off) p.animate([{ transform: off }, { transform: 'none' }], { duration: ANIM_MS, easing: EASE });
      const known = new Set(saved.order);
      saved.order = panels().map((q) => q.id).filter((id) => known.has(id) || id === p.id);
      touch(p);
      save();
    }
    side.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.panel-head');
      if (drag || !head || e.button !== 0 || e.target.closest(CONTROLS) || side.classList.contains('at-edge')) return;
      drag = { p: head.parentElement, id: e.pointerId, y: e.clientY, from: at(e), on: false };
      // On the whole page: moving the widget in the stack would lose a pointer capture.
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
    });
  }

  // --- Setting up ---

  function init(opts) {
    menu = opts.showMenu;
    side = document.querySelector('.side');
    load();
    for (const p of panels()) {
      if (!p.id) continue;
      const head = p.querySelector('.panel-head');
      for (const b of head.querySelectorAll('.panel-actions .x.q')) b.innerHTML = HELP;
      for (const b of head.querySelectorAll('.panel-actions .x[id$="Close"]')) b.innerHTML = CLOSE;
      p.dataset.name = p.getAttribute('aria-label') || head.firstElementChild.textContent.trim();
      p._moves = [...p.querySelectorAll('[data-min-move]')];
      for (const el of p._moves) { el._home = document.createComment(` ${el.id} `); el.before(el._home); }
      if (hasMin(p)) {
        const b = document.createElement('button');
        b.className = 'x win';
        const close = head.querySelector('[id$="Close"]');
        close.parentNode.insertBefore(b, close);
        b.addEventListener('click', () => toggle(p));
      }
      draw(p);
    }
    arrange();

    // A widget opens or closes wherever main.js shows or hides it. This runs before the page
    // is drawn again, so a widget can start its slide from where it was.
    new MutationObserver((records) => {
      for (const r of records) {
        const p = r.target;
        if (p.parentNode !== side || !p.classList.contains('panel')) continue;
        if (!p.hidden && r.oldValue !== null) {
          if (!saved.order.includes(p.id)) saved.order.push(p.id); // first time: the bottom
          arrange();
          touch(p);
          fit(p, p);
        } else if (p.hidden && r.oldValue === null) {
          closeUp(p);
          fit();
        }
      }
    }).observe(side, { subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });

    // A widget's content changing height, or the column's own size.
    const ro = new ResizeObserver(() => refit());
    ro.observe(side);
    for (const p of panels()) for (const c of p.children) ro.observe(c);
    const sizes = new ResizeObserver((entries) => {
      for (const en of entries) { const h = en.borderBoxSize?.[0]?.blockSize; if (h) lastHeight.set(en.target, h); }
    });
    for (const p of panels()) sizes.observe(p);

    // Using a widget makes it the most recent.
    side.addEventListener('pointerdown', (e) => { const p = e.target.closest('.panel'); if (p) touch(p); }, true);
    side.addEventListener('focusin', (e) => { const p = e.target.closest('.panel'); if (p) touch(p); });

    side.addEventListener('dblclick', (e) => {
      const head = e.target.closest('.panel-head');
      if (!head || e.target.closest(CONTROLS) || side.classList.contains('at-edge')) return;
      window.getSelection()?.removeAllRanges();
      toggle(head.parentElement);
    });
    side.addEventListener('contextmenu', (e) => {
      const p = e.target.closest('.panel-head')?.parentElement;
      if (!p || !hasMin(p)) return;
      e.preventDefault();
      const { lock } = info(p);
      menu(p.dataset.name, [{ label: lock ? 'Unlock widget' : 'Lock widget', run: () => setLock(p, !lock) }], [e.clientX, e.clientY]);
    });
    bindDrag();
  }

  return { init, NORMAL, MINIMISED };
})();
