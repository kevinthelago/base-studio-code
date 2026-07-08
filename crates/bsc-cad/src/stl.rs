//! Binary STL export (#2621). STL is unitless by convention millimetres — which is exactly our model
//! unit, so there's no conversion. Every slicer/CAD viewer reads binary STL; per-facet normals are the
//! triangle's geometric normal (viewers/slicers recompute anyway).
use crate::mesh::Mesh;

/// Encode `mesh` as a binary STL blob (80-byte header · u32 count · 50 bytes/triangle).
pub fn to_binary_stl(mesh: &Mesh) -> Vec<u8> {
    let mut out = Vec::with_capacity(84 + mesh.triangles.len() * 50);
    out.extend_from_slice(&[0u8; 80]); // header (ignored by readers)
    out.extend_from_slice(&(mesh.triangles.len() as u32).to_le_bytes());
    for t in &mesh.triangles {
        let a = mesh.positions[t[0] as usize];
        let b = mesh.positions[t[1] as usize];
        let c = mesh.positions[t[2] as usize];
        let normal = (b - a).cross(c - a).normalize();
        for v in [normal, a, b, c] {
            out.extend_from_slice(&(v.x as f32).to_le_bytes());
            out.extend_from_slice(&(v.y as f32).to_le_bytes());
            out.extend_from_slice(&(v.z as f32).to_le_bytes());
        }
        out.extend_from_slice(&0u16.to_le_bytes()); // attribute byte count
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Mesh;
    use crate::math::Vec3;

    #[test]
    fn binary_stl_has_the_right_length() {
        let mesh = Mesh {
            positions: vec![Vec3::ZERO, Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.0, 1.0, 0.0)],
            triangles: vec![[0, 1, 2]],
        };
        // 80 header + 4 count + 1 triangle * 50 bytes.
        assert_eq!(to_binary_stl(&mesh).len(), 84 + 50);
    }
}
