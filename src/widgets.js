// Widgets: the panels in the right-hand column.
//
// A widget with a minimised state (data-min on its panel) gets a minimise/restore button beside
// its close button. Each widget's minimised design is its own, set in index.html and style.css:
// [data-full] parts show only in the normal state, [data-min-only] parts only when minimised.
// Double-clicking the title bar switches between the two; right-clicking it locks the state.
//
// When the widgets need more height than the column has, the least recently used ones are
// minimised; when room comes back, those are restored, most recently used first. Locked widgets
// and the one just used are left alone. If that still isn't enough, the column scrolls.
//
// The title bar also drags a widget to a new place in the stack. A widget opened for the first
// time goes to the bottom; one opened again goes back to its place.
//
// The layout is a global preference: the order, and each widget's state and lock.
const Widgets = (() => {
  const NORMAL = 0, MINIMISED = 1; // a widget's state; more may be added
  const KEY = '3dm-viewer-widgets';
  const ANIM_MS = 180, DRAG_PX = 5;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const CONTROLS = 'button, input, select, label, a, output, [role="button"]';
  let side, saved, menu;
  const used = new Map(); // widget id → when it was last used, this session

  const load = () => {
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { saved = {}; }
    if (!Array.isArray(saved.order)) saved.order = [];
    if (!saved.w || typeof saved.w !== 'object') saved.w = {};
  };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) { /* storage unavailable */ } };

  const panels = () => [...side.children].filter((p) => p.classList.contains('panel'));
  const shown = () => panels().filter((p) => !p.hidden);
  const hasMin = (p) => p.hasAttribute('data-min');
  const info = (p) => saved.w[p.id] || (hasMin(p) ? (saved.w[p.id] = { state: NORMAL, lock: false, auto: false }) : { state: NORMAL, lock: false, auto: false });
  const stateOf = (p) => (hasMin(p) ? info(p).state : NORMAL);
  const touch = (p) => used.set(p.id, performance.now());
  const lastUsed = (p) => used.get(p.id) ?? -1;

  // --- Drawing a state ---

  const ICON = {
    [NORMAL]: '<svg viewBox="0 0 12 12"><path d="M2 9.5h8"/></svg>', // shown while normal: minimise
    [MINIMISED]: '<svg viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>', // restore
  };
  function draw(p) {
    const s = stateOf(p), { lock } = info(p);
    p.classList.toggle('min', s === MINIMISED);
    const b = p.querySelector('.panel-head .win');
    if (!b) return;
    b.innerHTML = ICON[s];
    b.classList.toggle('locked', lock);
    b.setAttribute('aria-pressed', String(lock));
    const name = p.dataset.name;
    b.setAttribute('aria-label', `${s === MINIMISED ? 'Restore' : 'Minimise'} the ${name} widget`);
    b.title = lock ? `Locked ${s === MINIMISED ? 'minimised' : 'open'}: right-click the title bar to unlock`
      : `${s === MINIMISED ? 'Restore' : 'Minimise'} (or double-click the title bar)`;
  }

  // --- Fitting the column ---

  // The height a widget needs: its content, or for a widget that stretches to share the
  // leftover height (Layers and the like), its least height.
  function need(p) {
    const cs = getComputedStyle(p);
    return parseFloat(cs.flexGrow) > 0 ? parseFloat(cs.minHeight) || 0 : p.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  }
  function total() {
    const list = shown();
    const gap = parseFloat(getComputedStyle(side).rowGap) || 0;
    return list.reduce((sum, p) => sum + need(p), 0) + gap * Math.max(0, list.length - 1);
  }
  const room = () => side.clientHeight;
  const set = (p, s) => { info(p).state = s; draw(p); };

  // Fits the widgets to the column. keep: the widget just used, never minimised here.
  // Animates every widget whose height changes, from where it is now.
  let animating = 0, pending = false;
  function fit(keep = null) {
    const list = shown();
    keep ??= list.reduce((a, p) => (!a || lastUsed(p) > lastUsed(a) ? p : a), null); // the most recently used
    const from = new Map(list.map((p) => [p, p.getBoundingClientRect().height]));
    for (const p of list) for (const a of p.getAnimations()) a.cancel();
    const space = room();
    // Room to spare: restore widgets minimised to make room, most recently used first.
    for (const p of list.filter((q) => hasMin(q) && info(q).auto && !info(q).lock && stateOf(q) === MINIMISED).sort((a, b) => lastUsed(b) - lastUsed(a))) {
      set(p, NORMAL);
      if (total() <= space) info(p).auto = false;
      else set(p, MINIMISED);
    }
    // Not enough room: minimise the least recently used.
    while (total() > space) {
      const p = list.filter((q) => q !== keep && hasMin(q) && !info(q).lock && stateOf(q) === NORMAL).sort((a, b) => lastUsed(a) - lastUsed(b))[0];
      if (!p) break;
      set(p, MINIMISED);
      info(p).auto = true;
    }
    side.classList.toggle('over', total() > space + 0.5);
    save();
    animateFrom(from);
  }

  function animateFrom(from) {
    if (reduceMotion.matches) return;
    for (const [p, a] of from) {
      const b = p.getBoundingClientRect().height;
      if (p.hidden || Math.abs(a - b) < 1) continue;
      p.classList.add('anim');
      animating++;
      const anim = p.animate([{ height: a + 'px' }, { height: b + 'px' }], { duration: ANIM_MS, easing: 'ease-out' });
      const done = () => {
        p.classList.remove('anim');
        if (--animating === 0 && pending) { pending = false; requestAnimationFrame(() => fit()); }
      };
      anim.onfinish = done;
      anim.oncancel = done;
    }
  }

  // Sizes change (content, the window, the column width): fit again, once the animations end.
  let queued = null;
  function refit(keep = null) {
    if (animating) { pending = true; return; }
    if (queued) return;
    queued = requestAnimationFrame(() => { queued = null; fit(keep); });
  }

  // --- Changing state ---

  function toggle(p) {
    if (!hasMin(p) || info(p).lock) return;
    const from = new Map(shown().map((q) => [q, q.getBoundingClientRect().height]));
    for (const q of shown()) for (const a of q.getAnimations()) a.cancel();
    set(p, stateOf(p) === MINIMISED ? NORMAL : MINIMISED);
    info(p).auto = false;
    touch(p);
    save();
    animateFrom(from);
    refit(p);
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
  function opened(p) {
    if (!saved.order.includes(p.id)) saved.order.push(p.id); // first time: the bottom
    arrange();
    touch(p);
    refit(p);
  }

  // Dragging a title bar moves the widget in the stack; the others slide out of its way.
  function bindDrag() {
    let drag = null;
    side.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.panel-head');
      if (!head || e.button !== 0 || e.target.closest(CONTROLS) || side.classList.contains('at-edge')) return;
      drag = { p: head.parentElement, id: e.pointerId, y: e.clientY, on: false };
    });
    side.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { p } = drag;
      if (!drag.on) {
        if (Math.abs(e.clientY - drag.y) < DRAG_PX) return;
        drag.on = true;
        drag.grab = e.clientY - p.getBoundingClientRect().top;
        p.setPointerCapture(e.pointerId);
        p.classList.add('dragging');
        side.classList.add('reordering');
      }
      // Where the pointer is among the other widgets' middles.
      const others = shown().filter((q) => q !== p);
      let at = others.findIndex((q) => { const r = q.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (at < 0) at = others.length;
      if (others.length && at !== shown().indexOf(p)) {
        const tops = new Map(others.map((q) => [q, q.getBoundingClientRect().top]));
        p.style.transform = '';
        side.insertBefore(p, at < others.length ? others[at] : others[others.length - 1].nextElementSibling);
        if (!reduceMotion.matches) {
          for (const [q, t] of tops) {
            const d = t - q.getBoundingClientRect().top;
            if (Math.abs(d) > 0.5) q.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: ANIM_MS, easing: 'ease-out' });
          }
        }
      }
      p.style.transform = '';
      p.style.transform = `translateY(${e.clientY - drag.grab - p.getBoundingClientRect().top}px)`;
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { p, on } = drag;
      drag = null;
      if (!on) return;
      p.classList.remove('dragging');
      side.classList.remove('reordering');
      const off = p.style.transform;
      p.style.transform = '';
      if (!reduceMotion.matches && off) p.animate([{ transform: off }, { transform: 'none' }], { duration: ANIM_MS, easing: 'ease-out' });
      const known = new Set(saved.order);
      saved.order = panels().map((q) => q.id).filter((id) => known.has(id) || id === p.id);
      touch(p);
      save();
    };
    side.addEventListener('pointerup', end);
    side.addEventListener('pointercancel', end);
  }

  // --- Setting up ---

  function init(opts) {
    menu = opts.showMenu;
    side = document.querySelector('.side');
    load();
    for (const p of panels()) {
      if (!p.id) continue;
      const head = p.querySelector('.panel-head');
      p.dataset.name = p.getAttribute('aria-label') || head.firstElementChild.textContent.trim();
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

    // A widget opens or closes wherever main.js shows or hides it.
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target.parentNode !== side) continue;
        if (!r.target.hidden && r.oldValue !== null) opened(r.target);
        else if (r.target.hidden && r.oldValue === null) refit();
      }
    }).observe(side, { subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true });

    // A widget's content changing height, or the column's own size.
    const ro = new ResizeObserver((entries) => {
      const p = entries.map((en) => en.target.closest?.('.panel')).find((q) => q && !q.hidden && parseFloat(getComputedStyle(q).flexGrow) === 0);
      refit(p || null);
    });
    ro.observe(side);
    for (const p of panels()) for (const c of p.children) ro.observe(c);

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
      const head = e.target.closest('.panel-head');
      const p = head?.parentElement;
      if (!p || !hasMin(p)) return;
      e.preventDefault();
      const { lock } = info(p);
      menu(p.dataset.name, [{ label: lock ? 'Unlock widget' : 'Lock widget', run: () => setLock(p, !lock) }], [e.clientX, e.clientY]);
    });
    bindDrag();
  }

  return { init, NORMAL, MINIMISED };
})();
