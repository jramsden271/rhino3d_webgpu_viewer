// Magic materials: looks that a plain colour cannot give (animated water, glass reflecting the
// sky, foliage that varies from tree to tree). Each layer has one: Always off, Auto (the default)
// or a chosen type. Auto matches the layer's own name, then its parent layers' names, then the
// name of its render material, against the keyword lists below; the first rule that matches wins,
// so order matters. Edit the keyword lists to suit your own layer conventions.
//
// A keyword matches at the start of a word: "water" matches "Terrain Water" and "WaterBody";
// "tree" matches "Trees" but not "Street". A trailing $ means whole word only ("sea$" does not
// match "seating").
//
// rgb: the default base colour (sRGB), shown in the layer dialog. The look varies around this
// colour (from object to object for vegetation, across the surface for grass, road, paving and
// ground), so a different colour keeps the variation. tones: the darkest and lightest variation as
// factors of the base colour, for the two-tone layer swatch (the shader in renderer.js uses the same).

const MATERIAL_RULES = [
  { id: 1, name: 'Water', rgb: [0.218, 0.326, 0.343], keywords: ['water', 'river', 'canal', 'lake$', 'lakes$', 'pond', 'sea$', 'stream$', 'streams$', 'reservoir', 'harbour', 'harbor', 'lagoon'] },
  { id: 2, name: 'Glass', rgb: [0.32, 0.38, 0.43], keywords: ['glass', 'glazing', 'glazed', 'curtain wall', 'curtainwall', 'window'] },
  { id: 3, name: 'Vegetation', rgb: [0.30, 0.38, 0.23], tones: [[0.8, 0.868, 0.87], [1.2, 1.132, 1.13]], keywords: ['tree', 'vegetation', 'veg$', 'planting', 'foliage', 'hedge', 'shrub', 'bush', 'woodland', 'forest'] },
  { id: 4, name: 'Grass', rgb: [0.485, 0.54, 0.34], tones: [[0.928, 0.963, 0.941], [1.072, 1.037, 1.059]], keywords: ['grass', 'lawn', 'turf', 'meadow', 'green space', 'greenspace', 'soft landscap', 'softscape', 'pitch$'] },
  { id: 5, name: 'Road', rgb: [0.36, 0.36, 0.37], tones: [[0.94, 0.94, 0.94], [1.06, 1.06, 1.06]], keywords: ['road', 'carriageway', 'asphalt', 'tarmac', 'highway', 'motorway', 'parking', 'car park', 'rail$', 'railway'] },
  { id: 6, name: 'Paving', rgb: [0.74, 0.72, 0.68], tones: [[0.95, 0.95, 0.95], [1.03, 1.03, 1.03]], keywords: ['pavement', 'paving', 'footway', 'footpath', 'sidewalk', 'walk$', 'walkway', 'public realm', 'hard landscap', 'hardscape', 'plaza', 'pedestrian'] },
  { id: 7, name: 'Ground', rgb: [0.75, 0.735, 0.67], tones: [[0.96, 0.966, 0.955], [1.04, 1.034, 1.045]], keywords: ['terrain', 'land$', 'soil', 'ground', 'topo'] },
];

const MAT_WATER = 1, MAT_GLASS = 2, MAT_VEGETATION = 3;
const SPECIAL = Object.fromEntries(MATERIAL_RULES.map((r) => [r.id, r]));

const ruleRegexes = MATERIAL_RULES.map((r) => ({
  id: r.id,
  re: new RegExp(r.keywords.map((k) => '(?<![a-z])' + k.replace(/\$$/, '(?![a-z])').replace(/ /g, '[\\s_-]?')).join('|')),
}));
const classifyCache = new Map();

// Returns the rule id for a name, or 0 when nothing matches.
function classifyMaterial(text) {
  const t = text.toLowerCase();
  let id = classifyCache.get(t);
  if (id === undefined) {
    id = 0;
    for (const r of ruleRegexes) if (r.re.test(t)) { id = r.id; break; }
    classifyCache.set(t, id);
  }
  return id;
}

// Auto match for layer i: { id, from: 'name' | 'parent' | 'material', text } or null.
function matchLayer(layers, i) {
  const l = layers[i];
  if (!l) return null;
  for (let p = i; p >= 0 && layers[p]; p = layers[p].parent) {
    const id = classifyMaterial(layers[p].name);
    if (id) return { id, from: p === i ? 'name' : 'parent', text: layers[p].name };
  }
  const id = l.materialName ? classifyMaterial(l.materialName) : 0;
  return id ? { id, from: 'material', text: l.materialName } : null;
}
