// Checks the sun path diagram in src/sun.js:  node tools/test-sun.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'sun.js'), 'utf8');
const { sunPathDiagram, dayOfYear } = new Function(`${src}\nreturn { sunPathDiagram, dayOfYear };`)();

const place = (lat, lon, utcOffset, north = 90, doy = dayOfYear(2017, 6, 21)) => sunPathDiagram({ lat, lon, utcOffset, north, year: 2017, doy, dayName: 'Today' });
const alt = (p) => Math.asin(p[2]) * 180 / Math.PI;
const top = (d, kind) => Math.max(...d.segments.filter((s) => s.kind === kind).flatMap((s) => [alt(s.a), alt(s.b)]));
const texts = (d, kind) => d.labels.filter((l) => l.kind === kind).map((l) => l.text);

const london = place(51.5, -0.13, 0);
for (const s of london.segments) {
  assert.ok(s.a[2] >= 0 && s.b[2] >= 0, 'nothing below the horizon');
  for (const p of [s.a, s.b]) assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-6, 'unit directions');
}
assert.ok(Math.abs(top(london, 'month') - 62) < 1, 'the highest arc is the June solstice');
assert.ok(Math.abs(top(london, 'day') - 62) < 1, 'the day picked out');
const winter = place(51.5, -0.13, 0, 90, dayOfYear(2017, 12, 21));
assert.ok(Math.abs(top(winter, 'day') - 15) < 1, 'and in December');
assert.deepStrictEqual(texts(london, 'day'), ['Today']);
assert.strictEqual(texts(london, 'month').filter((t) => t === 'Jun').length, 2, 'named at both ends');
assert.ok(texts(london, 'hour').includes('12:00'));
assert.ok(!texts(london, 'hour').includes('23:00') && !texts(london, 'hour').includes('01:00'), 'no hours the sun is never up');

// North: the compass points follow it.
const label = (d, text) => d.labels.find((l) => l.text === text).dir;
assert.ok(Math.abs(label(london, 'N')[1] - 1) < 1e-9, 'north up the model');
assert.ok(Math.abs(label(london, 'E')[0] - 1) < 1e-9, 'east to its right');
assert.ok(Math.abs(label(place(51.5, -0.13, 0, 0), 'N')[0] - 1) < 1e-9, 'north along +X');

// The day's highest point is to the south in the north, and to the north in the south.
const noon = (d) => d.labels.find((l) => l.kind === 'day').dir;
assert.ok(noon(london)[1] < 0 && Math.abs(noon(london)[0]) < 0.1);
assert.ok(noon(place(-33.9, 151.2, 10, 90, dayOfYear(2017, 12, 21)))[1] > 0);

// Far inside the Arctic Circle: the midnight sun has no ends to name, and a winter day has no sun.
const svalbard = place(78.2, 15.6, 1);
assert.strictEqual(texts(svalbard, 'month').filter((t) => t === 'Jun').length, 1, 'named at its lowest');
assert.ok(texts(svalbard, 'hour').includes('00:00'));
const dark = place(78.2, 15.6, 1, 90, dayOfYear(2017, 12, 21));
assert.deepStrictEqual(texts(dark, 'day'), []);
assert.strictEqual(dark.segments.filter((s) => s.kind === 'day').length, 0);
assert.ok(!texts(dark, 'month').includes('Dec'));

console.log('ok');
