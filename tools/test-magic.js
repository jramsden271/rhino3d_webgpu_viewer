// Checks where src/magicblocks.js places a magic block:  node tools/test-magic.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { magicSource, magicPlacement, magicFlat, magicMeshes, MAGIC_BY_ID, FLAT_M } = require('../src/magicblocks.js');

const near = (a, b, what) => assert(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);
const tree = { height: 9, width: 6, unit: 1, ground: true, randomRotation: false }; // as magicMeshes leaves it, in metres
const scaleOf = (p) => Math.hypot(p[8], p[9], p[10]);

// A canopy from 3 to 7 above its base point, 2 across, off centre, placed at (100, 200, 10) at twice the size.
const box = [0, 0, 3, 2, 2, 7], xf = [2, 0, 0, 100, 0, 2, 0, 200, 0, 0, 2, 10, 0, 0, 0, 1];
const source = magicSource(box, xf);
near(source.lo, 16, 'box bottom');
near(source.hi, 24, 'box top');
near(source.x, 102, 'centre x');
near(source.y, 202, 'centre y');
near(source.top, 16.8, 'look down from a tenth of the way up');

// The ground is below the box: the box reaches down to it.
let p = magicPlacement(tree, source, xf, 10, 0);
near(p[11], 10, 'stands on the ground');
near(scaleOf(p), 14 / 9, 'height from the ground to the top');
near(p[3], 102, 'anchored at the centre');

// No ground: the box as it is.
p = magicPlacement(tree, source, xf, null, 0);
near(p[11], 16, 'stands at the bottom of the box');
near(scaleOf(p), 8 / 9, 'height of the box');

// The block's bottom is already below the ground found: not moved up.
p = magicPlacement(tree, source, xf, 16.5, 0);
near(p[11], 16, 'stays at the bottom of the box');

// An entry that doesn't ask for ground ignores it.
p = magicPlacement({ ...tree, ground: false }, source, xf, 10, 0);
near(p[11], 16, 'no ground rule');

// Flat sources (trees drawn in plan): sized by their width, standing at the middle of their bottom,
// whatever the ground below.
const at = [1, 0, 0, 100, 0, 1, 0, 200, 0, 0, 1, 10, 0, 0, 0, 1];
const flat = magicSource([-4, -4, 0, 4, 4, 0], at);
near(flat.width, 8, 'width of an 8 m circle');
assert(magicFlat(tree, flat), 'a block with no height is flat');
for (const g of [null, 5, 12]) {
  p = magicPlacement(tree, flat, at, g, 0);
  near(scaleOf(p), 8 / 6, `foliage as wide as the block (ground ${g})`);
  near(p[11], 10, `stands at the bottom of the block (ground ${g})`);
  near(p[3], 100, 'anchored at the centre x'); near(p[7], 200, 'anchored at the centre y');
}
near(magicSource([0, 0, 0, 6, 10, 0], at).width, 8, 'width: the average of the two sides');
near(magicSource([-4, -4, 0, 4, 4, 0], xf).width, 16, 'width: as placed (the instance is at twice the size)');
const c45 = Math.SQRT1_2;
near(magicSource([-4, -4, 0, 4, 4, 0], [c45, -c45, 0, 0, c45, c45, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).width, 8, 'width: a square symbol turned 45° is no wider');
near(magicSource([-4, -4, 0, 4, 4, 0], [3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]).width, 16, 'width: stretched along x only, the average of 24 and 8');
// The threshold, in the model's units.
assert(magicFlat(tree, magicSource([0, 0, 0, 2, 2, FLAT_M * 0.9], at)), 'just under 0.1 m tall is flat');
assert(!magicFlat(tree, magicSource([0, 0, 0, 2, 2, FLAT_M * 1.1], at)), 'just over 0.1 m tall is not');
const mm = { ...tree, unit: 1000, width: 6000, height: 9000 };
assert(magicFlat(mm, magicSource([0, 0, 0, 2000, 2000, 90], at)), 'millimetres: 90 mm tall is flat');
assert(!magicFlat(mm, magicSource([0, 0, 0, 2000, 2000, 110], at)), 'millimetres: 110 mm tall is not');
// A flat source with no width either keeps the entry's real size.
p = magicPlacement(tree, magicSource([0, 0, 0, 0, 0, 0], at), at, null, 0);
near(scaleOf(p), 1, 'real size');

// The library's trees know their foliage width.
for (const id of ['deciduous', 'palm']) {
  const b = MAGIC_BY_ID[id];
  magicMeshes(b, 1);
  assert(b.width > 4 && b.width < 14, `${id}: foliage width ${b.width.toFixed(2)} m`);
  console.log(`  ${b.name}: ${b.height.toFixed(2)} m tall, foliage ${b.width.toFixed(2)} m across`);
}

// Rotation: follows the instance, plus a turn from the seed only if the entry asks for it.
const turned = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const flatBox = magicSource(box, turned);
p = magicPlacement(tree, flatBox, turned, null, 0.5);
near(Math.atan2(p[4], p[0]), Math.PI / 2, 'turned as the instance');
p = magicPlacement({ ...tree, randomRotation: true }, flatBox, turned, null, 0.5);
near(Math.atan2(p[4], p[0]), Math.PI, 'and by the seed');

console.log('All magic block placement checks passed');
