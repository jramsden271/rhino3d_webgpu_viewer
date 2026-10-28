// A message box / panel in the centre of the window, styled like the other panels, over a blurred
// backdrop. Opens and closes with a short fade and scale.
//
//   const choice = await Dialog.open({ title, body, buttons, width });
//   if (await Dialog.confirm('Revert?', 'Everything goes back…', 'Revert')) …
//
// body: text, an HTML string (html: true) or a DOM node. buttons: [{ label, value, primary,
// danger }] in display order; help: a function for a ? button next to the ×, if any; the result is the clicked button's value, or null when the dialog is
// dismissed (Esc, the × button or a click on the backdrop). dialog.close(value) closes it from code.

class Dialog {
  constructor({ title = '', body = '', html = false, buttons = [{ label: 'OK', value: true, primary: true }], width = 380, onOpen = null, help = null } = {}) {
    this.result = new Promise((resolve) => { this.resolve = resolve; });
    const back = (this.back = document.createElement('div'));
    back.className = 'dlg-backdrop';
    back.innerHTML = `<div class="dlg chrome" role="dialog" aria-modal="true">
      <div class="panel-head"><span class="dlg-title"></span><button class="x" aria-label="Close">×</button></div>
      <div class="dlg-body"></div><div class="dlg-actions"></div></div>`;
    const box = (this.box = back.firstElementChild);
    box.style.width = `min(${width}px, calc(100vw - 32px))`;
    box.querySelector('.dlg-title').textContent = title;
    box.setAttribute('aria-label', title);
    const bodyEl = (this.body = box.querySelector('.dlg-body'));
    if (body instanceof Node) bodyEl.appendChild(body);
    else if (html) bodyEl.innerHTML = body;
    else bodyEl.textContent = body;
    const actions = box.querySelector('.dlg-actions');
    if (!buttons.length) actions.remove();
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '');
      el.textContent = b.label;
      el.addEventListener('click', () => this.close(b.value));
      actions.appendChild(el);
    }
    const x = box.querySelector('.x');
    x.addEventListener('click', () => this.close(null));
    if (help) {
      const acts = document.createElement('span'), q = document.createElement('button');
      acts.className = 'panel-actions';
      Object.assign(q, { className: 'x q', textContent: '?', title: `About ${title}` });
      q.setAttribute('aria-label', `About ${title}`);
      q.addEventListener('click', help);
      x.replaceWith(acts);
      acts.append(q, x);
    }
    back.addEventListener('pointerdown', (e) => { if (e.target === back) this.close(null); });
    this.onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const p = buttons.find((b) => b.primary);
        if (p) { e.preventDefault(); this.close(p.value); }
      } else e.stopPropagation(); // keep the viewer's shortcuts out while the dialog is open
    };
    back.addEventListener('keydown', this.onKey);
    this.lastFocus = document.activeElement;
    document.body.appendChild(back);
    requestAnimationFrame(() => back.classList.add('open'));
    (box.querySelector('input, select') || actions.querySelector('.primary') || box.querySelector('.x')).focus();
    if (onOpen) onOpen(this);
  }

  close(value) {
    if (this.closed) return;
    this.closed = true;
    this.back.classList.remove('open');
    const done = () => this.back.remove();
    this.back.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 300); // in case the transition does not run
    this.lastFocus?.focus?.();
    this.resolve(value);
  }

  static open(options) { return new Dialog(options).result; }

  static confirm(title, text, okLabel = 'OK', { danger = false } = {}) {
    return Dialog.open({ title, body: text, buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: true, danger }] }).then((v) => !!v);
  }
}
