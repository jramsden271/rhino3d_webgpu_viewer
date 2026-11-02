// Checks the results file parsers in src/results.js:  node tools/test-results.js [streamlines.csv]
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = ['utci.js', 'colourscales.js', 'results.js'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
const { parseResultsFile, parseCfdStreamlines, parseCfdMap, streamlineVertices, ColourScales, cfdMapValues, cfdMapVertices, cfdMapFind, cfdMapValueAt, UTCI_CATEGORIES } = new Function(`${src}\nreturn { parseResultsFile, parseCfdStreamlines, parseCfdMap, streamlineVertices, ColourScales, cfdMapValues, cfdMapVertices, cfdMapFind, cfdMapValueAt, UTCI_CATEGORIES };`)();

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
assert.strictEqual(parseCfdStreamlines(faces), null, 'surface results');
assert.strictEqual(parseResultsFile(bytes('a,b\n1,2\n'), 'table.csv'), null, 'any other csv');
assert.strictEqual(parseResultsFile(bytes(file), 'a.txt'), null, 'another extension');
assert.strictEqual(parseCfdStreamlines(`[Name]\nNo speed\n[Data]\nNode Number, X [ m ], Y [ m ], Z [ m ]\n0, 0, 0, 0\n[Lines]\n0, 0\n`), null, 'no velocity');

// This kind of file, but damaged: says why.
assert.throws(() => parseCfdStreamlines(`[Name]\nBad\n${data(nodes)}${lines([[0, 99]])}`), /isn't in its \[Data\]/);

// Colour scales: wind speed by the Lawson bands.
const CS = ColourScales, get = (id) => CS.scales.find((s) => s.id === id), hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const lawson = CS.preferred('windSpeed');
assert.strictEqual(lawson.id, 'lawson');
assert.strictEqual(hex(CS.colour(lawson, 0)), '#0061F9', 'blue from 0');
assert.strictEqual(hex(CS.colour(lawson, 1.99)), '#0061F9');
assert.strictEqual(hex(CS.colour(lawson, 2)), '#00ECF9', 'next band from 2');
assert.strictEqual(hex(CS.colour(lawson, 11)), '#FCA902');
assert.strictEqual(hex(CS.colour(lawson, 50)), '#FD2E03', 'red above');
assert.strictEqual(CS.label(lawson, 7), 'Walking');
// And its continuous version, read by the same bands.
assert.strictEqual(hex(CS.colour(get('lawsonSmooth'), 7)), '#47F800', 'the band colour at its middle');
assert.deepStrictEqual(CS.colour(get('lawsonSmooth'), 8), [142, 250, 1], 'between bands, in between');
assert.strictEqual(hex(CS.colour(get('lawsonSmooth'), 0)), '#0061F9', 'clamped low');
assert.strictEqual(hex(CS.colour(get('lawsonSmooth'), 50)), '#FD2E03', 'clamped high');
assert.strictEqual(CS.label(get('lawsonSmooth'), 7), 'Walking');
assert.deepStrictEqual(CS.legend(get('lawsonSmooth')).ticks.map((t) => t.text), ['2', '4', '6', '8', '10', '12']);
// UTCI: the default, its off-white variants and the continuous one.
assert.strictEqual(CS.preferred('utci').id, 'utci');
assert.strictEqual(hex(CS.colour(get('utci'), 20)), '#2EB349');
assert.strictEqual(hex(CS.colour(get('utciWhite'), 20)), '#F4F1E8');
assert.strictEqual(hex(CS.colour(get('utciWhite'), 30)), '#F38322', 'orange stays');
assert.strictEqual(hex(CS.colour(get('utciWhiter'), 20)), '#F4F1E8');
assert.strictEqual(hex(CS.colour(get('utciWhiter'), 30)), '#DDD8C8');
assert.strictEqual(hex(CS.colour(get('utciSmooth'), 17.5)), '#2EB349', 'continuous: the band colour at its middle');
assert.notStrictEqual(hex(CS.colour(get('utciSmooth'), 23)), '#2EB349', 'and between them in between');
assert.strictEqual(CS.label(get('utciSmooth'), 30), 'Moderate heat stress');
// A smooth scale, and one choice of several applies wherever the metric is used.
assert.strictEqual(hex(CS.colour(get('temperature'), 10)), '#D4D4D4');
assert.strictEqual(hex(CS.colour(get('temperature'), -50)), '#2A63C8', 'clamped');
assert.deepStrictEqual(CS.colour(get('temperature'), 25), [210, 123, 120], 'part way');
CS.choices.utci = 'utciWhite';
assert.strictEqual(CS.preferred('utci').id, 'utciWhite');
CS.choices.utci = 'gone';
assert.strictEqual(CS.preferred('utci').id, 'utci', 'an unknown choice falls back to the default');
delete CS.choices.utci;
// The table for the GPU agrees with the scale, on both sides of a band's edge.
for (const s of CS.scales) {
  const r = CS.ramp(s), n = r.data.length / 4;
  for (const v of [r.lo, (r.lo + r.hi) / 2, r.hi - (r.hi - r.lo) / n]) {
    const i = Math.min(n - 1, Math.floor(((v - r.lo) / (r.hi - r.lo)) * n));
    const want = CS.colour(s, r.lo + ((i + 0.5) / n) * (r.hi - r.lo));
    assert.deepStrictEqual([...r.data.slice(i * 4, i * 4 + 3)], want, s.id);
  }
}
const rampAt = (r, v) => { const i = Math.floor(((v - r.lo) / (r.hi - r.lo)) * r.data.length / 4); return [...r.data.slice(i * 4, i * 4 + 3)]; };
assert.deepStrictEqual(rampAt(CS.ramp(lawson), 7.9), CS.colour(lawson, 7.9));
assert.deepStrictEqual(rampAt(CS.ramp(lawson), 8.1), CS.colour(lawson, 8.1));
// What each column is.
assert.strictEqual(CS.metricOf('UTCI Va', null), 'utci');
assert.strictEqual(CS.metricOf('Resultant Temperature', 'C'), 'temperature');
assert.strictEqual(CS.metricOf('Temperature', 'K'), null, 'not on a Celsius scale');
assert.strictEqual(CS.metricOf('Relative Humidity', null), 'relativeHumidity');
assert.strictEqual(CS.metricOf('Velocity', 'm s^-1'), 'windSpeed');
assert.strictEqual(CS.metricOf('Pressure', 'Pa'), null);
const own = CS.fromData(Float32Array.from({ length: 101 }, (_, i) => (i === 100 ? 1e6 : i)));
assert(own.stops[2][0] < 1000, 'a scale from the data ignores outliers');

// CFD map: triangles and quads, every result column, and missing values kept as missing.
const mapData = `[Data]
Node Number, X [ m ], Y [ m ], Z [ m ], Relative Humidity, Temperature [ C ], UTCI Va, Velocity [ m s^-1 ], Pressure [ Pa ]
0, 0, 0, 1, 10, 20, 30, 1, 100
1, 2, 0, 1, 20, 22, 32, 2, 200
2, 2, 2, 1, 30, 24, 34, 3, 300
3, 0, 2, 1, 40, 26, 36, 4, 400
4, 4, 0, 1, null, null, null, null, null
5, null, 0, 1, 1, 1, 1, 1, 1
`;
const ground = `[Name]\nGround\n${mapData}\n[Faces]\n0, 1, 2, 3\n1, 4, 2\n1, 5, 2\n0, 1, 99\n`;
const parsed = parseResultsFile(bytes(ground), 'ground.csv');
assert.strictEqual(parsed.parser.id, 'cfdMap');
const gm = parsed.data.maps[0];
assert.deepStrictEqual(gm.results.map((r) => [r.name, r.metric]), [['Relative Humidity', 'relativeHumidity'], ['Temperature', 'temperature'], ['UTCI Va', 'utci'], ['Velocity', 'windSpeed'], ['Pressure', null]]);
assert.deepStrictEqual([...gm.indices], [0, 1, 2, 0, 2, 3, 1, 4, 2], 'a quad splits in two');
assert.strictEqual(gm.faces, 4);
assert.strictEqual(gm.skippedFaces, 2, 'a node with no position or not in the data');
assert.strictEqual(gm.missing, 1);
assert(Number.isNaN(gm.results[0].values[4]));
assert(cfdMapValues(gm.results[0])[4] > 1e20, 'a missing value is huge');
assert.strictEqual(cfdMapValues(gm.results[0])[1], 20);
assert.strictEqual(parsed.parser.describe(parsed.data), '1 map · 5 results · 4 faces · 1 node without some results · 2 faces not usable');
// Each parser takes only its own files.
assert.strictEqual(parseCfdStreamlines(ground), null);
assert.strictEqual(parseCfdMap(`[Name]\nS\n${data(nodes)}${lines([[0, 1]])}`), null);
assert.strictEqual(parseCfdMap(`[Name]\nNo results\n[Data]\nNode Number, X [ m ], Y [ m ], Z [ m ]\n0, 0, 0, 0\n[Faces]\n0, 0, 0\n`), null);
// Positions for the GPU, and reading the values at a point: on a face, on its diagonal, off the map,
// and next to a node with no value.
assert.deepStrictEqual([...cfdMapVertices(gm, 0.5, [1, 0, 0]).slice(3, 6)], [3, 0, 2]);
const near = (a, b) => assert(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);
const speedAt = (x, y) => { const f = cfdMapFind(gm, x, y, 1); return f && cfdMapValueAt(gm.results[3], f); };
near(speedAt(0, 0), 1);
near(speedAt(2, 0), 2);
near(speedAt(1, 0), 1.5);
near(speedAt(1, 1), 2);
assert.strictEqual(speedAt(-1, 0), null);
assert.strictEqual(speedAt(1, 3), null);
assert(Number.isNaN(speedAt(3, 0.5)), 'no data beside the node without any');
// Overlapping sheets: the one at this height.
const two = parseCfdMap(`[Name]\nTwo\n[Data]\nNode Number, X [ m ], Y [ m ], Z [ m ], Velocity [ m s^-1 ]\n0, 0, 0, 0, 1\n1, 1, 0, 0, 1\n2, 0, 1, 0, 1\n3, 0, 0, 5, 9\n4, 1, 0, 5, 9\n5, 0, 1, 5, 9\n[Faces]\n0, 1, 2\n3, 4, 5\n`).maps[0];
near(cfdMapValueAt(two.results[0], cfdMapFind(two, 0.2, 0.2, 4.9)), 9);

// Vertices: model units, relative to the origin, each segment the colour of its start node.
d = parseCfdStreamlines(`[Name]\nA\n${data(nodes)}${lines([[0, 1], [1, 2]])}\n[Name]\nB\n${data(nodes)}${lines([[3, 4]])}`);
const velocityColour = (s) => CS.colour(lawson, s);
const v = streamlineVertices(d.streamlines, 0.001, [100, 0, 0], velocityColour);
assert.deepStrictEqual(v.ranges, [[{ first: 0, count: 4 }], [{ first: 4, count: 2 }]]);
d = parseCfdStreamlines(`[Name]\nTwo lines\n${data(nodes)}${lines([[0, 1], [3, 4], [4, 5]])}`);
assert.deepStrictEqual(streamlineVertices(d.streamlines, 1, [0, 0, 0], velocityColour).ranges, [[{ first: 0, count: 2 }, { first: 2, count: 4 }]], 'a range for each polyline');
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
