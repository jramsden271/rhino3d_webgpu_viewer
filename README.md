# 3DM Viewer

A single HTML file that opens Rhino `.3dm` models in the browser and renders them with WebGPU.
No install, no server, no internet connection: the Rhino file reader (McNeel's rhino3dm,
compiled to WebAssembly) is embedded in the page, and the model never leaves your computer.

## Installation

To use the viewer, there is nothing to install: download
[`dist/index.html`](dist/index.html) and follow [Using it](#using-it) below. To work
on the code, see [Development](#development).

## Using it

1. Open `dist/index.html` in a current **Chrome** or **Microsoft Edge** (double-click it).
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
| Orbit (around the point under the cursor) | Perspective and most named views: right-drag, Alt + left-drag · one finger | |
| Rotate about Z | Top: right-drag around the middle of the window · Elevation: right-drag left or right | |
| Pan (the surface you grab stays under the cursor) | Left- or middle-drag, Shift + right-drag · two fingers · in Top and Elevation also one finger | |
| Zoom (towards the surface under the cursor, slowing to a stop at it) | Wheel · pinch | |
| Focus on a point | Double-click a surface | |
| Zoom extents | Double-click empty space | `F` |
| Rotate the view | Drag the compass (bottom left) | |
| Face north, east, south or west | Compass: double-click the N or a tick | |
| Pedestrian mode | Camera button: Walk · drag to look · wheel zooms (field of view) | `4` · `W` `A` `S` `D` or arrows to walk · `Shift` to run · `Space` jump · hold `E` / `Q` to rise / sink · `T` torch · `Esc` to stop |
| Lights panel · add a lamp at the cursor · remove added lamps | Toolbar: Lights | `G` · `B` · `Shift+B` |
| Thermal comfort panel (UTCI at the camera) | Toolbar: UTCI | `U` |
| Messages about this model · dismiss one or all | Bell, top left | |
| Cameras | Toolbar: camera button | `1` Top · `2` Elevation · `3` Perspective · `4` Walk |
| Render mode: Shaded (layer/object colours), Clay, Rendered (materials) | Toolbar: render mode button | `M` cycles |
| Edges · Curves · Magic · Animations · Ambient occlusion · X-ray | Toolbar: render mode button | `E` · `C` · none · none · `O` · `X` |
| Layers · Blocks · Sun panel | Toolbar | `L` · `K` · `S` |
| Weather panel | Toolbar: Weather | |
| Results files · CFD streamlines | File icon, top left · Toolbar: Results | |
| Undo · Redo | Arrows next to the file name | `Ctrl+Z` · `Ctrl+Y` (or `Ctrl+Shift+Z`) |
| Select all visible objects | | `Ctrl+A` |

The **compass** at the bottom left points to north on the screen, from the model's north angle
(click the file name to see or change it), and turns as the view does. Drag it like a dial to rotate the view, keeping its tilt; the drag
carries on outside the compass, where it is easier to control. Double-click its **N**, or the
tick for east, south or west, to turn the view to face that way, keeping its tilt.

The **camera button** on the toolbar shows the current view and opens a list of Top, Elevation, Perspective and Walk, with any views
saved by name in the Rhino file above them. Top and Elevation are parallel (no perspective) views
that never tilt: Top always looks straight down and Elevation always looks level. Both pan and
zoom, and turn about the Z axis through the middle of the view, by dragging the compass or by
right-dragging: in Top the whole window is a dial, with a large see-through compass marking its middle while you
drag, and in Elevation only the drag left or right
counts. Each camera remembers where you left it, including its rotation: leave one and come back,
or reload the model, and it is where it was (including after walking). The first visit to a camera,
or picking the one you are already in, gives its default, including its rotation: the extents for
the built-in cameras, the saved view for a named one. Top and Elevation start out facing the model's
+Y direction. The rules come from the camera, not its name: a named view that is parallel and looks
straight down moves like Top, one that is parallel and exactly level moves like Elevation, and any
other orbits freely.

Named views are read-only and are matched as closely as this camera allows: the position,
direction, lens and parallel zoom come from the file, and all of the saved frame stays in view
whatever the window's shape. There is no roll, and a shifted frame (a two-point perspective, for
example) is framed by turning towards its centre, so its verticals may converge. A named view
sets only the camera, not the layers.

The cameras, layer visibility, hidden objects and the sun (on or off, date and time, sun path diagram) are
**remembered in this browser** for each model (by file name and size) and come back when you
open it again. If the model has no location by then, the sun stays off. They are not changes to the
model, so they are not undoable and are not written to a saved copy.

**Pedestrian mode** walks round the model at eye height (1.5 m). Pick **Walk** in the camera
list, or press `5`, from any view. Then, as in
Street View, the figure follows the cursor and a soft yellow circle marks the surface under
it. Click to start there: the view fades through black and you stand on the ground at that
spot, looking level in the same direction. Click a wall and you stand at its foot, on your side,
as a lamp is placed with `B`. Until you click you can still orbit, pan and zoom; `Esc` or another
camera cancels. If a perspective camera is already within 3 m of the surface below it, there is
no choosing: after the same fade, you start walking where you are. Once walking, the
camera follows the
ground, climbing slopes and anything up to 1 m high (steps, kerbs, low walls); anything between
1 m and head height blocks the way, and you slide along it. Over a drop you pause for a moment
(so small gaps between floors in a model don't trip you up) and then fall; landing after a real fall brings the view back to the horizontal, first jerking it down unless it already points 20° or more below. The view bobs gently as you walk or run on the ground. A fall with nothing
below returns you to where you last stood, with the controls locked for a second. Only what is
shown counts: hidden objects and layers are walked through, and so is vegetation (layers with
the Vegetation magic material). The mouse wheel zooms by narrowing or widening the field of
view, from 10° to 75°; it goes back to normal when you stop walking.

`Space` jumps (about 0.6 m, then gravity brings you down). Holding `E` rises and `Q` sinks
at a steady 2 m/s (6 m/s with `Shift`), ignoring gravity while held; letting go of `E` drops
you again, and `Q` stops on the ground.

Starting a walk opens the **Walk panel**. Closing it does not stop walking; pick Walk in the
camera list again to bring it back. Its **Speed** slider sets the walking speed, 0.5 to 15 m/s
(1.4 m/s to start with; Shift runs at three times it), and turns collision
detection off for walking through walls in demonstrations (you still follow the ground and
climb steps). **Fly** turns gravity off, lifting you about 5 m after a quick crouch if you are standing: you hover wherever `E` and `Q` leave you, stay level
when you walk off an edge, and land when the ground rises to meet you (`Space` does nothing
while flying). Whether you are standing in sunlight shows in the
[Thermal comfort](#thermal-comfort) panel. The settings are remembered in this browser, and the panel's **?** button lists the controls. Walking is not recorded in the undo history. Picking another camera stops it, through the same
fade, and goes to that camera; `Esc` goes back to the camera you started from. Press `T` while
walking for a torch: a spot light held at chest height that points where you look and casts
shadows (see [Lights](#lights)).

**Undo and redo** cover changes to the model, as in Rhino: layer colours, materials and magic
materials, object colour and material sources, the north angle and Revert.
View changes, date and time, hiding objects, turning layers on or off and the site location
(a viewer setting, not part of the model) are not recorded. Dragging a slider or colour
picker is one step. The history starts afresh each time a file is opened.

In the Layers and Block definitions panels, click a row to select it, Ctrl-click to add or remove a row, and
Shift-click to select a run of rows. A checkbox or right-click on a selected row acts on all the
selected rows.

In the Layers panel, Shift-click a checkbox to isolate that layer. Layers start with the
visibility saved in the file. Right-click a layer for:

- **Select objects**: the visible objects on that layer (the count is shown).
- **Select sublayer objects**: the visible objects on that layer and all its sub-layers
  (only for layers with sub-layers).

Double-click a layer's row to open its colour or material window, as its square does.

The Block definitions panel appears for models with blocks. It lists each block definition that has an
instance, including those only used inside other blocks, with its number of copies in the model
(a sub-block used 3 times in a block placed 10 times has 30). Right-click a block for:

- **Select instances**: its visible top-level instances.
- **Select sub-blocks**: adds every block inside it, at any depth, to the selected rows.
- **Sub-element setting**: as clicking its tag or double-clicking its row.

Unticking a block hides every copy of it, like turning a layer off: a copy shows only if it and
every block around it are ticked. A row is dimmed when none of its copies can show because of the
blocks around it. Block visibility is separate from **Unhide all**, is remembered with the view,
and is not undoable or saved in a copy.

The tag on each row is the block's sub-element setting, for where the objects directly inside the
definition get their colour and material. It belongs to the definition, as in Rhino, so it is shared
by all its instances:

- **default**: as in the file.
- **byParent**: from the block instance. If the instance is set to By object, its object colour is
  used; to follow its layer instead, select the instance and set its Colour to By layer.
- **byLayer**: from each sub-element's own layer, not the layer of the block instance.

The setting doesn't reach sub-blocks unless you click **Apply setting to sub-blocks**, which copies
it down to every block inside, once; the latest setting wins for a block with several parents. It
can be undone, and it is written into a saved copy. Layer visibility is not affected: a sub-element on
a layer that is off stays hidden.

The same window can choose a **magic block**: geometry from the viewer's built-in library that
replaces every instance of the block, for example a nicer tree for a simple tree crown. The library
has a placeholder deciduous tree and a palm tree. Each instance is sized uniformly to the height of its
block's box. A tree also needs ground to grow from, so its box reaches down to the highest visible
surface below the box's centre (vegetation doesn't count), and stops at its own bottom if there is
none. Hiding or showing what is below moves it to match. Trees also get their own fixed turn. The
leaves and trunks are on the **Magic blocks** layers, which appear in the Layers panel while in use.
The tag then reads "magic", and the sub-element setting doesn't apply.

The Layers, Block definitions and Sun panels close with their × button or from the toolbar. The first
two can be open together, sharing the height the other panels leave. Drag the left edge of any of
these panels to widen the column they share (double-click the edge for the default); the width is remembered.

**Magic materials** give common site elements a look a plain colour cannot: animated water,
glass reflecting the sky, foliage that varies from tree to tree. Each layer has one, set in
its material dialog (click the layer's square in Rendered view):

- **Auto** (the default): the layer is matched by name. The layer's own name is tried first,
  then its parent layers' names, then the name of its render material. The match is shown as
  a small tag after the layer name (e.g. *auto: vegetation*) and explained in the dialog.
- **Always off**: no magic material, whatever the name.
- **Water, Glass, Vegetation, Grass, Road, Paving, Ground, Whitewashed concrete, Concrete,
  Red masonry**: always this one.

Like any layer material, a magic material reaches only objects whose material comes from
that layer ("By layer", or "By parent" inside a block instance that takes it from the layer).
Blocks are not matched by their names: the parts of a tree block use the magic material of
the layer their material comes from.

Surfaces without a magic material also get a faint **natural variation** in Rendered view, so
walls and roofs look less like a CAD model:

- slight blotchy discolouration (a few metres across, stretched downwards on walls, as
  weathering streaks run);
- a fine grain that shows close up;
- highlights that break up across a surface instead of shining evenly (visible on layers
  given some gloss).

The variation is worked out in 3D at each point, in metres, so it needs no texture coordinates
and looks the same scale in any model units. Fine detail fades out as it gets smaller than a
few pixels, so distant surfaces don't shimmer as the view moves. Grass, road, paving and ground
use the same noise for their larger-scale variation, so it also wraps evenly over slopes and
embankments.

The **Magic ✨** item in the render mode menu turns magic materials on and off, natural variation
included. When off, everything renders with its plain material colour. Clay view shows only the
magic water, and leaves everything else in clay.

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
| whitewash, limewash, white concrete, white render | Clean white wash, gently uneven, as when nearly new |
| concrete, precast, in situ, cast in place, cement | Grey concrete: cloudy patches, aggregate speckle and pour lines close up |
| brick, masonry | Red brick in stretcher bond close up, each brick a slightly different shade |

Where surfaces of these types nearly coincide or cross (a road draped over terrain, say), the
viewer gives hard surfaces display priority: water, road and paving show in front of grass,
and grass in front of ground/terrain. This follows each layer's magic material, even with
Magic off.

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

All of these changes, and the north angle, are **remembered automatically** in this browser for
each model (by file name and size) and restored when you open it again. **Download .3dm** in the file properties
(click the file name) writes a *copy* of the .3dm with them: layer colours, a Rhino material
for each layer material set in the viewer (assigned as the layer's render material),
changed object colour and material sources, block sub-element settings and magic blocks. Top-level instances of a block with a magic block are removed, and an instance of a new definition holding it takes the place of each, on the same layer. No existing block definition changes, so instances inside other blocks stay as they are, and the viewer says which. Your original file is not touched. Materials with a magic material are named after it (e.g.
"Water – 010_WaterBody"), so Auto matches them again when the copy is reopened. "Always off"
is not saved in the copy.

**Inspect and hide objects.** The object panel can be dragged by its title bar; it then stays
put until it closes. Click a surface or mesh to select the whole object (a block
instance is one object) and show its type, block name (click to find it in the Block definitions panel), layer (click to find it in the Layers
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
**Download .3dm** saves a copy with your colour and material changes, and **Revert changes**
puts everything (layer colours and materials, object colours and materials, the north angle,
hidden objects and layer visibility) back to how it is in the file. The cameras stay where they are.

**Ambient occlusion** (`AO`, on by default) adds soft shading where surfaces meet: wall
bases, courtyards, under canopies. It is screen-space (SSAO), so its radius scales with the
view; it is worked out at half the window's resolution, and switches off in X-ray mode. It is
computed from the true (faceted) surfaces, so the
smooth shading of foliage does not darken the outlines of tree canopies. It also softens
edges: the light rolls round each corner as though it were rounded by a few centimetres (never
less than 2 pixels on screen), outside corners catch a little more light, and faceted curved
surfaces look smoother. Glass and vegetation keep their sharp edges. In the Rendered view with
the sun on, edge lines are fainter and thin out further with distance.

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

The **results files button** next to it opens the **Results files** dialog, which lists the
files added to the model and the parser that read each. **Add results file…** adds another, and
so does dropping one onto the window; × removes one. Results files are only read. Like the weather
file, a copy of each is kept with the model and comes back when you reopen it from Recent files,
so to update one, remove it and add the new version.

Once a file has been read, **Results** appears on the toolbar. In its menu, each item opens or closes
its panel, and is coloured while the panel is open; the item's checkbox is the same as the switch on
that panel's title bar, showing or hiding what it draws. **CFD streamlines** opens a panel listing the streamlines in the file, with the polylines of each nested under it, as sub-layers
are under a layer. Each has a checkbox, and unticking a streamline hides all its polylines; the
switch on the panel's title bar shows what is ticked or nothing. They're drawn as polylines in the file's coordinates,
scaled to the model's units, with each segment coloured by the velocity at its start, on the Lawson
comfort criteria.

Its **CFD map** item opens a panel for results on a surface, drawn from the file's nodes and faces,
which needs no change to the model. Each map has its results nested under it, one chosen at a time,
and a checkbox to hide it; the switch on the title bar shows what is ticked or nothing. Below the
list are the colour scale's legend and **Move up or down**, from 10 m down to 100 m up. Hold the mouse over
a map and a panel follows it with every result at that spot, worked out between the nodes. Faces
touching a node that lacks the chosen result are left out, rather than shown in a colour that means
something else.

Colour scales come from `src/colourscales.js`, so a kind of data looks the same wherever it appears.
They have fixed values and don't stretch to fit a file. Where there are several, the dropdown under
the legend picks one, which the viewer remembers and uses everywhere, the Thermal comfort panel
included:

| Data | Scales (default first) |
|---|---|
| UTCI | Blue, green, red bands · off-white in place of the green · also a darker off-white in place of the orange (26 to 32 °C) · continuous |
| Wind speed | Lawson comfort criteria, in bands · continuous |
| Relative humidity | Continuous, off-white at 0 to blue at 100 |
| Temperature | Continuous, blue at −20 °C, light grey at 10 °C, red at 40 °C |
| Time in sun (sun exposure) | Magma (matplotlib's), continuous from 0 to 100% |

A column that is none of these gets a blue to red scale across its own range, leaving out the
extremes.

A CFD map file is a `.csv` with `[Name]`, `[Data]` (node number, X, Y, Z and any results) and
`[Faces]` (three or four node numbers) sections.

A CFD streamlines file is a `.csv` with `[Name]`, `[Data]` (node number, X, Y, Z and velocity) and
`[Lines]` (pairs of node numbers) sections. Parsers live in `src/results.js`: each file goes to
each parser in turn until one recognises it.

Click **Weather** on the toolbar for the **Weather panel**, at the Sun panel's date and time. One
row shows the air temperature, relative humidity and wind speed, with a compass arrow pointing
the way the wind blows (north up; hover for the direction it comes from). **More** opens the
cloud cover, the global horizontal, direct normal and diffuse horizontal irradiance, and the
Cloud speed slider. Values are interpolated between the file's hourly records, each taken as the
middle of its hour.

### Clouds and daylight

With the sun on and a weather file loaded, the weather shows in the sky and the light. The
cloud on the toolbar's Weather button (filled white while on) and the switch on the Weather
panel turn this on and off; off, the sky and light are a clear day's, as without a file.

With the sun off, perspective views still show the clouds, as many as the file gives for the Sun
panel's date and time and drifting with its wind, on a neutral daytime sky that does not change
with the date or time. The model keeps its usual lighting, so there are no cloud shadows. This
needs no location.

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
  **Cloud speed** slider under **More** (0-100, 10 to start with; 0 stops them). The wind is measured 10 m
  up, while clouds sit higher where it blows harder, and a larger multiplier also makes the
  drift easier to see. Like the water ripples, they stop after 15 s without input, or at once
  with **Animations** off in the render mode menu, which saves the graphics card work on large
  models when the view is still. While only the clouds move, or the ripples, frames are drawn
  about 30 times a second, and the sun's shadow maps and the ambient occlusion are kept from
  the last frame rather than drawn again, so a drifting frame costs little more than the main pass.

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
from sunrise to sunset. **Details** on the panel opens the sun's altitude and azimuth and the
day's sunrise and sunset. The date has no year: sun positions change too little from year to
year to matter here (2017 is used). When the file has Rhino Sun settings, they set the
starting date and time.

- **Date and time** also set the Weather and Thermal comfort panels, and work with the sun
  off too.
- **UTC offset** comes from the location: the clock's offset from UTC, e.g. 3 for Qatar.
- **Sun path diagram** draws the sun's path on the sky, in perspective views and with the sun on or
  off: the 21st of each month (pairs of months with nearly the same path share an arc), a line for
  each clock hour through the year, and the horizon with its compass points. The date on the
  sliders is picked out in yellow, with a ring where the sun is at the time on the sliders. The
  model hides it, as it would the sky. Orthographic views have no sky, so it does not show there.

Sun positions use the NOAA solar position equations (with refraction), which match
published sunrise/sunset times to within about a minute. This is a visual study tool, not a
validated daylight or solar analysis. Shadows fall only on the model's own geometry: where
there is no ground modelled, there is nothing to receive them. They are cast by surfaces and
meshes only (not curves); materials more than 40% transparent do not cast shadows, whether that comes from the file or the viewer (the Water and Glass magic materials go by the file's value alone). Shadows use four
cascaded 2048² shadow maps, so they stay sharp from site scale down to street level.

## Sun exposure

**Tools → Sun exposure** shows how often each part of some surfaces can see the sun over a period,
ignoring cloud: the share of the times tested, while the sun is up, that the sun reaches each
point. It needs a location. The results are drawn on the model, coloured from always shaded to
always in sun (magma), and are not kept: they last until the settings change or the model closes.

- **Surfaces** are a layer's objects: choose the layer, or press the picker and click an object
  on it. Each object is tested on the side facing most nearly up (an object facing as much down as
  up, such as a closed solid or a wall, keeps its own sides); **Flip sides** tests the other side.
  **Ground/roof only** keeps just the faces within 45° of straight up (turned up, before any flip),
  leaving out walls and the like. While picking, a marker follows the surface under the cursor.
- **Dates** and **Times** each have two grips, in either order: every day from the earlier date to
  the later is tested at the times from the earlier to the later, both ends included, every
  **Interval** (5 to 60 minutes). Right-click either for the usual choices.
- **Grid spacing** (0.1 to 10 m) is the most distance between the points tested. The objects'
  render meshes are joined and their long edges split until none is longer, so no meshing is
  needed in Rhino. Edges sharper than 40° keep a normal for each side. A new layer starts at the
  finest spacing that gives about 200,000 points.
- What casts shadows is what is shown: hide a layer or an object and the results update without
  it. Materials more than 40% transparent do not cast shadows, as for the sun.
- Under the results: the area analysed, and how much of it is in sun and shaded on average over
  the period (in m² and %, weighted by area).
- **Update automatically** recalculates soon after any change; off, nothing runs until
  **Update**, for long periods. A run can be stopped.

Each sun position draws the shown model's depth as seen from the sun into a 4096² map (or up to
4 × 4 of them for a large area, so that a texel is at most half the grid spacing), and a compute
pass tests every point against it, blending the four texels round it.

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

The value and its category show first; **Details** opens to show the wind factor, the simulated
clouds option, and the air temperature, humidity, wind, sun and radiant temperature that went
into it.

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

## Development

### Requirements

- [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 18 or later.
- `tar` on the path, which Windows 10 and later, macOS and Linux all include.
- A current Chrome or Microsoft Edge, for WebGPU.

There is no `package.json` and no `npm install`: the build and tools use only Node's built-in
modules, and the page has no framework or bundler.

### Setting up

```bash
git clone https://github.com/jramsden271/rhino3d_webgpu_viewer.git
```

```bash
cd rhino3d_webgpu_viewer
```

```bash
node build.js
```

The first build needs an internet connection, to download rhino3dm from the npm registry into
`vendor/` (git-ignored). After that it works offline.

### Running it

```bash
node tools/serve.js
```

This serves the project on http://localhost:8123/ (`node tools/serve.js 9000` for another port).
The server is only for development; the built viewer does not need it.

- http://localhost:8123/src/index.html runs the sources unbuilt, so a reload shows an edit straight
  away. It needs `vendor/`, so run `node build.js` once first.
- http://localhost:8123/dist-dev/index.html is the built viewer. Rebuild to see an edit.
- Adding `?model=/samples/x.3dm` to either opens a model straight away. No models come with the
  repository: create a `samples/` folder and put your own there (it and `*.3dm` files are git-ignored).

### Making a change

`main` is the live site, so work on the `develop` branch. Edit `src/`, then run `node build.js`,
which writes `dist-dev/index.html` (git-ignored). Commit only the sources.

To update rhino3dm, change `RHINO3DM_VERSION` in `build.js` and rebuild.

### Releasing

`dist/index.html` is what people use. It is committed, and changes only in a release:

1. Merge `develop` into `main`.
2. On `main`, run `node build.js --release`, which writes `dist/index.html`.
3. Commit that file and push `main`. Cloudflare Pages then deploys it.

### Hosting

Cloudflare Pages serves the `dist/` folder as static files (build output directory `dist`, no build
command) and deploys each push to `main`. It runs no build, so what is committed in `dist/` is what goes live. Models
still stay on the computer of whoever opens them: the site only delivers the page.

### Tests and tools

There is no test framework; these are plain Node scripts. Only the first runs without any files
of your own, and the last three need `vendor/`. Behaviour in the browser is checked by hand.

| Command | What it does |
| --- | --- |
| `node tools/test-utci.js` | Checks the UTCI against reference values from ladybug-comfort |
| `node tools/test-epw.js <folder or .epw files>` | Checks weather file reading against real files |
| `node tools/test-magic.js` | Checks where a magic block is placed |
| `node tools/test-sun.js` | Checks the sun path diagram |
| `node tools/test-exposure.js` | Checks the analysis meshes and sun exposure periods |
| `node tools/make-magic-block.js tree`, or `from <file.3dm> <block> <id> <name>` | Prints an entry for the magic block library in `src/magicblocks.js` |
| `node tools/test-extract.js <file.3dm>` | Runs the model extraction under Node and prints a summary |
| `node tools/probe.js <file.3dm>` | Summarises a file's contents and whether Breps have render meshes |
| `node tools/probe2.js <file.3dm>` | Prints the shapes of values returned by rhino3dm |

## Layout

```
dist/index.html          the released viewer (the only file anyone needs)
dist-dev/index.html      development build (git-ignored)
build.js                 inlines src/ + rhino3dm (JS and both WASM builds) into dist-dev/, or dist/ with --release
src/index.html, style.css  page and UI
src/magicblocks.js       magic block library and how an instance is placed
src/extract.js           .3dm -> GPU batches (colours, blocks, curves, edges), sorted into grid cells so each view draws only the cells it can see
src/renderer.js          WebGPU renderer (reverse-Z depth, 4x MSAA, GPU picking, cascaded shadows)
src/sun.js               solar position, sun direction and colour
src/mesh.js              meshes made for analysis: join, weld, split long edges, normals
src/exposure.js          sun exposure: the times in a period, and the surface to test from a layer
src/epw.js               EnergyPlus weather files: location and hourly weather by date and time
src/clouds.js            cloud cover, sun and sky strength from the weather file; clear-sky models
src/utci.js              UTCI (Universal Thermal Climate Index), its stress categories, SolarCal sun on a person
src/cities.js            city list for the Set location dialog
src/dialog.js            centred dialog / message box (Dialog.open, Dialog.confirm)
src/recent.js            recent files list (file handles in IndexedDB)
src/materials.js         magic materials: keyword rules and default colours
src/camera.js            Z-up orbit / pan / zoom camera, matching Rhino's named views
src/toolmenu.js          toolbar menus: a button with a popup that takes any content (ToolbarMenu), a list of choices (ChoiceList)
src/rangepair.js         a slider with two grips, for a range
src/walk.js              pedestrian mode: walking, ground following, steps, falls
src/main.js              file loading, input, layer panel, toolbar
tools/                   development helpers (local server, Node test scripts)
```

`src/utci.js` is the UTCI_approx polynomial (Bröde et al. 2009), with its coefficients taken
from the BHoM LadybugTools Toolkit (`external_comfort/utci.py`). `utci(ta, tr, va, rh)` takes
air and mean radiant temperature in °C, 10 m wind speed in m/s (clamped to 0.5-17, as
ladybug-comfort does) and relative humidity in %. `utciMany` runs it over arrays, and
`utciCategory` gives the stress band and its colour. `solarMrtDelta` gives the rise in mean
radiant temperature from direct sun (SolarCal), and `surroundingsMrtDelta` the placeholder for
sun-warmed surroundings. `node tools/test-utci.js` checks it
against values from ladybug-comfort.

## Future work

**Layer settings inside blocks.** Editing in the viewer stays basic; anything more complicated
belongs in Rhino. To fix common layer and display problems within blocks, a selected block could
offer three options:

- All sub-elements by layer
- All sub-elements by parent
- Restore layer settings of sub-elements

This replaces the earlier Explode block feature, which was removed to keep the viewer simple.
