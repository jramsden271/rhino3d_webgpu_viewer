# 3DM Viewer

A single HTML file that opens Rhino `.3dm` models in the browser and renders them with WebGPU.
No install, no server, no internet connection: the Rhino file reader (McNeel's rhino3dm,
compiled to WebAssembly) is embedded in the page, and the model never leaves your computer.

## Using it

1. Open `dist/rhino-viewer.html` in a current **Chrome** or **Microsoft Edge** (double-click it).
2. Drag a `.3dm` file onto the page, or click **browse for one**.

The welcome screen lists the last five files opened (in this browser); click one to open it
again, or × to remove it from the list. The browser asks once per session for permission to
read the file again. A file that has been moved or renamed has to be opened afresh.

Click **3DM Viewer** (top left) to return to the welcome screen and open another file. The
model you were looking at stays loaded until another opens: **Back to …** (or Esc) returns to it.
A file can also be dropped onto the page at any time.

The file can be copied anywhere (a project folder, a network drive, an email) and shared as is.

| Action | Mouse / touch | Keys |
| --- | --- | --- |
| Orbit (around the point under the cursor) | Right-drag, Alt + left-drag · one finger (in Top, Front and Right views: Alt + left-drag only) | |
| Pan | Left- or middle-drag, Shift + right-drag · two fingers · in Top, Front and Right views also right-drag and one finger | |
| Zoom (towards the cursor) | Wheel · pinch | |
| Focus on a point | Double-click a surface | |
| Zoom extents | Double-click empty space | `F` |
| Pedestrian mode (perspective only) | Toolbar: Walk · drag to look · wheel sets the walking speed | `W` `A` `S` `D` or arrows to walk · `Shift` to run · `Esc` to stop |
| Views | Toolbar | `1` Top · `2` Front · `3` Right · `4` Perspective · `P` parallel/perspective |
| Shading: Shaded (layer/object colours), Rendered (materials), Clay | Toolbar | `M` cycles |
| Edges · Curves · Ambient occlusion · X-ray · Layers · Sun panel | Toolbar | `E` · `C` · `O` · `X` · `L` · `S` |
| Undo · Redo | Arrows next to the file name | `Ctrl+Z` · `Ctrl+Y` (or `Ctrl+Shift+Z`) |
| Select all visible objects | | `Ctrl+A` |

Top, Front and Right are parallel (no perspective) views, as in Rhino; orbiting one turns it
into a free view.

**Pedestrian mode** walks round the model at eye height (1.5 m). Move the camera over the
model in a perspective view and press Walk: the camera drops at the speed of gravity onto the
surface below it (click or press a movement key to land straight away). It then follows the
ground, climbing slopes and anything up to 1 m high (steps, kerbs, low walls); anything between
1 m and head height blocks the way, and you slide along it. Over a drop you pause for a moment
(so small gaps between floors in a model don't trip you up) and then fall; landing after a real fall brings a downward view back to the horizontal. A fall with nothing
below returns you to where you last stood, with the controls locked for a second. Only what is
shown counts: hidden objects and layers are walked through, and so is vegetation (layers with
the Vegetation magic material).

The **Walk panel** opens with pedestrian mode. It sets the walking speed, 0.5 to 15 m/s
(1.4 m/s to start with; also the mouse wheel; Shift runs at three times it), and turns collision
detection off for walking through walls in demonstrations (you still follow the ground and
climb steps). With the sun on, it shows whether you are standing in sunlight, checked a few
times a second along a line from your eye to the sun; in shade it names the layer of whatever
casts it. Trees cast shade here even though you can walk through them; glass counts as opaque.
The settings are remembered in this browser. Walking is not recorded in the undo history; pressing Esc, a
view button or `P` stops it and leaves you orbiting a point just ahead.

**Undo and redo** cover changes to the model, as in Rhino: layer colours, materials and magic
materials, object colour and material sources, exploded blocks, the north angle and Revert.
View changes, date and time, hiding objects, turning layers on or off and the site location
(a viewer setting, not part of the model) are not recorded. Dragging a slider or colour
picker is one step. Undoing an explode rebuilds the model, which takes a moment on large
files. The history starts afresh each time a file is opened.

In the Layers panel, Shift-click a checkbox to isolate that layer. Layers start with the
visibility saved in the file. Right-click a layer for:

- **Select objects**: the visible objects on that layer (the count is shown).
- **Select sublayer objects**: the visible objects on that layer and all its sub-layers
  (only for layers with sub-layers).
- **Show all** / **Hide all**: turn the layer and all its sub-layers on or off.

The Layers and Sun panels close with their × button or from the toolbar.

**Magic materials** give common site elements a look a plain colour cannot: animated water,
glass reflecting the sky, foliage that varies from tree to tree. Each layer has one, set in
its material dialog (click the layer's square in Rendered view):

- **Auto** (the default): the layer is matched by name. The layer's own name is tried first,
  then its parent layers' names, then the name of its render material. The match is shown as
  a small tag after the layer name (e.g. *auto: vegetation*) and explained in the dialog.
- **Always off**: no magic material, whatever the name.
- **Water, Glass, Vegetation, Grass, Road, Paving, Ground**: always this one.

Like any layer material, a magic material reaches only objects whose material comes from
that layer ("By layer", or "By parent" inside a block instance that takes it from the layer).
Blocks are not matched by their names: the parts of a tree block use the magic material of
the layer their material comes from.

The **Magic ✨** button on the toolbar turns magic materials on and off. When off,
everything renders with its plain material colour.

The colour in the dialog is the magic material's **base colour**: vegetation varies around
it from object to object, and grass, road, paving and ground across the surface. Pick any
colour (pink for cherry blossom, say) and the variation is kept. For water it is the colour of
the water body, and for glass the tint (the sky reflection stays). Until you change it, the
base colour is the magic material's default.

| Matches (start of a word) | Look |
| --- | --- |
| water, river, canal, lake, pond, sea, stream, reservoir, harbour | Animated water: ripples, sky reflection, sun glint |
| glass, glazing, curtain wall, window | Blue-grey glass reflecting the sky |
| tree, vegetation, planting, foliage, hedge, shrub, bush, woodland | Smooth-shaded foliage, varied greens |
| grass, lawn, turf, meadow, green space, soft landscape, pitch | Natural grass with subtle variation |
| road, carriageway, asphalt, tarmac, highway, parking, rail | Dark asphalt |
| pavement, paving, footway, footpath, walk, public realm, plaza | Light warm stone |
| terrain, land, soil, ground, topo | Warm earth |

Where surfaces of these types nearly coincide or cross (a road draped over terrain, say), the
viewer gives hard surfaces display priority: water, road and paving show in front of grass,
and grass in front of ground/terrain. This follows each layer's magic material, even with
the Magic button off.

The keyword lists are at the top of `src/materials.js`; edit them to match your own layer
conventions and rebuild. Independently of the rules, Rendered mode is matte (Rhino gloss
settings are ignored), uses filmic tone mapping, varies the shade of each building slightly,
and fades distant geometry into a light haze. Water ripples animate while you interact and
pause after 15 seconds idle.

**Layer colours and materials.** Each layer's square in the Layers panel shows what that view
uses: in Shaded (and Clay) view, the layer's **display colour**; in Rendered view, its
**material**. Click it to change that one:

- In Shaded view: the display colour.
- In Rendered view: the magic material (see above), colour, gloss and transparency.

As in Rhino, a layer setting changes only objects whose colour or material source is
"By layer" (or "By parent" on a block whose instance takes it from the layer). When objects on
the layer have their own colour or material, the dialog says how many and offers to select
them, so you can switch them to "By layer" in the object panel. Edited squares get a blue ring;
*Reset to file* removes the setting (the magic material goes back to Auto).

**Object colours and materials.** The object panel shows a **Colour** source in Shaded view
(By layer, By object, By parent, By material) or a **Material** source in Rendered view (By
layer, By object, By parent). "By object" adds a colour picker or a list of the file's
materials. With several objects selected, a source that differs between them shows as *Mixed*,
and a change applies to all of them. On a block instance the source applies to the parts inside
it that are set to "By parent".

**Explode blocks.** When the selection includes block instances, *Explode block(s)* replaces
each with the objects inside it, including nested blocks, so each part can be selected and
changed. Parts set to "By parent" take the instance's colour and material as their own, so
nothing changes on screen. The block definitions themselves are unchanged.

All of these changes are **remembered automatically** in this browser for each model (by file
name and size) and restored when you open it again. **Download .3dm** in the file properties
(click the file name) writes a *copy* of the .3dm with them: layer colours, a Rhino material
for each layer material set in the viewer (assigned as the layer's render material), changed
object colour and material sources, and exploded blocks (replaced by copies of their parts).
Your original file is not touched. Materials with a magic material are named after it (e.g.
"Water – 010_WaterBody"), so Auto matches them again when the copy is reopened. "Always off"
is not saved in the copy.

**Inspect and hide objects.** The object panel can be dragged by its title bar; it then stays
put until it closes. Click a surface or mesh to select the whole object (a block
instance is one object) and show its type, block name, layer (click to find it in the Layers
panel), material, size, triangle count, Rhino user text and ID (click to copy). Shift-click
adds or removes objects; with several selected the panel summarises types, layers, overall
extent and triangles. **Hide** (or `H`) removes the selection from view, including its edges,
curves and shadows; a floating **Unhide all (n)** button brings everything back. `Esc` clears
the selection. Curves and points are not clickable.

**File properties.** Click the file name (top left) for the file's statistics (size, units,
objects, triangles, curves, block instances, layers, location, anything not shown) and the
changes made in the viewer. It also has the model's **north angle**, as in Rhino: degrees
anticlockwise from the model's +X axis to north, so 90 means +Y is north. It comes from the
file's Sun settings or Earth anchor point, or is 90 when the file sets neither. From there,
**Download .3dm** saves a copy with your colour, material and block changes, and **Revert
changes** puts everything (layer colours and materials, object colours and materials,
exploded blocks, the north angle, hidden objects and layer visibility) back to how it is in
the file.

**Ambient occlusion** (`AO`, on by default) adds soft shading where surfaces meet: wall
bases, courtyards, under canopies. It is screen-space (SSAO), so its radius scales with the
view; it switches off in X-ray mode. It is computed from the true (faceted) surfaces, so the
smooth shading of foliage does not darken the outlines of tree canopies.

## Location and weather

The pin at the top left shows the site location: grey **Set location** when nothing sets
one, or a red pin and the place name (or coordinates) when something does. Click it to open
**Set location**, which has three sources:

- **Weather file (EPW)**: choose an EnergyPlus weather file, or drop an `.epw` onto the
  window. It gives the location, named from the file (e.g. "Riyadh Khalid, Saudi Arabia"),
  and the weather in the Sun panel.
- **Custom location**: type a latitude and longitude (the UTC offset follows the longitude
  until you type one), or choose from about 60 cities (standard-time UTC offset, without
  daylight saving; the list is in `src/cities.js`).
- **Rhino file**: the open model's Sun settings (Rendering panel → Sun) or, failing that,
  its Earth anchor point.

The source in use is outlined and marked **In use**; any other source with a location has a
**Use this location** button to switch to it. A new weather file or custom location is used
straight away. Until you choose, the first that is set is used: custom location, weather
file, Rhino file. With none, there is no location: the sun cannot be turned on, and trying
shows a warning with a link to Set location. Location changes are not part of undo.

**The custom location, the weather file and your choice belong to one model.** Setting any
of them links it to the open model's entry in **Recent files** (shown there as "custom
location …" and "weather …"; a copy of the weather file is kept, so it reloads without
asking for permission again), and they come back when you reopen that model from the list
or drop it again. Opening any other model clears them, even one with no location of its own.
Models opened another way (the plain file input, a `?model=` link) have no entry to link
to, so these last only while they are open.

## Sun and shadows

Click **Sun** (or press `S`) to open the Sun panel, and switch it on there to light the model
by the sun with cast shadows. In perspective views the sky shows the sun itself. Set the date
and local time with the sliders (or the solstice/equinox buttons), and press ▶ to animate
from sunrise to sunset. The panel shows the sun's altitude and azimuth and the day's
sunrise and sunset. The date has no year: sun positions change too little from year to
year to matter here (2017 is used). When the file has Rhino Sun settings, they set the
starting date and time.

- **Weather**: with a weather file loaded, the panel shows the air temperature, relative
  humidity, wind speed and direction, and global horizontal, direct normal and diffuse
  horizontal irradiance at the panel's date and time. Values are interpolated between the
  file's hourly records, each taken as the middle of its hour. The date and time sliders work
  with the sun off too.
- **UTC offset** comes from the location: the clock's offset from UTC, e.g. 3 for Qatar.
- **Shadows on a ground plane** adds a shadow catcher at the bottom of the model, for
  massing models without terrain.

Sun positions use the NOAA solar position equations (with refraction), which match
published sunrise/sunset times to within about a minute. This is a visual study tool, not a
validated daylight or solar analysis. Shadows are cast by surfaces and meshes only (not
curves); materials more than 40% transparent do not cast shadows. Shadows use four
cascaded 2048² shadow maps, so they stay sharp from site scale down to street level.

## What is shown

- Meshes, polysurfaces/Breps, extrusions, curves, points and block instances (nested,
  with "by parent" colours and materials).
- Colours follow Rhino's rules (layer, object, material or parent colour); Rendered mode uses
  the object's render material, including PBR base colours and transparency.
- Brep edges, mesh creases and boundaries are drawn as edges.
- Analysis meshes with vertex colours keep their colours.
- Hidden objects, layout (page space) objects and block definitions themselves are skipped.
- Not shown: annotations, text, dimensions, hatches, lights, textures.

### Polysurfaces need render meshes

A browser cannot turn NURBS into triangles; only Rhino can. The viewer draws the render
meshes Rhino caches in the file. A normal **Save** includes them; **Save Small**, or files
written by other tools, may not. If anything is missing, the viewer tells you how many
objects were skipped. Fix: open the model in Rhino, show it in a shaded view, then save it
normally (or use `ExtractRenderMesh`).

## Large files

Files up to a few hundred MB load fine. Above 150 MB the viewer switches to the 64-bit
(memory64) build of rhino3dm automatically, and it also falls back to it if the 32-bit reader
runs out of memory. As a guide, a 494 MB masterplan (2.5 million triangles, 3,900 block
instances) loads in about 15 seconds.

Models far from the origin (e.g. on British National Grid coordinates) are re-centred in
double precision before conversion, so there is no jitter when zoomed in.

## Rebuilding

Only needed after editing `src/` or to update rhino3dm. Requires Node.js 18 or later.

```bash
node build.js
```

The first build downloads rhino3dm from the npm registry into `vendor/`. After that it works
offline. To update rhino3dm, change `RHINO3DM_VERSION` in `build.js`.

## Layout

```
dist/rhino-viewer.html   the viewer (the only file anyone needs)
build.js                 inlines src/ + rhino3dm (JS and both WASM builds) into dist/
src/index.html, style.css  page and UI
src/extract.js           .3dm -> GPU batches (colours, blocks, curves, edges)
src/renderer.js          WebGPU renderer (reverse-Z depth, 4x MSAA, GPU picking, cascaded shadows)
src/sun.js               solar position, sun direction and colour
src/epw.js               EnergyPlus weather files: location and hourly weather by date and time
src/cities.js            city list for the Set location dialog
src/dialog.js            centred dialog / message box (Dialog.open, Dialog.confirm)
src/recent.js            recent files list (file handles in IndexedDB)
src/materials.js         magic materials: keyword rules and default colours
src/camera.js            Z-up orbit / pan / zoom camera
src/walk.js              pedestrian mode: walking, ground following, steps, falls
src/main.js              file loading, input, layer panel, toolbar
tools/                   development helpers (local server, Node test scripts)
```

During development, `node tools/serve.js` serves the project on http://localhost:8123/.
`src/index.html` runs unbuilt, and `dist/rhino-viewer.html?model=/samples/x.3dm` opens a
model straight away.
