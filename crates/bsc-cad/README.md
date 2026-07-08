# bsc-cad

A Rust-native **mesh/SDF geometry kernel** (#2621) — the foundation for the Design Studio's
AI-authored 3D objects. Instead of depending on a heavy B-rep kernel (OCCT), an object is a small
**declarative op-tree** the AI writes; the kernel evaluates it as a signed-distance field and
polygonizes it to a watertight mesh.

```text
op-tree (JSON, mm)  →  SDF  →  surface-nets mesh  →  binary STL
```

Everything is **millimetres**. Fillets are the SDF smooth-min (`smooth_union`) — the hardest B-rep
operation, nearly free here.

## Try it

```bash
cargo run -p bsc-cad -- crates/bsc-cad/examples/bracket.json -o bracket.stl --res 128
# open bracket.stl in any slicer / 3D viewer
```

You'll see stats like bounds (mm), triangle count, **watertight true/false**, and volume.

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

Foundation spike. **Next:** feature-preserving dual contouring (crisp edges), sketch→extrude/revolve,
shell/pattern/fillet ops, glTF for the in-app preview, and folding into the unified `bsc cad`
subcommand. Trade-offs vs true CAD (no STEP / named topology / drawings) are tracked on #2621;
splitting this into its own publishable package is icebox #2620.
