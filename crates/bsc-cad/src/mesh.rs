//! Polygonization (#2621) — naive **surface nets** over the op-tree's SDF. Surface nets is a dual
//! method: one vertex per surface-straddling cell (placed at the mean of its edge zero-crossings),
//! quads across grid edges where the field changes sign. It's simple, watertight, and produces smooth
//! meshes — the natural first rung. Feature-preserving **dual contouring** (sharp edges from the
//! field's gradient) is the planned upgrade; winding is geometric-normal-consistent per triangle, so
//! the SHAPE is correct today even before that polish.
use crate::math::Vec3;
use crate::node::Node;
use std::collections::HashMap;

/// A triangle mesh in millimetres.
pub struct Mesh {
    pub positions: Vec<Vec3>,
    pub triangles: Vec<[u32; 3]>,
}

impl Mesh {
    pub fn is_empty(&self) -> bool {
        self.triangles.is_empty()
    }
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }
    /// Enclosed volume (mm³) via the signed-tetrahedron (divergence) sum; `abs` so winding can't flip
    /// the sign.
    pub fn volume(&self) -> f64 {
        let mut v = 0.0;
        for t in &self.triangles {
            let a = self.positions[t[0] as usize];
            let b = self.positions[t[1] as usize];
            let c = self.positions[t[2] as usize];
            v += a.dot(b.cross(c));
        }
        (v / 6.0).abs()
    }
    /// Watertight ⇔ every undirected edge is shared by exactly two triangles (a closed 2-manifold).
    pub fn is_watertight(&self) -> bool {
        if self.triangles.is_empty() {
            return false;
        }
        let mut counts: HashMap<(u32, u32), u32> = HashMap::new();
        for t in &self.triangles {
            for &(i, j) in &[(t[0], t[1]), (t[1], t[2]), (t[2], t[0])] {
                let e = if i < j { (i, j) } else { (j, i) };
                *counts.entry(e).or_insert(0) += 1;
            }
        }
        counts.values().all(|&c| c == 2)
    }
}

/// A cell-corner offset (0/1 on each axis).
type CornerOffset = (usize, usize, usize);

/// The 12 edges of a cell, as pairs of corner offsets (grouped x-, y-, z-aligned).
const CELL_EDGES: [(CornerOffset, CornerOffset); 12] = [
    ((0, 0, 0), (1, 0, 0)),
    ((0, 1, 0), (1, 1, 0)),
    ((0, 0, 1), (1, 0, 1)),
    ((0, 1, 1), (1, 1, 1)),
    ((0, 0, 0), (0, 1, 0)),
    ((1, 0, 0), (1, 1, 0)),
    ((0, 0, 1), (0, 1, 1)),
    ((1, 0, 1), (1, 1, 1)),
    ((0, 0, 0), (0, 0, 1)),
    ((1, 0, 0), (1, 0, 1)),
    ((0, 1, 0), (0, 1, 1)),
    ((1, 1, 0), (1, 1, 1)),
];

/// Polygonize `node` with ~`resolution` cells along its longest axis. The bounds are padded by two
/// cells so the surface is fully interior — every surface edge then has four adjacent cells, which is
/// what makes the output watertight.
pub fn polygonize(node: &Node, resolution: usize) -> Mesh {
    let empty = Mesh { positions: vec![], triangles: vec![] };
    let res = resolution.max(1);
    let bounds = node.bbox();
    if bounds.is_empty() {
        return empty;
    }
    let cell = (bounds.size().max_component() / res as f64).max(1e-6);
    let b = bounds.expand(cell * 2.0);
    let size = b.size();
    let nx = ((size.x / cell).ceil() as usize + 1).max(2);
    let ny = ((size.y / cell).ceil() as usize + 1).max(2);
    let nz = ((size.z / cell).ceil() as usize + 1).max(2);

    let corner = |i: usize, j: usize, k: usize| -> Vec3 {
        b.min + Vec3::new(i as f64 * cell, j as f64 * cell, k as f64 * cell)
    };
    let sidx = |i: usize, j: usize, k: usize| (i * ny + j) * nz + k;

    // Sample the field at every grid corner.
    let mut field = vec![0.0f64; nx * ny * nz];
    for i in 0..nx {
        for j in 0..ny {
            for k in 0..nz {
                field[sidx(i, j, k)] = node.sdf(corner(i, j, k));
            }
        }
    }

    // One vertex per straddling cell (indexed by its minimum corner), at the mean edge crossing.
    let cidx = |i: usize, j: usize, k: usize| (i * (ny - 1) + j) * (nz - 1) + k;
    let mut cell_vert = vec![u32::MAX; (nx - 1) * (ny - 1) * (nz - 1)];
    let mut positions: Vec<Vec3> = Vec::new();
    for i in 0..nx - 1 {
        for j in 0..ny - 1 {
            for k in 0..nz - 1 {
                let mut sum = Vec3::ZERO;
                let mut n = 0u32;
                for (a, c) in CELL_EDGES {
                    let va = field[sidx(i + a.0, j + a.1, k + a.2)];
                    let vc = field[sidx(i + c.0, j + c.1, k + c.2)];
                    if (va < 0.0) != (vc < 0.0) {
                        let t = va / (va - vc);
                        let pa = corner(i + a.0, j + a.1, k + a.2);
                        let pc = corner(i + c.0, j + c.1, k + c.2);
                        sum = sum + (pa + (pc - pa) * t);
                        n += 1;
                    }
                }
                if n > 0 {
                    cell_vert[cidx(i, j, k)] = positions.len() as u32;
                    positions.push(sum * (1.0 / n as f64));
                }
            }
        }
    }

    // Faces: each interior grid edge with a sign change quads the four cells around it.
    let mut triangles: Vec<[u32; 3]> = Vec::new();
    let mut quad = |v: [u32; 4], flip: bool| {
        if v.contains(&u32::MAX) {
            return;
        }
        let [a, b2, c, d] = v;
        if flip {
            triangles.push([a, c, b2]);
            triangles.push([a, d, c]);
        } else {
            triangles.push([a, b2, c]);
            triangles.push([a, c, d]);
        }
    };

    // x-aligned edges — the four sharing cells fix i, vary j/k.
    for i in 0..nx - 1 {
        for j in 1..ny - 1 {
            for k in 1..nz - 1 {
                let v0 = field[sidx(i, j, k)];
                let v1 = field[sidx(i + 1, j, k)];
                if (v0 < 0.0) != (v1 < 0.0) {
                    let v = [
                        cell_vert[cidx(i, j - 1, k - 1)],
                        cell_vert[cidx(i, j, k - 1)],
                        cell_vert[cidx(i, j, k)],
                        cell_vert[cidx(i, j - 1, k)],
                    ];
                    quad(v, v0 < 0.0);
                }
            }
        }
    }
    // y-aligned edges (handedness flips the winding condition).
    for i in 1..nx - 1 {
        for j in 0..ny - 1 {
            for k in 1..nz - 1 {
                let v0 = field[sidx(i, j, k)];
                let v1 = field[sidx(i, j + 1, k)];
                if (v0 < 0.0) != (v1 < 0.0) {
                    let v = [
                        cell_vert[cidx(i - 1, j, k - 1)],
                        cell_vert[cidx(i, j, k - 1)],
                        cell_vert[cidx(i, j, k)],
                        cell_vert[cidx(i - 1, j, k)],
                    ];
                    quad(v, v0 >= 0.0);
                }
            }
        }
    }
    // z-aligned edges.
    for i in 1..nx - 1 {
        for j in 1..ny - 1 {
            for k in 0..nz - 1 {
                let v0 = field[sidx(i, j, k)];
                let v1 = field[sidx(i, j, k + 1)];
                if (v0 < 0.0) != (v1 < 0.0) {
                    let v = [
                        cell_vert[cidx(i - 1, j - 1, k)],
                        cell_vert[cidx(i, j - 1, k)],
                        cell_vert[cidx(i, j, k)],
                        cell_vert[cidx(i - 1, j, k)],
                    ];
                    quad(v, v0 < 0.0);
                }
            }
        }
    }

    Mesh { positions, triangles }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_meshes_watertight_with_reasonable_volume() {
        let cube = Node::Box { size: [20.0, 20.0, 20.0] };
        let m = polygonize(&cube, 40);
        assert!(!m.is_empty(), "a solid box must mesh");
        assert!(m.is_watertight(), "surface nets over a padded interior must close");
        // True volume 8000 mm³; surface nets approximates, so allow a modest tolerance.
        let v = m.volume();
        assert!((v - 8000.0).abs() / 8000.0 < 0.1, "volume {v} off by >10%");
    }

    #[test]
    fn drilled_plate_meshes() {
        let plate = Node::Difference {
            base: Box::new(Node::Box { size: [30.0, 30.0, 4.0] }),
            tools: vec![Node::Cylinder { r: 4.0, h: 10.0 }],
        };
        let m = polygonize(&plate, 48);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "a through-hole leaves a closed 2-manifold");
    }

    #[test]
    fn empty_bounds_yield_empty_mesh() {
        // An intersection of two disjoint solids has an empty bound → no geometry, no panic.
        let disjoint = Node::Intersect {
            nodes: vec![
                Node::Translate { by: [100.0, 0.0, 0.0], node: Box::new(Node::Sphere { r: 1.0 }) },
                Node::Translate { by: [-100.0, 0.0, 0.0], node: Box::new(Node::Sphere { r: 1.0 }) },
            ],
        };
        assert!(polygonize(&disjoint, 16).is_empty());
    }
}
