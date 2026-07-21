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

Example — a plate with two bolt holes and a filleted upright (an L-bracket): see
[`examples/bracket.json`](examples/bracket.json).

## Status

Foundation (#2621) plus feature-preserving **dual contouring** (#3388), reached as the unified
`bsc cad` subcommand (#3387).

**Next:** sketch→extrude/revolve (the parametric authoring path) and the shell/pattern/fillet ops —
both still open on #3388 — then glTF for the in-app preview. Trade-offs vs true CAD (no STEP / named
topology / drawings) are tracked on #2621; splitting this into its own publishable package is icebox
#2620.
