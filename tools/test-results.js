// Checks the results file parsers in src/results.js:  node tools/test-results.js [streamlines.csv]
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'results.js'), 'utf8');
const { parseResultsFile, parseCfdStreamlines, velocityColour, streamlineVertices } = new Function(`${src}\nreturn { parseResultsFile, parseCfdStreamlines, velocityColour, streamlineVertices };`)();

const bytes = (s) => new TextEncoder().encode(s);
const data = (rows) => `\n[Data]\nNode Number, X [ m ], Y [ m ], Z [ m ], Velocity [ m s^-1 ]\n${rows.map((r) => r.join(', ')).join('\n')}\n`;
const lines = (pairs) => `\n[Lines]\n${pairs.map((p) => p.join(', ')).join('\n')}\n`;
const nodes = [[0, 0, 0, 0, 1], [1, 1, 0, 0, 2], [2, 2, 0, 0, 3], [3, 5, 5, 5, 4], [4, 6, 5, 5, 5], [5, 7, 7, 7, 6]];

// Out of order, and two polylines under one name.
let file = `\n[Name]\nStream A\n${data(nodes)}${lines([[3, 4], [1, 2], [0, 1]])}`;
let { parser, data: d } = parseResultsFile(bytes(file), 'a.csv');
assert.strictEqual(parser.id, 'cfdStreamlines');
assert.strictEqual(d.streamlines.length, 1);
let s = d.streamlines[0];
assert.strictEqual(s.name, 'Stream A');
assert.strictEqual(s.segments, 3);
assert.strictEqual(s.polylines.length, 2);
assert.deepStrictEqual([...s.polylines[1].points], [0, 0, 0, 1, 0, 0, 2, 0, 0], 'joined in order');
assert.deepStrictEqual([...s.polylines[1].velocity], [1, 2, 3], 'velocity stays with its node');
assert.strictEqual(parser.describe(d), '1 streamline · 2 polylines · 3 segments');

// Two named sections, whose node numbers are their own. Windows line endings.
file = `[Name]\nOne\n${data(nodes)}${lines([[0, 1]])}\n[Name]\nTwo\n${data(nodes.slice(0, 2))}${lines([[1, 0]])}`.replace(/\n/g, '\r\n');
d = parseCfdStreamlines(file);
assert.deepStrictEqual(d.streamlines.map((l) => l.name), ['One', 'Two']);
assert.deepStrictEqual([...d.streamlines[1].polylines[0].velocity], [2, 1]);

// A closed loop and a fork lose nothing.
d = parseCfdStreamlines(`[Name]\nLoop\n${data(nodes)}${lines([[0, 1], [1, 2], [2, 0]])}`);
assert.strictEqual(d.streamlines[0].polylines[0].velocity.length, 4);
d = parseCfdStreamlines(`[Name]\nFork\n${data(nodes)}${lines([[0, 1], [1, 2], [1, 3]])}`);
assert.strictEqual(d.streamlines[0].polylines.reduce((n, p) => n + p.velocity.length - 1, 0), 3);

// Lengths in other units come out in metres.
d = parseCfdStreamlines(`[Name]\nMm\n${data(nodes).replace(/\[ m \]/g, '[ mm ]')}${lines([[0, 1]])}`);
assert.strictEqual(d.streamlines[0].polylines[0].points[3], 0.001);

// Not this kind of file: nothing recognises it.
const faces = `[Name]\nGround\n${data(nodes)}\n[Faces]\n0, 1, 2\n`;
assert.strictEqual(parseResultsFile(bytes(faces), 'ground.csv'), null, 'surface results');
assert.strictEqual(parseResultsFile(bytes('a,b\n1,2\n'), 'table.csv'), null, 'any other csv');
assert.strictEqual(parseResultsFile(bytes(file), 'a.txt'), null, 'another extension');
assert.strictEqual(parseCfdStreamlines(`[Name]\nNo speed\n[Data]\nNode Number, X [ m ], Y [ m ], Z [ m ]\n0, 0, 0, 0\n[Lines]\n0, 0\n`), null, 'no velocity');

// This kind of file, but damaged: says why.
assert.throws(() => parseCfdStreamlines(`[Name]\nBad\n${data(nodes)}${lines([[0, 99]])}`), /isn't in its \[Data\]/);

// Colour scale.
assert.deepStrictEqual(velocityColour(0), [30, 90, 255], 'blue at 0');
assert.deepStrictEqual(velocityColour(10 / 3), [30, 190, 70], 'green');
assert.deepStrictEqual(velocityColour(20 / 3), [255, 150, 0], 'orange');
assert.deepStrictEqual(velocityColour(10), [230, 25, 25], 'red at 10');
assert.deepStrictEqual(velocityColour(25), [230, 25, 25], 'stays red above');

// Vertices: model units, relative to the origin, each segment the colour of its start node.
d = parseCfdStreamlines(`[Name]\nA\n${data(nodes)}${lines([[0, 1], [1, 2]])}\n[Name]\nB\n${data(nodes)}${lines([[3, 4]])}`);
const v = streamlineVertices(d.streamlines, 0.001, [100, 0, 0]);
assert.deepStrictEqual(v.ranges, [[{ first: 0, count: 4 }], [{ first: 4, count: 2 }]]);
d = parseCfdStreamlines(`[Name]\nTwo lines\n${data(nodes)}${lines([[0, 1], [3, 4], [4, 5]])}`);
assert.deepStrictEqual(streamlineVertices(d.streamlines, 1, [0, 0, 0]).ranges, [[{ first: 0, count: 2 }, { first: 2, count: 4 }]], 'a range for each polyline');
assert.deepStrictEqual([...v.pos.slice(0, 6)], [-100, 0, 0, 900, 0, 0]);
assert.deepStrictEqual([...v.col.slice(0, 4)], [...velocityColour(1), 255]);
assert.deepStrictEqual([...v.col.slice(4, 8)], [...velocityColour(1), 255], 'start node colours both ends');
assert.deepStrictEqual([...v.col.slice(8, 12)], [...velocityColour(2), 255]);

// A real file, when given one.
if (process.argv[2]) {
  const t0 = Date.now(), r = parseResultsFile(fs.readFileSync(process.argv[2]), path.basename(process.argv[2]));
  console.log(`${path.basename(process.argv[2])}: ${r ? `${r.parser.name}, ${r.parser.describe(r.data)}` : 'not recognised'} (${Date.now() - t0} ms)`);
}

console.log('All results file checks passed');
