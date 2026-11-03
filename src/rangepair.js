// A slider with two grips, for a range. Either grip can pass the other, or sit on it for a range
// of one value: the range runs from the lower grip to the higher.
//
//   const r = new RangePair(el, { min: 0, max: 24, step: 0.25, label: 'Time', onInput: ([lo, hi]) => ... });
//   r.value = [10, 12];

class RangePair {
  constructor(el, { min, max, step, label, onInput }) {
    Object.assign(this, { el, min, max });
    el.classList.add('range-pair');
    this.fill = document.createElement('span');
    this.fill.className = 'range-fill';
    this.inputs = ['from', 'to'].map((end) => {
      const r = document.createElement('input');
      Object.assign(r, { type: 'range', min, max, step });
      r.setAttribute('aria-label', `${label}, ${end}`);
      r.addEventListener('input', () => { this.paint(); onInput(this.value); });
      return r;
    });
    el.append(this.fill, ...this.inputs);
  }

  get value() {
    const [a, b] = this.inputs.map((r) => +r.value);
    return [Math.min(a, b), Math.max(a, b)];
  }

  set value([a, b]) {
    this.inputs[0].value = a;
    this.inputs[1].value = b;
    this.paint();
  }

  // The bar between the grips (each grip's centre moves over the width less one grip).
  paint() {
    const [a, b] = this.value, f = (v) => (v - this.min) / (this.max - this.min);
    this.fill.style.left = `calc(7px + ${f(a)} * (100% - 14px))`;
    this.fill.style.width = `calc(${f(b) - f(a)} * (100% - 14px))`;
  }
}
