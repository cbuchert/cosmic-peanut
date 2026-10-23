# The bestiary: animal tiles

Each file here is one animal that tiles the plane. Metamorphosis prints them with its woodcut look
when its **Creatures** param is set to a group, and morphs between compatible species on the music.
Files are data only: the engine derives the rest.

```
tiles/<group>/<name>.json     one species (group: fish, birds, reptiles, mammals)
tiles/<group>/index.json      generated: the group's species (never edit by hand)
```

## Workflow

```sh
uv run python -m tools.tiles check fish/koi        # validate (no ids: everything); exit 1 on errors
uv run python -m tools.tiles preview fish/koi --out /tmp/tiles   # PNG sheet: look at it
uv run python -m tools.tiles fmt fish/koi          # house style (points on one line)
uv run python -m tools.tiles index                 # after adding or removing a file
uv run pytest tests/test_tiles_tool.py && (cd web && npx vitest run ../plugins/builtin/src/lib/bestiary)
```

The loop is: edit the JSON, `check`, `preview`, look at the PNG, repeat. The sheet shows:

- the tile large, with its vertices (V0…), free edges in blue with their control points numbered,
  derived edges dashed grey, and neighbours faded around it;
- a tiled patch in two palettes (does it read as an animal at a glance, in a crowd?);
- morph strips (0–100 %) to each compatible species, or to the plain tile, which is the path a change of
  tile type takes.

`check` verifies everything Metamorphosis relies on:

- the edge relations;
- a simple outline (no crossings) with the right area, and an exact cover of the plane (a
  jittered sample of a 2×2 patch of cells: every point in exactly one tile);
- art inside the outline (strokes by half their width);
- every blend with compatible species, and with its own plain tile, at 25/50/75 % stays a
  valid tile;
- the group indexes are current.

It warns on thin necks or long spikes (under ~8 px on a 1440p screen) and strokes under 1 px.

To see a species in the engine (dev harness, from the repo root, server on a free port):
`plugins/_harness/index.html?repo=builtin&viz=metamorphosis&p.creatures=fish/koi`
(`p.creatures=fish` for the group with morphs; add `&still=150` for a deterministic still).

## Originality

Animals are free to depict, but **every outline must be your own design**. Never trace or closely
reproduce any published tessellation artwork. In particular, don't reproduce M. C. Escher's tile
designs (his lizards, birds, fish, horsemen and so on), even approximately: no copying from memory, no
"in the style of" a specific print. Start from the animal's anatomy and the type's constraints below,
and design the interlock yourself. Don't use artists' names or artwork titles in names or notes.

## Format

```jsonc
{
  "format": 1,
  "name": "Koi",                     // common name (shown nowhere yet; keep it plain)
  "group": "fish",                   // must be the folder
  "type": "TGTG",                    // TTTTTT | TGTG | C4 | C3
  "notes": "…",                      // free text: what nests where (helps the next designer)
  "corners": { "w": 1.5, "h": 0.8, "s": 0 },   // per type, optional (defaults below)
  "edges": {                         // the type's FREE edges only
    "e0": { "smooth": [[0.04, -0.07], [0.12, 0.08]] },
    "e1": { "bezier": [[0.3, 0.1], [0.6, -0.2]] }
  },
  "art": [                           // painter's order: later items on top
    { "part": "patch", "fill":   { "smooth": [[0.6, 0.6], [0.9, 0.7], [0.8, 0.45]] } },
    { "part": "gill",  "stroke": { "smooth": [[1.28, 0.66], [1.22, 0.42], [1.3, 0.16]] }, "width": [0.012, 0.03] },
    { "part": "eye",   "circle": [1.52, 0.48, 0.055] }
  ],
  "colours": { "patch": "accent", "gill": "ink", "eye": "paper" },   // part → colour role
  "height": { "dome": 0.7, "parts": { "fin": 0.3, "scales": -0.2 } } // relief hint (optional)
}
```

**Edges** are in the edge's own *chord frame*: `u` runs 0 → 1 from the edge's start vertex to its
end vertex, `v` is to the left of that direction (into the tile for a counter-clockwise tile),
both in chord lengths. The end points (0, 0) and (1, 0) are implicit. Kinds:

| kind | points | notes |
| --- | --- | --- |
| `smooth` | any number | a curve **through** the points (Catmull–Rom); easiest to design with |
| `bezier` | 3n − 1 | cubic chain: handle, handle, anchor, …, handle, handle |
| `polyline` | any number | straight segments: zigzags, spines, sharp tips |

**Art** is in tile-frame coordinates (the frame of V0…, as on the preview). Items:
`circle: [x, y, r]`; `fill: {path}` (closed automatically); `stroke: {path}` with `width` (or
`[start, end]` for a taper). Paths are `smooth`, `bezier` (3n + 1 points, anchor first) or
`polyline`, all in absolute coordinates. Stroke widths are in tile-frame units: about 0.012 is a
fine line, 0.03 a bold one. The art must stay inside the outline. Keep it inside the body, not in
thin fins that neighbours squeeze.

**Colour roles** (`colours` maps each part to one):

| role | prints as |
| --- | --- |
| `fill` | the tile's own colour, hatched like the body (paints over art below) |
| `ink` | key-block ink: pupils, mouths, dark markings |
| `paper` | paper: eye whites, highlights |
| `cut` | a gouge: paper on dark tiles, ink on light ones (scales, feathers, fin rays) |
| `accent` | a palette colour no tile class is using: patches, beaks, wing bars |
| `shade` / `light` | the fill pushed towards ink or towards paper: bellies, mantles, shells |

**Height** (optional) is a relief hint for surfaces that light the print: `dome` is 0–1, and
`parts` holds −1 (carved) to 1 (raised) per art part.

## The four types

Every type pairs its edges, so a bump on one edge is a dent somewhere else. That's how the space
between neighbours becomes another body part: one koi's snout is the next koi's tail fork. Only the
free edges are data; the preview draws the derived ones dashed.

```
TTTTTT (p1, translations only)          TGTG (pg, glide rows)
      V4 ____e3____ V3                  V3 ______e2______ V2      e2 = e0 mirrored in the
        /          \                      |                |      vertical axis, moved up h
    e4 /            \ e2                e3|      -->       |e1    e3 = e1 moved left w
      /              \                    |                |      rows alternate direction
  V5  \              / V2               V0 ------e0------ V1
       \            /                   free: e0 (belly), e1 (snout)
    e5  \          / e1                 corners: w, h, s (shear of the top)
         \___e0___/                     Tile frame default: unit square.
       V0          V1
  e3 = e0, e4 = e1, e5 = e2, each moved across (reversed): all tiles face the same way.
  free: e0, e1, e2;  corners: v1, v2, v3 (V0 is the origin; V4 = V3 − V1, V5 = V3 − V2)

C4 (p4, quarter turns)                  C3 (p3, third turns)
  V3 ____e2____ V2 (4-fold)                  V4 ____e3____ V3      V0, V2, V4: 3-fold centres
    |          |    e2 = e1 turned           (3)        \          e5 = e0 turned about V0
  e3|          |e1  −90° about V2      e4 /              \ e2      e1 = e2 turned about V2
    |          |    e3 = e0 turned       /                \        e3 = e4 turned about V4
  V0 ----e0---- V1  +90° about V0    V5 \               (3) V2     free: e0, e2, e4
 (4-fold)  (2-fold V1, V3)               \              /          corner: v1 (V5, V3 follow)
  free: e0, e1; no corners                \____e0_____/
  4 tiles turn about V0 and V2         (3) V0           V1
```

## Designing a recognisable silhouette

- **Start from the animal's most iconic outline** (snout, ears, wings, flippers, tail) and decide
  which edge carries it. The pairing decides where the matching dent lands: plan bumps and dents
  together. A bump of size *s* on an edge is a dent of size *s* on its partner.
- **TTTTTT**: everything faces the same way, which is good for flocks and schools. The head on e3 nests in
  the tail on e0 of the animal ahead, so a forked tail is natural (the seed is a tern, not a gull, for
  that reason). By the half-turn pairing, the right leading edge (e2) becomes the left trailing
  edge (e5): a wrist bump 40 % out on one wing is a notch 60 % out on the other. Use the corners
  for wide wings.
- **TGTG**: rows swim in opposite directions. The snout (e1) nests in the tail fork of the animal
  ahead (e3). The back (e2) is the belly (e0) mirrored about x = (w + s)/2 and moved up, keeping its
  vertical direction. So a belly bulge at x makes a dent in the back at (w + s) − x, and a belly
  dent there makes a back bump. Pair a belly bulge at x with a belly dent at (w + s) − x to swell
  the body above and below at once. TGTG suits fish and flatfish.
- **C4**: four animals turn about V0 and V2, like a pinwheel. A dent in e1 near V1 or V2 is a bump
  on e2 near V3 or V2, so flippers and legs come in turned pairs. Put the head mid-e1 and the
  tail mid-e3 (from a dent mid-e0).
- **C3**: three animals meet at V0, V2 and V4, where the interior angle is always 120°, so no
  sharp tips there. Spread-limbed animals fit, with features at V1, V3 and V5. The relations
  allow an exactly mirror-symmetric animal about the V0–V3 diagonal: make e4 equal to e2 with v
  negated, and e0 straight (the bat does this). Avoid lizards and other reptiles in C3: that is
  the best-known historical p3 design.
- **Read it small.** At Metamorphosis' scale a tile is about 150 px. Exaggerate the silhouette, keep
  necks at least 0.05 wide (the check warns), and let the art do the detail: eyes, mouths, gills,
  feathers, shells. An eye (paper + ink pupil) does more for recognition than anything else.
- The engine's gouges follow each tile's outline. Big plain areas look carved, so you need less
  art than you think.

## Morphing

Species morph directly when they are **compatible**: same `type`, and per free edge the same
kind and the same number of points (the sig in the sheet's header, e.g. `TGTG e0=s9 e1=s4`).
Corners and edge points blend linearly, so every blend is a tile of the type. It is a *valid*
tile only if it doesn't cross itself, which `check` tests at 25/50/75 %. To make blends
clean, give corresponding points corresponding roles: point 3 of the koi's belly and point 3 of
the halibut's belly should both be, say, the anal fin. The art cross-fades: the old species'
art erodes away while the new one's grows in.

Incompatible species (another type, or other counts) change through the plain tiles, with the
print dipping to its mean colour at the swap. Within a group, about every third change changes
type. If you want your species to morph with a group-mate, copy its edge structure (the counts)
and reshape the points.

## Naming and registering

- File: `tiles/<group>/<name>.json`, lowercase letters, digits and `-` (`moray-eel.json`); the id
  is `<group>/<name>`. `name` inside is the common name.
- Registering is the folder: add the file, then run `uv run python -m tools.tiles index`, which rewrites
  `<group>/index.json`. Each group has its own index, so designers working on different groups never
  touch the same file. The manifest's Creatures options are the groups and never change.
- Then run `check` on everything, plus pytest and vitest (above), and commit the species and the
  group index together. Don't edit the seeds' shapes without `uv run python -m tools.tiles golden`:
  tests/fixtures/tiles_golden.json pins the seeds' outlines, the Python and JS geometry's shared
  test.
