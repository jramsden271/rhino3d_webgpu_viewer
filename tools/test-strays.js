// Checks findStrays (src/extract.js) on made-up objects: a site with a few objects far off.
//   node tools/test-strays.js

const { findStrays, STRAY_RADIUS_M } = require('../src/extract.js');

let failures = 0;
const check = (ok, msg) => { if (!ok) { failures++; console.log(`  FAIL ${msg}`); } };

const R = STRAY_RADIUS_M; // metres, the scene's units here
const box = (x, y, z, w = 10, h = 10) => ({ min: [x - w / 2, y - w / 2, z], max: [x + w / 2, y + w / 2, z + h] });
const site = (n, at = [0, 0, 0]) => Array.from({ length: n }, (_, i) => box(at[0] + (i % 50) * 40, at[1] + Math.floor(i / 50) * 40, at[2]));

// A tidy site: nothing is a stray, however many objects.
check(findStrays({ items: site(500) }, R).size === 0, 'a site 2 km across has no strays');

// The QD2&3 case: a site in site coordinates, two lines 100 km up over it and a point at 0,0.
{
  const at = [630000, 2716000, 0], items = site(1000, at);
  items.push(box(at[0], at[1], 99985, 50, 0), box(at[0] + 10, at[1], 99985, 50, 0), box(0, 0, 0, 1, 0));
  const s = findStrays({ items }, R);
  check(s.size === 3 && [1000, 1001, 1002].every((i) => s.has(i)), `the two high lines and the point at 0,0 are strays (found ${[...s]})`);
}

// A big object centred on the site (terrain, a road layout 30 km across) stays; one reaching past R doesn't.
{
  const items = site(1000);
  items.push(box(1000, 1000, 0, 30000, 50), box(1000, 1000, 0, 120000, 0), box(200000, 0, 0));
  const s = findStrays({ items }, R);
  check(!s.has(1000), '30 km terrain round the site stays');
  check(s.has(1001), 'a 120 km object is a stray, though centred on the site');
  check(s.has(1002), 'an object 200 km away is a stray');
}

// Objects with nothing to show (an empty box) are never strays, and don't count towards the middle.
{
  const items = site(100);
  items.push({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }, {}, box(1e9, 1e9, 0));
  const s = findStrays({ items }, R);
  check(!s.has(100) && !s.has(101) && s.has(102), 'empty boxes are left alone; an object 1,000,000 km off is a stray');
}

// The middle is the median, so strays can't drag it: many strays on one side still leave the site.
{
  const items = site(1000);
  for (let i = 0; i < 400; i++) items.push(box(900000 + i, 0, 0));
  const s = findStrays({ items }, R);
  check(s.size === 400 && !s.has(0), `400 strays out of 1,400 objects are all found, and the site stays (found ${s.size})`);
}

// Scene units: radius is given in them (a model in millimetres).
{
  const items = site(500).map((b) => ({ min: b.min.map((v) => v * 1000), max: b.max.map((v) => v * 1000) }));
  items.push(box(0, 0, 100000 * 1000));
  const s = findStrays({ items }, R * 1000);
  check(s.size === 1 && s.has(500), 'millimetres: an object 100 km up is a stray');
}

console.log(failures ? `${failures} failed` : 'All stray checks passed');
process.exit(failures ? 1 : 0);
