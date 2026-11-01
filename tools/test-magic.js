// Checks where src/magicblocks.js places a magic block:  node tools/test-magic.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'magicblocks.js'), 'utf8');
const { magicSource, magicPlacement } = new Function(`${src}\nreturn { magicSource, magicPlacement };`)();

const near = (a, b, what) => assert(Math.abs(a - b) < 1e-6, `${what}: ${a} is not ${b}`);
const tree = { height: 9, ground: true, randomRotation: false };
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

// A flat source with nothing below keeps the entry's real size.
const flat = magicSource([0, 0, 0, 2, 2, 0], xf);
p = magicPlacement(tree, flat, xf, null, 0);
near(scaleOf(p), 1, 'real size');

// Rotation: follows the instance, plus a turn from the seed only if the entry asks for it.
const turned = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const flatBox = magicSource(box, turned);
p = magicPlacement(tree, flatBox, turned, null, 0.5);
near(Math.atan2(p[4], p[0]), Math.PI / 2, 'turned as the instance');
p = magicPlacement({ ...tree, randomRotation: true }, flatBox, turned, null, 0.5);
near(Math.atan2(p[4], p[0]), Math.PI, 'and by the seed');

console.log('All magic block placement checks passed');
