# bsc-cad

A Rust-native **mesh/SDF geometry kernel** (#2621) — the foundation for the Design Studio's
AI-authored 3D objects. Instead of depending on a heavy B-rep kernel (OCCT), an object is a small
**declarative op-tree** the AI writes; the kernel evaluates it as a signed-distance field and
polygonizes it to a watertight mesh.

```text
op-tree (JSON, mm)  →  SDF  →  dual-contouring mesh  →  binary STL
```

Everything is **millimetres**. Fillets are the SDF smooth-min (`smooth_union`) — the hardest B-rep
operation, nearly free here.

## Try it

```bash
bsc cad mesh crates/bsc-cad/examples/bracket.json -o bracket.stl --res 128
# open bracket.stl in any slicer / 3D viewer
```

Sketch-based parts (#3425) mesh the same way — `examples/l-plate.json` is an `extrude` of a concave
L-shaped profile, `examples/bushing.json` a `revolve` of a stepped lathe profile:

```bash
bsc cad mesh crates/bsc-cad/examples/l-plate.json -o l-plate.stl
bsc cad mesh crates/bsc-cad/examples/bushing.json -o bushing.stl
```

Shell/pattern/fillet (#3426) each have a worked example too — `examples/shelled-box.json` (a hollowed
30 mm cube), `examples/bolt-pattern.json` (a plate drilled by a `linear_pattern` of 5 bolt holes), and
`examples/rounded-block.json` (a block with all edges filleted):

```bash
bsc cad mesh crates/bsc-cad/examples/shelled-box.json -o shelled-box.stl
bsc cad mesh crates/bsc-cad/examples/bolt-pattern.json -o bolt-pattern.stl
bsc cad mesh crates/bsc-cad/examples/rounded-block.json -o rounded-block.stl
```

You'll see stats like bounds (mm), triangle count, **watertight true/false**, volume, and the
**deviation** pair described below.

## Sharp features (#3388)

Polygonization is **dual contouring**, so edges and corners stay crisp. Each surface-straddling cell
keeps *hermite data* — every edge crossing plus the SDF gradient (surface normal) there — and the
cell's vertex is placed by solving the quadratic error function `min Σ (nᵢ·(x-pᵢ))²` for the point
that best satisfies all those tangent planes (`src/qef.rs`). A flat patch is under-determined and
falls back to the mean of the crossings; an edge or corner is determined, and the vertex snaps to it.

The older **surface nets** placement — the mean of the crossings, unconditionally — is still
selectable with `--method surface-nets`, which rounds every sharp feature off. Keeping it makes the
difference measurable rather than asserted:

| 20 mm cube, `--res 32` | max deviation | volume (true 8000 mm³) |
|---|---|---|
| `--method dual` (default) | **0.0000 mm** | **8000.00 mm³** |
| `--method surface-nets` | 0.4167 mm | 7932.05 mm³ |

*Deviation* is how far a mesh vertex sits off the true surface (`max`/`mean` of `|SDF|`, reported by
`bsc cad mesh`). Surface nets' worst case is a fixed ~⅔ of a cell at **every** resolution — refining
the grid shrinks the rounded region but never sharpens the feature — while dual contouring resolves a
prismatic part exactly. The same shows up in the part's size: on a cube rotated off the grid axes,
dual contouring reproduces the analytic bounding box to 4 decimals while surface nets comes up
**1.72 mm short**, because the corner is literally shaved away.

`examples/sharp-block.json` is the worked case — a 45°-rotated octagonal prism with a diagonal
through-slot and two bolt holes, so no face or edge lines up with the sampling grid.

## Spec format (op-tree)

Each node is `{ "op": "<name>", ... }`:

| op | fields | meaning |
|---|---|---|
| `box` | `size: [x,y,z]` | axis-aligned box, full extents, centred |
| `sphere` | `r` | sphere |
| `cylinder` | `r, h` | z-axis capped cylinder, centred |
| `translate` | `by: [x,y,z]`, `node` | move |
| `rotate` | `deg`, `axis: [x,y,z]`, `node` | rotate |
| `scale` | `factor`, `node` | uniform scale |
| `union` | `nodes: [...]` | merge |
| `difference` | `base`, `tools: [...]` | `base` minus tools (holes/pockets) |
| `intersect` | `nodes: [...]` | overlap |
| `smooth_union` | `k`, `nodes: [...]` | merge with a fillet of radius ~`k` |
| `extrude` | `profile: [[x,y],...]`, `height` | sweep a closed 2D polygon along Z, centred on z=0 |
| `revolve` | `profile: [[x,y],...]` | sweep a closed 2D polygon a full 360° about Z (x = radius, y = height) |
| `shell` | `thickness`, `node` | hollow `node`, outer surface fixed, walls `thickness` mm |
| `linear_pattern` | `by: [x,y,z]`, `count`, `node` | `count` copies of `node`, stepped by `by` each time |
| `radial_pattern` | `axis: [x,y,z]`, `count`, `node` | `count` copies of `node`, spaced evenly around `axis` |
| `fillet` | `r`, `node` | round `node`'s own convex edges/corners with radius `r` (grows the envelope by `r`) |

Example — a plate with two bolt holes and a filleted upright (an L-bracket): see
[`examples/bracket.json`](examples/bracket.json).

## Sketch → extrude / revolve (#3425)

A `profile` is a flat, implicitly-closed 2D polygon (mm) — the same authoring move CAD calls a
*sketch*. `extrude` gives it depth along Z; `revolve` spins it a full turn about Z, reading the
profile's `x` as radius and `y` as height (so a rectangular profile revolved is exactly a cylinder —
`examples/bushing.json` is a stepped lathe-part profile that isn't). Both reuse the kernel's existing
machinery end to end: [`sketch::profile_sdf`](src/sketch.rs) is a 2D signed distance (ray-cast inside
test + true nearest-edge distance), and `Extrude`/`Revolve` combine it with the same
outside-distance formula `Cylinder` already uses — so a square `extrude` and a rectangular `revolve`
are provably identical to `Box`/`Cylinder` at every sampled point (see `node.rs`'s tests).

## Shell / pattern / fillet (#3426)

- **`shell`** hollows a node to a wall thickness while leaving its OUTER surface exactly where it
  was: `max(d, -(d + thickness))`, the same `Difference`-shaped max/negate the kernel already uses,
  against an "inner wall" whose sdf is just the original shifted inward by `thickness`.
- **`linear_pattern`** / **`radial_pattern`** are a finite union of copies — `count` translated steps,
  or `count` copies spaced evenly around a full turn about an axis. Both are plain unions under the
  hood, so two overlapping copies blend the same way `union` always has (no special-casing).
- **`fillet` is NOT `smooth_union`.** `smooth_union` blends the SEAM between two or more *distinct*
  solids at their boolean join — applied to a single node it is a no-op. `fillet` rounds ONE solid's
  own convex edges/corners by dilating its whole surface outward (`sdf(p) - r`, iq's `opRound`): flat
  faces move out by `r`, convex edges/corners become radius-`r` fillets, concave edges stay sharp, and
  the part's overall envelope grows by `r` in every direction — a documented trade-off for working on
  *any* node, not just an analytic primitive whose own parameters can be pre-shrunk to compensate.

## Status

Foundation (#2621) plus feature-preserving **dual contouring** (#3388), the **sketch→extrude/revolve**
parametric authoring path (#3425), **shell/pattern/fillet** (#3426), and **glTF/GLB export** (#3389)
for the in-app preview — all reached as the unified `bsc cad` subcommand (#3387).

**Next:** wiring the glTF export into the Design Studio's right-pane preview (the UI half of #3389,
outside this crate). Trade-offs vs true CAD (no STEP / named topology / drawings) are tracked on
#2621; splitting this into its own publishable package is icebox #2620.
