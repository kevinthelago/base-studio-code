//! glTF 2.0 export (#3389) — the format the Design Studio's preview can actually *render*. STL
//! ([`crate::stl`]) stays the maker/slicer interchange; glTF is the viewer format: indexed vertices,
//! per-vertex normals for shading, and a scene graph, so a WebGL surface can draw the mesh without
//! re-deriving anything.
//!
//! Two containers, one builder:
//!   * [`to_gltf_json`] — a self-contained `.gltf` **text** file whose single buffer is an embedded
//!     `data:` URI. Costs ~33% in base64 but needs no GLB chunk parsing and no second fetch, which is
//!     what makes it the friendly shape for the app's CSP-restricted, offline WebView.
//!   * [`to_glb`]      — the standard binary `.glb` container (JSON chunk + BIN chunk). Compact, and
//!     what every external viewer/engine expects.
//!
//! ## Coordinate systems — the conversion is a NODE MATRIX, not baked into the vertices
//! The kernel is **millimetres, Z-up**; glTF is **metres, Y-up**. Rather than mutating vertex data, the
//! scene node carries a scale(0.001) ∘ rotate(-90° about X) matrix. Two things fall out of that: the
//! POSITION accessor's `min`/`max` stay in the kernel's own mm frame (so they are directly comparable
//! to the `bounds_mm` the CLI reports — a mismatch is a real bug, not a unit artifact), and a viewer
//! that ignores the node transform still gets correctly-shaped geometry, just mm-scaled. The matrix is
//! a similarity (uniform scale + rotation), so the untransformed normals stay correct under it and the
//! positive determinant preserves triangle winding.
//!
//! ## An empty mesh is not an error
//! A spec that polygonizes to zero triangles yields a valid glTF with an empty scene rather than a file
//! with zero-count accessors — glTF requires `count >= 1`, so the empty case must drop the buffer
//! entirely. Same contract as the STL path: "your spec describes nothing" is an outcome, not a failure.
use crate::math::Vec3;
use crate::mesh::Mesh;
use serde_json::{json, Value};

/// Kernel unit (mm) → glTF unit (m).
const MM_TO_M: f64 = 0.001;

const COMPONENT_FLOAT: u32 = 5126;
const COMPONENT_UNSIGNED_INT: u32 = 5125;
const TARGET_ARRAY_BUFFER: u32 = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER: u32 = 34963;
/// Primitive mode 4 = TRIANGLES.
const MODE_TRIANGLES: u32 = 4;

/// The scene node's transform, **column-major** as glTF requires: scale by [`MM_TO_M`], then rotate
/// -90° about X so the kernel's +Z (up) lands on glTF's +Y (up) and +Y lands on -Z.
///
/// Column-major means the array reads as four columns, so the row-major matrix
/// `[[s,0,0,0], [0,0,s,0], [0,-s,0,0], [0,0,0,1]]` transposes into the layout below.
fn node_matrix() -> [f64; 16] {
    let s = MM_TO_M;
    [
        s, 0.0, 0.0, 0.0, // column 0
        0.0, 0.0, -s, 0.0, // column 1
        0.0, s, 0.0, 0.0, // column 2
        0.0, 0.0, 0.0, 1.0, // column 3
    ]
}

/// Area-weighted smooth vertex normals.
///
/// The cross product of two triangle edges has magnitude `2 × area`, so accumulating it **unnormalized**
/// weights each face's contribution by its area for free — big faces dominate, slivers barely register.
/// A vertex whose faces cancel exactly (or that no triangle references) has no defined normal; it gets
/// +Z rather than a zero vector, because a zero normal renders as a black hole in most shaders.
fn vertex_normals(mesh: &Mesh) -> Vec<Vec3> {
    let mut normals = vec![Vec3::ZERO; mesh.positions.len()];
    for t in &mesh.triangles {
        let a = mesh.positions[t[0] as usize];
        let b = mesh.positions[t[1] as usize];
        let c = mesh.positions[t[2] as usize];
        let face = (b - a).cross(c - a);
        for &i in t {
            normals[i as usize] = normals[i as usize] + face;
        }
    }
    normals
        .into_iter()
        .map(|n| {
            let unit = n.normalize();
            if unit.length() > 0.0 {
                unit
            } else {
                Vec3::new(0.0, 0.0, 1.0)
            }
        })
        .collect()
}

/// The binary payload plus everything the JSON needs to describe it.
struct Buffers {
    /// positions ‖ normals ‖ indices, little-endian, each section 4-byte aligned by construction.
    bin: Vec<u8>,
    positions_len: usize,
    normals_offset: usize,
    normals_len: usize,
    indices_offset: usize,
    indices_len: usize,
    vertex_count: usize,
    index_count: usize,
    /// POSITION accessor bounds, in the kernel's mm frame, computed from the **f32** values actually
    /// written (the spec requires min/max to bound the stored data, not the f64 originals).
    min: [f32; 3],
    max: [f32; 3],
}

fn build_buffers(mesh: &Mesh) -> Buffers {
    let normals = vertex_normals(mesh);
    let vertex_count = mesh.positions.len();
    let index_count = mesh.triangles.len() * 3;

    let mut bin: Vec<u8> = Vec::with_capacity(vertex_count * 24 + index_count * 4);
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];

    for p in &mesh.positions {
        for (axis, v) in [p.x, p.y, p.z].iter().enumerate() {
            let f = *v as f32;
            min[axis] = min[axis].min(f);
            max[axis] = max[axis].max(f);
            bin.extend_from_slice(&f.to_le_bytes());
        }
    }
    let positions_len = vertex_count * 12;

    let normals_offset = bin.len();
    for n in &normals {
        for v in [n.x, n.y, n.z] {
            bin.extend_from_slice(&(v as f32).to_le_bytes());
        }
    }
    let normals_len = bin.len() - normals_offset;

    let indices_offset = bin.len();
    for t in &mesh.triangles {
        for &i in t {
            bin.extend_from_slice(&i.to_le_bytes());
        }
    }
    let indices_len = bin.len() - indices_offset;

    // A vertex-less mesh leaves min/max at their infinite seeds; zero them so the JSON stays finite.
    // (The empty case never reaches the JSON anyway — see `document` — but an infinity in a numeric
    // field would serialize as `null` and silently produce an unloadable file if it ever did.)
    if vertex_count == 0 {
        min = [0.0; 3];
        max = [0.0; 3];
    }

    Buffers {
        bin,
        positions_len,
        normals_offset,
        normals_len,
        indices_offset,
        indices_len,
        vertex_count,
        index_count,
        min,
        max,
    }
}

/// The glTF JSON document for `b`. `buffer_uri` is `Some(data-uri)` for the self-contained `.gltf`
/// form and `None` for GLB (where the BIN chunk is the buffer, and a `uri` is forbidden).
fn document(b: &Buffers, name: &str, buffer_uri: Option<String>) -> Value {
    let asset = json!({
        "version": "2.0",
        "generator": format!("bsc-cad {} (bsc cad mesh --format gltf)", env!("CARGO_PKG_VERSION")),
    });

    // Nothing to draw: a valid document with an empty scene. Emitting accessors with count 0 here
    // would be spec-invalid and most viewers reject the whole file rather than the empty primitive.
    if b.index_count == 0 || b.vertex_count == 0 {
        return json!({
            "asset": asset,
            "scene": 0,
            "scenes": [{ "name": name, "nodes": [] }],
        });
    }

    let mut buffer = json!({ "byteLength": b.bin.len() });
    if let Some(uri) = buffer_uri {
        buffer["uri"] = json!(uri);
    }

    json!({
        "asset": asset,
        "scene": 0,
        "scenes": [{ "name": name, "nodes": [0] }],
        "nodes": [{ "name": name, "mesh": 0, "matrix": node_matrix() }],
        "meshes": [{
            "name": name,
            "primitives": [{
                "attributes": { "POSITION": 0, "NORMAL": 1 },
                "indices": 2,
                "material": 0,
                "mode": MODE_TRIANGLES,
            }],
        }],
        // A neutral, slightly-glossy grey. A primitive with no material renders with the viewer's
        // default (often flat white or magenta), which reads as "broken" rather than "a part".
        "materials": [{
            "name": "bsc-cad",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.72, 0.74, 0.78, 1.0],
                "metallicFactor": 0.1,
                "roughnessFactor": 0.55,
            },
            "doubleSided": false,
        }],
        "accessors": [
            {
                "bufferView": 0,
                "byteOffset": 0,
                "componentType": COMPONENT_FLOAT,
                "count": b.vertex_count,
                "type": "VEC3",
                // Required on POSITION by the spec — viewers use it for framing/culling, and a wrong
                // one is the classic "renders nothing" bug.
                "min": b.min,
                "max": b.max,
            },
            {
                "bufferView": 1,
                "byteOffset": 0,
                "componentType": COMPONENT_FLOAT,
                "count": b.vertex_count,
                "type": "VEC3",
            },
            {
                "bufferView": 2,
                "byteOffset": 0,
                "componentType": COMPONENT_UNSIGNED_INT,
                "count": b.index_count,
                "type": "SCALAR",
            },
        ],
        "bufferViews": [
            { "buffer": 0, "byteOffset": 0, "byteLength": b.positions_len, "target": TARGET_ARRAY_BUFFER },
            { "buffer": 0, "byteOffset": b.normals_offset, "byteLength": b.normals_len, "target": TARGET_ARRAY_BUFFER },
            { "buffer": 0, "byteOffset": b.indices_offset, "byteLength": b.indices_len, "target": TARGET_ELEMENT_ARRAY_BUFFER },
        ],
        "buffers": [buffer],
    })
}

/// Encode `mesh` as a self-contained `.gltf` document — the buffer is embedded as a base64 `data:` URI,
/// so the returned string is the whole model with no sidecar file and no second network fetch.
pub fn to_gltf_json(mesh: &Mesh, name: &str) -> String {
    let b = build_buffers(mesh);
    let uri = (!b.bin.is_empty())
        .then(|| format!("data:application/octet-stream;base64,{}", base64(&b.bin)));
    document(&b, name, uri).to_string()
}

/// Encode `mesh` as a binary `.glb`: a 12-byte header, then the JSON chunk, then the BIN chunk.
pub fn to_glb(mesh: &Mesh, name: &str) -> Vec<u8> {
    let b = build_buffers(mesh);
    let json_text = document(&b, name, None).to_string();

    // Both chunks are 4-byte aligned: JSON pads with spaces, BIN with zeros (the spec names those
    // exact fillers so a strict parser doesn't trip over the padding).
    let mut json_chunk = json_text.into_bytes();
    while !json_chunk.len().is_multiple_of(4) {
        json_chunk.push(b' ');
    }
    let mut bin_chunk = b.bin;
    while !bin_chunk.len().is_multiple_of(4) {
        bin_chunk.push(0);
    }

    let has_bin = !bin_chunk.is_empty();
    let bin_total = if has_bin { 8 + bin_chunk.len() } else { 0 };
    let total = 12 + 8 + json_chunk.len() + bin_total;

    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());

    out.extend_from_slice(&(json_chunk.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_chunk);

    if has_bin {
        out.extend_from_slice(&(bin_chunk.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&bin_chunk);
    }
    out
}

/// Standard base64 (RFC 4648, `+/` alphabet, `=` padded). Hand-rolled to keep the kernel
/// dependency-free — it is 20 lines, and the crate's whole point is a lean WASM-friendly build.
fn base64(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::Node;
    use crate::{polygonize, Mesh};

    /// A single triangle — small enough that every byte offset is checkable by hand.
    fn tri() -> Mesh {
        Mesh {
            positions: vec![Vec3::ZERO, Vec3::new(2.0, 0.0, 0.0), Vec3::new(0.0, 4.0, 0.0)],
            triangles: vec![[0, 1, 2]],
        }
    }

    fn doc(mesh: &Mesh) -> Value {
        serde_json::from_str(&to_gltf_json(mesh, "part")).expect("emitted glTF must be valid JSON")
    }

    #[test]
    fn accessor_counts_match_the_mesh() {
        let m = polygonize(&Node::Box { size: [20.0, 20.0, 20.0] }, 24);
        let d = doc(&m);
        let acc = &d["accessors"];
        // The invariant a viewer depends on: POSITION/NORMAL are per-vertex and indices are 3/triangle.
        assert_eq!(acc[0]["count"], m.positions.len());
        assert_eq!(acc[1]["count"], m.positions.len());
        assert_eq!(acc[2]["count"], m.triangle_count() * 3);
        assert_eq!(acc[0]["type"], "VEC3");
        assert_eq!(acc[2]["type"], "SCALAR");
        assert_eq!(acc[2]["componentType"], COMPONENT_UNSIGNED_INT);
    }

    #[test]
    fn buffer_bytelength_is_exactly_what_the_accessors_declare() {
        // The other half of "the viewer renders nothing": accessors that describe more data than the
        // buffer holds. byteLength must be positions(12B/v) + normals(12B/v) + indices(4B/i), and the
        // views must tile it end to end with no gap and no overlap.
        let m = polygonize(&Node::Sphere { r: 8.0 }, 20);
        let d = doc(&m);
        let v = m.positions.len();
        let i = m.triangle_count() * 3;
        assert_eq!(d["buffers"][0]["byteLength"], v * 24 + i * 4);

        let views = d["bufferViews"].as_array().unwrap();
        assert_eq!(views[0]["byteOffset"], 0);
        assert_eq!(views[0]["byteLength"], v * 12);
        assert_eq!(views[1]["byteOffset"], v * 12);
        assert_eq!(views[1]["byteLength"], v * 12);
        assert_eq!(views[2]["byteOffset"], v * 24);
        assert_eq!(views[2]["byteLength"], i * 4);
        assert_eq!(views[2]["target"], TARGET_ELEMENT_ARRAY_BUFFER);
    }

    #[test]
    fn position_bounds_match_the_mesh_extent_in_mm() {
        // min/max stay in the kernel's mm frame (the unit conversion is on the node matrix), so they
        // are directly comparable to the analytic bbox the CLI reports as bounds_mm.
        let m = polygonize(&Node::Box { size: [40.0, 24.0, 4.0] }, 32);
        let d = doc(&m);
        let min: Vec<f64> = serde_json::from_value(d["accessors"][0]["min"].clone()).unwrap();
        let max: Vec<f64> = serde_json::from_value(d["accessors"][0]["max"].clone()).unwrap();

        for axis in 0..3 {
            let lo = m.positions.iter().map(|p| [p.x, p.y, p.z][axis]).fold(f64::MAX, f64::min);
            let hi = m.positions.iter().map(|p| [p.x, p.y, p.z][axis]).fold(f64::MIN, f64::max);
            assert!((min[axis] - lo).abs() < 1e-3, "axis {axis}: min {} vs {lo}", min[axis]);
            assert!((max[axis] - hi).abs() < 1e-3, "axis {axis}: max {} vs {hi}", max[axis]);
        }
        // …and that extent is the part's size (surface nets lands within a cell of the analytic bbox).
        let tol = 40.0 / 32.0 * 2.0;
        for (axis, expected) in [40.0, 24.0, 4.0].iter().enumerate() {
            assert!((max[axis] - min[axis] - expected).abs() < tol, "axis {axis} extent");
        }
    }

    #[test]
    fn every_index_is_in_range_and_normals_are_unit_length() {
        // A viewer reading an out-of-range index gets undefined vertices (garbage or nothing), and a
        // zero-length normal shades black — both look like "the exporter works" from Rust alone.
        let m = polygonize(&Node::Cylinder { r: 6.0, h: 10.0 }, 20);
        let v = m.positions.len() as u32;
        for t in &m.triangles {
            for &i in t {
                assert!(i < v, "index {i} out of range for {v} vertices");
            }
        }
        for n in vertex_normals(&m) {
            assert!((n.length() - 1.0).abs() < 1e-9, "normal not unit: {n:?}");
        }
    }

    #[test]
    fn the_node_matrix_takes_mm_z_up_to_metres_y_up() {
        let m = node_matrix();
        // Column-major: apply to (x,y,z,1) and check the kernel's +Z becomes glTF's +Y.
        let apply = |p: [f64; 3]| {
            let mut o = [0.0; 3];
            for (row, slot) in o.iter_mut().enumerate() {
                *slot = m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row];
            }
            o
        };
        assert_eq!(apply([1000.0, 0.0, 0.0]), [1.0, 0.0, 0.0], "1000 mm on X = 1 m on X");
        assert_eq!(apply([0.0, 1000.0, 0.0]), [0.0, 0.0, -1.0], "kernel +Y → glTF -Z");
        assert_eq!(apply([0.0, 0.0, 1000.0]), [0.0, 1.0, 0.0], "kernel +Z (up) → glTF +Y (up)");
        // Positive determinant ⇒ handedness (and therefore triangle winding) is preserved.
        let det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9])
            + m[8] * (m[1] * m[6] - m[2] * m[5]);
        assert!(det > 0.0, "the transform must not mirror the part");
    }

    #[test]
    fn glb_container_framing_is_well_formed() {
        let bytes = to_glb(&tri(), "part");
        assert_eq!(&bytes[0..4], b"glTF");
        assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 2, "glTF 2.0");
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize,
            bytes.len(),
            "the header's total length must be the file's real length"
        );

        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        assert_eq!(&bytes[16..20], b"JSON");
        assert_eq!(json_len % 4, 0, "chunks are 4-byte aligned");
        let json: Value = serde_json::from_slice(&bytes[20..20 + json_len]).unwrap();
        assert_eq!(json["asset"]["version"], "2.0");
        assert!(json["buffers"][0]["uri"].is_null(), "a GLB buffer must NOT carry a uri");

        let bin_at = 20 + json_len;
        let bin_len = u32::from_le_bytes(bytes[bin_at..bin_at + 4].try_into().unwrap()) as usize;
        assert_eq!(&bytes[bin_at + 4..bin_at + 8], b"BIN\0");
        // 3 vertices × (12 B position + 12 B normal) + 3 indices × 4 B.
        assert_eq!(bin_len, 3 * 24 + 3 * 4);
        assert_eq!(json["buffers"][0]["byteLength"], bin_len);
        assert_eq!(bin_at + 8 + bin_len, bytes.len(), "no trailing bytes");
    }

    #[test]
    fn the_embedded_buffer_uri_decodes_to_the_declared_byte_count() {
        let d = doc(&tri());
        let uri = d["buffers"][0]["uri"].as_str().unwrap();
        let b64 = uri.strip_prefix("data:application/octet-stream;base64,").expect("data uri");
        // base64 is 4 chars per 3 bytes; with one '=' the payload is 3n-1 bytes, two '=' 3n-2.
        let pad = b64.chars().rev().take_while(|&c| c == '=').count();
        assert_eq!(b64.len() % 4, 0);
        assert_eq!(b64.len() / 4 * 3 - pad, 3 * 24 + 3 * 4);
        assert_eq!(d["buffers"][0]["byteLength"], 3 * 24 + 3 * 4);
    }

    #[test]
    fn base64_matches_the_rfc_test_vectors() {
        // The buffer is delivered THROUGH this encoder, so a bug here is a silently corrupt model.
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0xef, 0xfe]), "/+/+", "the +/ alphabet, not url-safe");
    }

    #[test]
    fn an_empty_mesh_is_a_valid_empty_scene_not_a_broken_file() {
        let empty = Mesh { positions: vec![], triangles: vec![] };
        let d = doc(&empty);
        assert_eq!(d["asset"]["version"], "2.0");
        assert_eq!(d["scenes"][0]["nodes"].as_array().unwrap().len(), 0);
        // Zero-count accessors are spec-invalid — the empty case must omit them entirely.
        assert!(d["accessors"].is_null(), "no accessors for an empty mesh");
        assert!(d["buffers"].is_null(), "no buffer for an empty mesh");

        // The GLB form of the same mesh is header + JSON chunk only, with no BIN chunk.
        let bytes = to_glb(&empty, "part");
        let json_len = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
        assert_eq!(bytes.len(), 20 + json_len, "an empty mesh emits no BIN chunk");
    }

    #[test]
    fn the_name_reaches_the_scene_node_and_mesh() {
        let d = doc(&tri());
        assert_eq!(d["scenes"][0]["name"], "part");
        assert_eq!(d["nodes"][0]["name"], "part");
        assert_eq!(d["meshes"][0]["name"], "part");
        assert_eq!(d["meshes"][0]["primitives"][0]["mode"], MODE_TRIANGLES);
        assert_eq!(d["meshes"][0]["primitives"][0]["attributes"]["POSITION"], 0);
        assert_eq!(d["meshes"][0]["primitives"][0]["indices"], 2);
    }
}
