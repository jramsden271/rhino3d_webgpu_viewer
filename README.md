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
| Pedestrian mode (perspective only) | Toolbar: Walk · drag to look · wheel zooms (field of view) | `W` `A` `S` `D` or arrows to walk · `Shift` to run · `Space` jump · hold `E` / `Q` to rise / sink · `T` torch · `Esc` to stop |
| Lights panel · add a lamp at the cursor · remove added lamps | Toolbar: Lights | `G` · `B` · `Shift+B` |
| Thermal comfort panel (UTCI at the camera) | Toolbar: UTCI | `U` |
| Views | Toolbar | `1` Top · `2` Front · `3` Right · `4` Perspective · `P` parallel/perspective |
| Shading: Shaded (layer/object colours), Rendered (materials), Clay | Toolbar | `M` cycles |
| Edges · Curves · Ambient occlusion · X-ray · Layers · Sun panel | Toolbar | `E` · `C` · `O` · `X` · `L` · `S` |
| Weather panel | Toolbar: Weather | |
| Undo · Redo | Arrows next to the file name | `Ctrl+Z` · `Ctrl+Y` (or `Ctrl+Shift+Z`) |
| Select all visible objects | | `Ctrl+A` |

Top, Front and Right are parallel (no perspective) views, as in Rhino; orbiting one turns it
into a free view. Each of the four views remembers its camera: leave one and come back, and
it is where you left it (including after walking, for Perspective). The first visit to a
view, or picking the view you are already in, zooms to the extents. Opening another model
starts afresh.

**Pedestrian mode** walks round the model at eye height (1.5 m). Move the camera over the
model in a perspective view and click the figure on the toolbar's **Walk** button (or the
switch on the Walk panel): the camera drops at the speed of gravity onto the
surface below it (click or press a movement key to land straight away). It then follows the
ground, climbing slopes and anything up to 1 m high (steps, kerbs, low walls); anything between
1 m and head height blocks the way, and you slide along it. Over a drop you pause for a moment
(so small gaps between floors in a model don't trip you up) and then fall; landing after a real fall brings a downward view back to the horizontal. A fall with nothing
below returns you to where you last stood, with the controls locked for a second. Only what is
shown counts: hidden objects and layers are walked through, and so is vegetation (layers with
the Vegetation magic material). The mouse wheel zooms by narrowing or widening the field of
view, from 10° to 75°; it goes back to normal when you stop walking.

`Space` jumps (about 0.6 m, then gravity brings you down). Holding `E` rises and `Q` sinks
at a steady 2 m/s (6 m/s with `Shift`), ignoring gravity while held; letting go of `E` drops
you again, and `Q` stops on the ground.

The rest of the Walk button opens the **Walk panel**, whose title has the same on/off switch;
closing the panel does not stop walking. The figure is grey, and yellow while you walk.
Its **Speed** slider sets the walking speed, 0.5 to 15 m/s
(1.4 m/s to start with; Shift runs at three times it), and turns collision
detection off for walking through walls in demonstrations (you still follow the ground and
climb steps). **Fly** turns gravity off: you hover wherever `E` and `Q` leave you, stay level
when you walk off an edge, and land when the ground rises to meet you (`Space` does nothing
while flying). Whether you are standing in sunlight shows in the
[Thermal comfort](#thermal-comfort) panel. The settings are remembered in this browser, and the panel's **?** button lists the controls. Walking is not recorded in the undo history; pressing Esc, the
switch or the figure, a view button or `P` stops it and leaves you orbiting a point just ahead. Press `T` while
walking for a torch: a spot light held at chest height that points where you look and casts
shadows (see [Lights](#lights)).

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
**Set location** (its **?** button explains the choices), which has three sources:

- **Weather file (EPW)**: the location from the weather file, named from the file (e.g.
  "Riyadh Khalid, Saudi Arabia"). **Choose EPW file…** or **Replace…** opens the Weather
  file dialog (below).
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

The **weather button** next to the pin (a sun behind a cloud) opens the **Weather file**
dialog. The icon is in colour when a weather file is loaded, with the file's name in its
tooltip, and greyed out when there is none. Choose an EnergyPlus weather file (`.epw`), or
drop one onto the window; **Replace…** loads another and **Remove** takes it away. It gives
the weather in the Weather panel and, when it has a latitude and longitude, the location.

Click **Weather** on the toolbar for the **Weather panel**: the air temperature, relative
humidity, wind speed and direction, cloud cover, and global horizontal, direct normal and diffuse
horizontal irradiance at the Sun panel's date and time. Values are interpolated between the
file's hourly records, each taken as the middle of its hour.

### Clouds and daylight

With the sun on and a weather file loaded, the weather shows in the sky and the light. The
cloud on the toolbar's Weather button (filled white while on) and the switch on the Weather
panel turn this on and off; off, the sky and light are a clear day's, as without a file.

- **Cloud cover** comes from the file's total sky cover (tenths), which nearly every EPW has,
  day and night, and which in most files comes from observations. Where it is missing or does
  not look like observations (not whole tenths, or never changing), it is estimated by day
  from the share of diffuse light (diffuse over global horizontal) and filled in overnight; the
  panel says "from radiation". That estimate is rough (about 2 tenths out on average for
  Leeds), and low for broken cloud, which barely dims the sun.
- **The sun's strength** follows the direct normal irradiance against a clear sky's (Meinel,
  with the Kasten & Young air mass), so an overcast hour has faint, soft shadows and a hazy
  desert sun is a little weaker, whatever the cloud cover says. Of the direct light lost, the
  cloud shadows (below) take about 0.9 × cover on average, and an even dimming the rest, which
  stands for haze. **The sky light** follows the diffuse horizontal irradiance against about an
  eighth of a clear sky's global (Haurwitz): overcast skies light the model more evenly. Near
  sunrise and sunset, where these ratios mean little, the cloud cover decides.
- **Cloud shadows** fall on the model in every view: each lit point looks up towards the sun
  (or the moon) to the cloud layer, which is fixed above the model, so the shadows come from
  the clouds overhead and drift with them. Under a cloud the direct light drops to a tenth.
  They use four octaves of the sky's noise, so they are softer than the clouds' edges.
- **The sky** greys over as the cover closes in, and in perspective views a cloud layer 1.5 km
  up is drawn from fractal noise, with as much of the sky covered as the file says. The clouds
  are white with bright edges towards the sun, grey where thick, warm underneath at sunset and
  moonlit at night, and hide the stars. The sun is hidden when a cloud is in front of it, which
  is exactly when the camera stands in that cloud's shadow.
- **The clouds drift with the wind**, from the file's wind direction at its speed times the
  **Cloud speed** slider (0-100, 10 to start with; 0 stops them). The wind is measured 10 m
  up, while clouds sit higher where it blows harder, and a larger multiplier also makes the
  drift easier to see. Like the water ripples, they stop after 15 s without input. While only
  the clouds move, the sun's shadow maps and the ambient occlusion are kept from the last frame
  rather than drawn again, so a drifting frame costs little more than the main pass.

Reflections in water and glass show the sky's colours without the clouds. Rain, fog and dust are not shown: EPW
precipitation and present-weather fields are too unreliable (Leeds TMYx, for one, reports
moderate rain in over a third of its hours, with rainfall recorded in very few of them).

**The custom location, the weather file and your choice belong to one model.** Setting any
of them links it to the open model's entry in **Recent files** (shown there as "custom
location …" and "weather …"; a copy of the weather file is kept, so it reloads without
asking for permission again), and they come back when you reopen that model from the list
or drop it again. Opening any other model clears them, even one with no location of its own.
Models opened another way (the plain file input, a `?model=` link) have no entry to link
to, so these last only while they are open.

## Sun and shadows

Click **Sun** (or press `S`) to open the Sun panel, and switch it on there to light the model
by the sun with cast shadows. The sun icon on the Sun button is a switch of its own: click it to
turn the sun on and off without opening the panel (it turns yellow and filled while on). In perspective views the sky shows the sun itself, and both
follow the time of day: a low sun turns orange-red with a warm glow along the horizon, the
sky darkens through twilight, and at night the stars come out (placed for the location, date
and time, so they turn through the night) and the model is lit by a dim blue night light.
The moon is shown in its real position and phase (lit on the side facing the sun), and once
the sky is dark it lights the model and casts soft shadows, brighter towards full moon. Set
the date and local time with the sliders (right-click the date slider to jump to a solstice
or equinox, or the time slider for 10:00, 12:00, solar noon or 15:00), and press ▶ to animate
from sunrise to sunset. The panel shows the sun's altitude and azimuth and the day's
sunrise and sunset. The date has no year: sun positions change too little from year to
year to matter here (2017 is used). When the file has Rhino Sun settings, they set the
starting date and time.

- **Date and time** also set the Weather and Thermal comfort panels, and work with the sun
  off too.
- **UTC offset** comes from the location: the clock's offset from UTC, e.g. 3 for Qatar.

Sun positions use the NOAA solar position equations (with refraction), which match
published sunrise/sunset times to within about a minute. This is a visual study tool, not a
validated daylight or solar analysis. Shadows fall only on the model's own geometry: where
there is no ground modelled, there is nothing to receive them. They are cast by surfaces and
meshes only (not curves); materials more than 40% transparent do not cast shadows. Shadows use four
cascaded 2048² shadow maps, so they stay sharp from site scale down to street level.

## Thermal comfort

Click **UTCI** on the toolbar (or press `U`) for the Thermal comfort panel. It estimates the
Universal Thermal Climate Index (UTCI) at the camera, at the Sun panel's date and time, and
shows it with its thermal stress category (9-26 °C is no thermal stress). It needs a weather
file. Walk to measure at head height; in orbit views it is measured wherever the camera is.

Under the UTCI a line says whether the camera is in sunlight, checked a few times a second
along a line from the eye to the sun (whether or not the sun lighting is on). Trees cast shade
here even though you can walk through them; glass counts as opaque. It reads:

- **In sunlight**, with the direct sun on the person (W/m²);
- **In weak sunlight** when that is below 100 W/m²: a thin or hazy sun, or one just over the
  horizon, which adds little warmth;
- **Under a simulated cloud** (grey) when **Include simulated clouds** is ticked and a drawn
  cloud is over the sun;
- **In shade**, naming the layer of whatever casts it and how far away it is; or **Night**.

- **Air temperature** and **relative humidity** come from the weather file.
- **Wind speed** is the weather file's (10 m, open ground) times the panel's **wind factor**,
  0-1, which stands in for shelter until the viewer can estimate it. It starts at 0.5, a
  typical allowance for streets and buildings; the UTCI itself expects 10 m wind speeds. Wind
  below 0.5 m/s (including calm) is counted as 0.5 m/s, the lowest speed the UTCI was fitted for.
- **Mean radiant temperature** is the air temperature in shade. In sunlight (the sunlight line
  above, including weak sunlight) two things are added:
  - the direct sun on the person, by SolarCal (Arens et al. 2015, as in ladybug-comfort) for a
    standing person turned side-on to the sun, from the direct normal radiation and the sun's
    altitude: typically 10-25 °C;
  - a placeholder for sun-warmed ground and walls nearby: direct normal × sin(altitude) / 60,
    about 10 °C for 600 W/m² of direct sun on the ground. Sunlit paving is roughly 20-30 °C
    hotter than shaded paving in summer, and the ground fills about half of a person's view.

  Together a sunlit spot comes out about 15-27 °C warmer in radiant temperature than a shaded
  one, in line with field measurements of 18-30 °C, which typically adds 4-7 °C to the UTCI.
  Surfaces heating up and cooling down over the day, their materials, the sky and reflected
  light are not counted.
- **Clouds** are counted in one of two ways:
  - By default, the direct sun is the weather file's hourly direct normal radiation: an
    average that already allows for that hour's cloud by dimming the sun evenly. This is how
    comfort is normally assessed (hour by hour), and it does not change as the drawn clouds pass.
  - With **Include simulated clouds** ticked, it is the sun at the camera under the drawn
    clouds: the beam between the clouds (the hour's direct radiation with the clouds' share
    of the dimming taken out, see [Clouds and daylight](#clouds-and-daylight)), cut to a tenth
    when a cloud's shadow is over the camera. The UTCI then follows the clouds as they pass,
    typically by a few degrees in summer, and the panel says whether the camera is in a gap or
    under a cloud. The clouds are invented: the weather file gives how much of the sky is
    cloudy, not where the clouds are, so this shows what a passing cloud does rather than what
    happened. Over time the two agree on average. The sun-warmed surroundings keep the hourly
    value either way (ground and walls do not cool as a cloud passes). It needs the sun and
    the weather on, and an hour with some cloud; otherwise the panel says so and uses the hourly
    figure. `clouds.js` repeats the shader's cloud field on the CPU (with an integer hash that
    gives the same values on both) so the panel and the picture agree.

The value, its category and the wind factor show first; **Inputs** opens to show the air
temperature, humidity, wind, sun and radiant temperature that went into it.

This is an estimate for comparing places and times, not a substitute for a full outdoor
comfort study.

## Lights

Point and spot lights light the model in any shading mode; they show best at night. Click
**Lights** (or press `G`) to open the Lights panel, which lists:

- **Torch**: the walker's torch, on and off with the checkbox or `T` in pedestrian mode.
- **From the Rhino file**: the file's point and spot lights, with their position, colour,
  intensity and, for spots, direction and cone. Rhino's intensity 1 is about as bright as a
  street light. Disabled lights are left out; directional, linear and rectangular lights are
  not used.
- **Added here**: lamps added with `B`, which puts a warm lamp just off the surface under the
  cursor (towards you). × removes one, `Shift+B` all of them. They are not saved with the file.

The panel's **?** button repeats the keys and limits. The switch in the panel's title, or the
bulb icon on the toolbar's Lights button (yellow and filled while on), turns the file's and
added lights on and off together. While they are on, the ticked lights shine, or all of them
when none is ticked; a lamp added while some are ticked is ticked too. The torch has its own
checkbox. Up to 8 lights shine at once (the torch first, then the list in order); the panel
marks the others "not shown". Light falls off with the square of the distance and fades out
by 30 m (40 m for the torch). A lamp in view is drawn as a small glowing bulb.

The first lights also cast shadows, from 512² shadow maps: one map for a spot light and six
(a cube) for a point light, 25 maps in all, e.g. the torch and four point lights. The panel
says which lights have shadows. A lamp's maps are drawn again only when it moves or what is
shown changes, so fixed lamps cost little after the first frame; the torch is redrawn as
you walk.

## What is shown

- Meshes, polysurfaces/Breps, extrusions, curves, points and block instances (nested,
  with "by parent" colours and materials).
- Colours follow Rhino's rules (layer, object, material or parent colour); Rendered mode uses
  the object's render material, including PBR base colours and transparency.
- Brep edges, mesh creases and boundaries are drawn as edges.
- Analysis meshes with vertex colours keep their colours.
- Hidden objects, layout (page space) objects and block definitions themselves are skipped.
- Point and spot lights light the model (see [Lights](#lights)).
- Not shown: annotations, text, dimensions, hatches, other light types, textures.

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
src/clouds.js            cloud cover, sun and sky strength from the weather file; clear-sky models
src/utci.js              UTCI (Universal Thermal Climate Index), its stress categories, SolarCal sun on a person
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

`src/utci.js` is the UTCI_approx polynomial (Bröde et al. 2009), with its coefficients taken
from the BHoM LadybugTools Toolkit (`external_comfort/utci.py`). `utci(ta, tr, va, rh)` takes
air and mean radiant temperature in °C, 10 m wind speed in m/s (clamped to 0.5-17, as
ladybug-comfort does) and relative humidity in %. `utciMany` runs it over arrays, and
`utciCategory` gives the stress band and its colour. `solarMrtDelta` gives the rise in mean
radiant temperature from direct sun (SolarCal), and `surroundingsMrtDelta` the placeholder for
sun-warmed surroundings. `node tools/test-utci.js` checks it
against values from ladybug-comfort.
