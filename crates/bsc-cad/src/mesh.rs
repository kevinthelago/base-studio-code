//! Polygonization (#2621, sharp features #3388) — **dual contouring** over the op-tree's SDF, with the
//! original surface nets kept selectable for comparison.
//!
//! Both are *dual* methods and share this file's whole topology stage: one vertex per
//! surface-straddling cell, quads across grid edges where the field changes sign. That is what makes
//! the output watertight, and it is identical either way. They differ in ONE step — where the cell's
//! vertex goes:
//!
//! - [`Method::SurfaceNets`] puts it at the **mean** of the cell's edge crossings. Simple and smooth,
//!   but it rounds every sharp feature: the mean of points scattered around a cube's corner lies
//!   strictly inside the cube, so edges and corners get visibly shaved off.
//! - [`Method::DualContouring`] (the default) keeps **hermite data** — each crossing point plus the
//!   SDF gradient (the surface normal) there — and solves the quadratic error function in [`crate::qef`]
//!   for the point that best satisfies all those tangent planes at once. On a flat patch that
//!   reproduces surface nets; along an edge or at a corner it snaps to the true feature.
//!
//! The solved vertex is clamped into its own cell. Dual contouring's textbook failure is a vertex
//! flung far outside its cell by an ill-conditioned solve, which self-intersects the mesh; clamping
//! bounds the damage to "no worse than surface nets" while leaving every well-conditioned feature
//! exactly where it was solved. Winding is geometric-normal-consistent per triangle.
use crate::math::Vec3;
use crate::node::Node;
use crate::qef::{Qef, DEFAULT_TOL};
use std::collections::HashMap;

/// Which dual polygonizer places the cell vertices. The topology is the same either way.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Method {
    /// Feature-preserving: solve the hermite QEF per cell. The default — sharp edges survive.
    #[default]
    DualContouring,
    /// The original: the mean of the cell's edge crossings. Smooth, and rounds sharp features off.
    /// Kept so the difference is measurable rather than asserted.
    SurfaceNets,
}

impl Method {
    /// Parse the CLI spelling; hyphen/underscore and case are all accepted.
    pub fn parse(s: &str) -> Option<Method> {
        match s.to_ascii_lowercase().replace('_', "-").as_str() {
            "dual" | "dual-contouring" | "dc" => Some(Method::DualContouring),
            "nets" | "surface-nets" | "sn" => Some(Method::SurfaceNets),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Method::DualContouring => "dual-contouring",
            Method::SurfaceNets => "surface-nets",
        }
    }
}

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

    /// How far this mesh's vertices sit off the TRUE surface of `node`: `(max, mean)` of `|sdf(v)|`
    /// in mm. Zero would be a vertex exactly on the surface.
    ///
    /// This is the **sharp-feature metric** (#3388), and it is the honest way to compare
    /// polygonizers. Vertices on a flat face land on the surface under either method, so the mean
    /// stays small for both; it is the MAX that separates them, because rounding a sharp edge is
    /// precisely the act of pulling that cell's vertex off the surface and into the solid. Surface
    /// nets' worst-case deviation is set by the cell size (the mean of crossings around a corner sits
    /// a fraction of a cell inside), so it does not improve as the grid refines in the way a correct
    /// vertex placement does.
    pub fn surface_deviation(&self, node: &Node) -> (f64, f64) {
        if self.positions.is_empty() {
            return (0.0, 0.0);
        }
        let mut max = 0.0f64;
        let mut sum = 0.0f64;
        for &p in &self.positions {
            let d = node.sdf(p).abs();
            max = max.max(d);
            sum += d;
        }
        (max, sum / self.positions.len() as f64)
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

/// Locate the surface crossing on the segment `pa → pc`, given the field values at its ends.
///
/// The linear guess `t = va / (va - vc)` is exact for a planar face and good everywhere else, but on a
/// curved or blended surface it is off by enough to blunt the vertex placement — so it is refined by
/// regula falsi against the real field. The bracket is maintained by sign, and a bad secant step falls
/// back to bisection, so this cannot leave the segment or fail to terminate. Deterministic in its
/// inputs: the four cells sharing this edge each recompute it and get the identical point, which is
/// what keeps the mesh seamless.
fn crossing(node: &Node, pa: Vec3, pc: Vec3, va: f64, vc: f64) -> Vec3 {
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    let (mut flo, mut fhi) = (va, vc);
    let mut t = if (flo - fhi).abs() > 1e-300 { flo / (flo - fhi) } else { 0.5 };
    for _ in 0..8 {
        t = if t.is_finite() && t > lo && t < hi { t } else { 0.5 * (lo + hi) };
        let p = pa + (pc - pa) * t;
        let f = node.sdf(p);
        if f == 0.0 {
            return p;
        }
        if (f < 0.0) == (flo < 0.0) {
            lo = t;
            flo = f;
        } else {
            hi = t;
            fhi = f;
        }
        let denom = flo - fhi;
        if denom.abs() < 1e-300 {
            break;
        }
        t = lo + (hi - lo) * (flo / denom);
    }
    let t = if t.is_finite() { t.clamp(lo, hi) } else { 0.5 * (lo + hi) };
    pa + (pc - pa) * t
}

/// The surface normal at `p`: the normalized SDF gradient by central differences. `h` is scaled off
/// the cell size so the estimate is grid-relative rather than tied to the model's absolute size.
fn normal_at(node: &Node, p: Vec3, h: f64) -> Vec3 {
    let dx = Vec3::new(h, 0.0, 0.0);
    let dy = Vec3::new(0.0, h, 0.0);
    let dz = Vec3::new(0.0, 0.0, h);
    Vec3::new(
        node.sdf(p + dx) - node.sdf(p - dx),
        node.sdf(p + dy) - node.sdf(p - dy),
        node.sdf(p + dz) - node.sdf(p - dz),
    )
    .normalize()
}

/// Polygonize `node` with ~`resolution` cells along its longest axis, feature-preserving
/// ([`Method::DualContouring`]). See [`polygonize_with`] to pick the method.
pub fn polygonize(node: &Node, resolution: usize) -> Mesh {
    polygonize_with(node, resolution, Method::DualContouring)
}

/// Extra padding, as a fraction of one cell, beyond the plain 2-cell margin — deliberately NOT a
/// round number. A part authored with round mm dimensions at a round resolution (overwhelmingly the
/// common case) can otherwise put a grid CORNER exactly on one of the part's own flat faces: its
/// field value lands at exactly 0 (or a sub-epsilon floating-point wobble around it), an ambiguous
/// sign that neighboring cells can resolve inconsistently, seeding near-duplicate vertices that break
/// watertightness (observed on a revolve with round radii/heights at a round `--res`). This only needs
/// to be big enough to push an exactly-aligned corner's field value to an unambiguous, clearly-signed
/// value — many orders of magnitude below cell size, so it does not perturb genuine sharp-feature
/// precision (dual contouring's corner/edge placement is exact to a small fraction of a cell; see
/// `sharp_features_survive_on_non_grid_aligned_geometry`, whose tolerance a larger jitter would blow).
const GRID_JITTER: f64 = 1e-4;

/// Polygonize `node` with ~`resolution` cells along its longest axis using `method`. The bounds are
/// padded by (slightly more than) two cells so the surface is fully interior — every surface edge
/// then has four adjacent cells, which is what makes the output watertight.
pub fn polygonize_with(node: &Node, resolution: usize, method: Method) -> Mesh {
    let empty = Mesh { positions: vec![], triangles: vec![] };
    let res = resolution.max(1);
    let bounds = node.bbox();
    if bounds.is_empty() {
        return empty;
    }
    let cell = (bounds.size().max_component() / res as f64).max(1e-6);
    let b = bounds.expand(cell * (2.0 + GRID_JITTER));
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

    // One vertex per straddling cell (indexed by its minimum corner). Surface nets takes the mean of
    // the cell's edge crossings; dual contouring solves the hermite QEF and clamps into the cell.
    let cidx = |i: usize, j: usize, k: usize| (i * (ny - 1) + j) * (nz - 1) + k;
    let mut cell_vert = vec![u32::MAX; (nx - 1) * (ny - 1) * (nz - 1)];
    let mut positions: Vec<Vec3> = Vec::new();
    let grad_h = (cell * 1e-3).max(1e-9);
    for i in 0..nx - 1 {
        for j in 0..ny - 1 {
            for k in 0..nz - 1 {
                let mut sum = Vec3::ZERO;
                let mut n = 0u32;
                let mut qef = Qef::new();
                for (a, c) in CELL_EDGES {
                    let va = field[sidx(i + a.0, j + a.1, k + a.2)];
                    let vc = field[sidx(i + c.0, j + c.1, k + c.2)];
                    if (va < 0.0) != (vc < 0.0) {
                        let pa = corner(i + a.0, j + a.1, k + a.2);
                        let pc = corner(i + c.0, j + c.1, k + c.2);
                        let p = crossing(node, pa, pc, va, vc);
                        sum = sum + p;
                        n += 1;
                        if method == Method::DualContouring {
                            qef.add(p, normal_at(node, p, grad_h));
                        }
                    }
                }
                if n > 0 {
                    let mass = sum * (1.0 / n as f64);
                    let v = match method {
                        Method::SurfaceNets => mass,
                        // Clamp into the owning cell: an ill-conditioned solve must degrade to a
                        // surface-nets-quality vertex, never to a self-intersecting spike.
                        Method::DualContouring => {
                            let lo = corner(i, j, k);
                            let hi = corner(i + 1, j + 1, k + 1);
                            qef.solve(mass, DEFAULT_TOL).cmax(lo).cmin(hi)
                        }
                    };
                    cell_vert[cidx(i, j, k)] = positions.len() as u32;
                    positions.push(v);
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

    /// A cube 20 mm on a side, meshed at `res` cells along its longest axis.
    fn cube(res: usize, method: Method) -> Mesh {
        polygonize_with(&Node::Box { size: [20.0, 20.0, 20.0] }, res, method)
    }

    #[test]
    fn dual_contouring_keeps_edges_sharp_where_surface_nets_rounds_them() {
        // THE #3388 defect, measured. A cube's vertices should all sit ON the cube; surface nets pulls
        // the ones near an edge or corner inside (that IS the rounding), dual contouring does not.
        // The metric is max |SDF| over the mesh's vertices, in mm.
        let node = Node::Box { size: [20.0, 20.0, 20.0] };
        let res = 24;
        let cell = 20.0 / res as f64;

        let (sn_max, _) = cube(res, Method::SurfaceNets).surface_deviation(&node);
        let (dc_max, _) = cube(res, Method::DualContouring).surface_deviation(&node);

        // Surface nets' worst vertex is a sizeable fraction of a cell off the true surface...
        assert!(sn_max > 0.15 * cell, "surface nets should round the corners off: {sn_max}");
        // ...dual contouring's is down in the noise, because the QEF pins the edge/corner exactly.
        assert!(dc_max < 0.02 * cell, "dual contouring should hold the feature: {dc_max}");
        assert!(dc_max * 5.0 < sn_max, "sharpness must be a clear win, not a wash");
    }

    #[test]
    fn both_methods_agree_on_topology_and_stay_watertight() {
        // The methods differ ONLY in where a cell's vertex goes — the topology stage is shared. So
        // the triangle counts must match exactly, and neither may open a hole. If this ever fails,
        // dual contouring has changed the mesh's connectivity, which it must not.
        let sn = cube(20, Method::SurfaceNets);
        let dc = cube(20, Method::DualContouring);
        assert_eq!(sn.triangle_count(), dc.triangle_count(), "vertex placement changed topology");
        assert_eq!(sn.positions.len(), dc.positions.len());
        assert!(sn.is_watertight() && dc.is_watertight());
    }

    #[test]
    fn dual_contouring_volume_is_accurate_and_converges() {
        // Sharpness is not cosmetic: rounding the edges REMOVES material, so a rounded cube is
        // measurably undersized. The true volume is 8000 mm³.
        let err = |m: Mesh| (m.volume() - 8000.0).abs() / 8000.0;

        let coarse = err(cube(16, Method::DualContouring));
        let fine = err(cube(32, Method::DualContouring));
        assert!(coarse < 0.02, "even a coarse grid should be near-exact on a prismatic part: {coarse}");
        assert!(fine <= coarse + 1e-9, "refining must not make it worse: {coarse} → {fine}");
        // And it beats surface nets, which loses volume at every edge.
        assert!(fine < err(cube(32, Method::SurfaceNets)));
    }

    #[test]
    fn sharp_features_survive_on_non_grid_aligned_geometry() {
        // A cube aligned to the sampling grid is the easy case. Rotate it 30° about two axes so no
        // face or edge lines up with the lattice — the crossings then land at arbitrary points along
        // the cell edges, which is what actually stresses the QEF.
        let node = Node::Rotate {
            deg: 30.0,
            axis: [0.0, 0.0, 1.0],
            node: Box::new(Node::Rotate {
                deg: 30.0,
                axis: [1.0, 0.0, 0.0],
                node: Box::new(Node::Box { size: [20.0, 20.0, 20.0] }),
            }),
        };
        let dc = polygonize_with(&node, 32, Method::DualContouring);
        let sn = polygonize_with(&node, 32, Method::SurfaceNets);
        assert!(dc.is_watertight(), "a rotated solid must still close");
        let (dc_max, dc_mean) = dc.surface_deviation(&node);
        let (sn_max, sn_mean) = sn.surface_deviation(&node);
        let cell = node.bbox().size().max_component() / 32.0;

        // Off-axis, dual contouring does NOT hit the exact-zero it manages on a grid-aligned cube: a
        // corner whose solved position falls outside its own cell gets clamped back to the cell face
        // (see the module docs — that clamp is deliberate, trading a little sharpness for a mesh that
        // cannot self-intersect). So the honest claim here is comparative, not absolute.
        assert!(dc_max < 0.7 * sn_max, "max deviation: dc {dc_max} vs sn {sn_max}");
        assert!(dc_mean * 5.0 < sn_mean, "mean deviation: dc {dc_mean} vs sn {sn_mean}");
        assert!(dc_max < 0.25 * cell, "worst vertex still bounded well inside a cell: {dc_max}");
        assert!(dc_mean < 0.01 * cell, "the typical vertex sits on the surface: {dc_mean}");
    }

    #[test]
    fn a_rounded_corner_shrinks_the_part_and_dual_contouring_does_not() {
        // A second, INDEPENDENT check that needs no SDF sampling: measure the mesh's own extents
        // against the op-tree's analytic bounding box. Rounding a corner off physically shortens the
        // part — a maker would print an undersized piece — so the shortfall is the defect in mm.
        // The solid is rotated so its extremes fall on CORNERS (a grid-aligned box has its extremes on
        // flat faces, where both methods are exact and nothing is learned).
        let node = Node::Rotate {
            deg: 30.0,
            axis: [0.0, 0.0, 1.0],
            node: Box::new(Node::Rotate {
                deg: 30.0,
                axis: [1.0, 0.0, 0.0],
                node: Box::new(Node::Box { size: [20.0, 20.0, 20.0] }),
            }),
        };
        let analytic = node.bbox().size();
        let shortfall = |m: &Mesh| {
            let mut lo = Vec3::splat(f64::INFINITY);
            let mut hi = Vec3::splat(f64::NEG_INFINITY);
            for &p in &m.positions {
                lo = lo.cmin(p);
                hi = hi.cmax(p);
            }
            let e = hi - lo;
            (analytic - e).max_component()
        };

        let dc = shortfall(&polygonize_with(&node, 32, Method::DualContouring));
        let sn = shortfall(&polygonize_with(&node, 32, Method::SurfaceNets));
        assert!(dc.abs() < 0.02, "dual contouring should hit the analytic extents: off by {dc} mm");
        assert!(sn > 1.0, "surface nets is expected to shave the corners off: only {sn} mm");
    }

    #[test]
    fn crossing_lands_on_the_surface_far_more_precisely_than_the_linear_guess() {
        // The refinement earns its keep on CURVED fields, where the linear interpolation the raw
        // surface-nets step used is systematically off. Segment straddling a sphere of radius 5.
        let s = Node::Sphere { r: 5.0 };
        // OFF-AXIS segment so the field is genuinely CURVED along it: a radial segment through the centre
        // makes the sphere SDF linear (`|x|-r`), so the linear guess is already exact and the refinement
        // can't beat it — the degenerate case that compared two ~0 values (#3388).
        let pa = Vec3::new(0.0, 4.0, 0.0); // |pa| = 4, sdf = -1 (inside)
        let pc = Vec3::new(12.0, 4.0, 0.0); // |pc| = √160 ≈ 12.65, sdf ≈ +7.65 (outside)
        let (va, vc) = (s.sdf(pa), s.sdf(pc));

        let linear = pa + (pc - pa) * (va / (va - vc));
        let refined = crossing(&s, pa, pc, va, vc);
        // The bounded 8-step refinement lands within a tight tolerance of the real surface (1e-9 is only
        // reachable on a LINEAR field — a curved one converges to ~1e-3 in 8 regula-falsi steps)…
        assert!(s.sdf(refined).abs() < 0.02, "refined crossing is on the surface: off by {}", s.sdf(refined).abs());
        // …and far closer than the linear guess, which is systematically off (~0.77 mm) on the curved field.
        assert!(s.sdf(refined).abs() < s.sdf(linear).abs(), "refinement must beat the linear guess");
        // And it stays inside the segment it was given.
        assert!(refined.x > 0.0 && refined.x < 12.0);
    }

    #[test]
    fn normals_point_out_along_the_gradient() {
        // The QEF is only as good as its hermite data: on a sphere the outward normal at a surface
        // point is the radial direction.
        let s = Node::Sphere { r: 5.0 };
        let n = normal_at(&s, Vec3::new(5.0, 0.0, 0.0), 1e-4);
        assert!((n - Vec3::new(1.0, 0.0, 0.0)).length() < 1e-4, "got {n:?}");
        let n2 = normal_at(&s, Vec3::new(0.0, 0.0, -5.0), 1e-4);
        assert!((n2 - Vec3::new(0.0, 0.0, -1.0)).length() < 1e-4, "got {n2:?}");
    }

    #[test]
    fn method_names_parse_and_round_trip() {
        assert_eq!(Method::parse("dual"), Some(Method::DualContouring));
        assert_eq!(Method::parse("Dual_Contouring"), Some(Method::DualContouring));
        assert_eq!(Method::parse("surface-nets"), Some(Method::SurfaceNets));
        assert_eq!(Method::parse("sn"), Some(Method::SurfaceNets));
        assert_eq!(Method::parse("marching-cubes"), None, "an unsupported method must not silently alias");
        for m in [Method::DualContouring, Method::SurfaceNets] {
            assert_eq!(Method::parse(m.as_str()), Some(m), "as_str must be parseable back");
        }
        assert_eq!(Method::default(), Method::DualContouring, "sharp by default");
    }

    #[test]
    fn a_drilled_and_slotted_part_stays_closed_under_dual_contouring() {
        // Sharp concave features (a square slot) are the case where a naive solve most wants to fling
        // a vertex out of its cell; the clamp must keep the mesh manifold.
        let part = Node::Difference {
            base: Box::new(Node::Box { size: [30.0, 30.0, 10.0] }),
            tools: vec![
                Node::Box { size: [8.0, 40.0, 6.0] },
                Node::Translate { by: [10.0, 10.0, 0.0], node: Box::new(Node::Cylinder { r: 2.0, h: 20.0 }) },
            ],
        };
        let m = polygonize_with(&part, 48, Method::DualContouring);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "sharp concave features must not tear the mesh open");
    }

    #[test]
    fn extrude_of_an_l_shaped_profile_meshes_watertight() {
        // A concave profile (an L) is the case that stresses the ray-cast inside test, not just the
        // easy convex square — #3425's acceptance: "Sketch→extrude produces a valid closed mesh".
        let l_profile = vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 4.0],
            [4.0, 4.0],
            [4.0, 10.0],
            [0.0, 10.0],
        ];
        let part = Node::Extrude { profile: l_profile, height: 6.0 };
        let m = polygonize(&part, 40);
        assert!(!m.is_empty(), "a concave profile must still mesh");
        assert!(m.is_watertight(), "an extruded L stays a closed 2-manifold");
        // Volume: 10x10 square minus the 6x6 notch, times 6 mm depth.
        let expected = (10.0 * 10.0 - 6.0 * 6.0) * 6.0;
        assert!((m.volume() - expected).abs() / expected < 0.1, "volume {} vs {expected}", m.volume());
    }

    #[test]
    fn a_round_number_revolve_stays_watertight_despite_grid_alignment() {
        // Regression for the GRID_JITTER fix: a plain rectangle profile with ROUND mm dimensions
        // (radius 6, height 8) at a ROUND resolution used to put grid corners exactly on the part's
        // own flat caps, producing near-duplicate vertices and an open mesh. This is the overwhelmingly
        // common real case (a CAD spec authored in round millimetres), so it must just work.
        let profile = vec![[0.0, -4.0], [6.0, -4.0], [6.0, 4.0], [0.0, 4.0]];
        let m = polygonize(&Node::Revolve { profile }, 48);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "a round-dimensioned revolve must still close");
    }

    #[test]
    fn revolve_of_a_bushing_profile_meshes_watertight() {
        // #3425's acceptance: "Revolve produces a valid closed mesh". A stepped profile (a bushing
        // with a shoulder) so the revolve sweeps more than a plain rectangle.
        let profile = vec![[3.0, -5.0], [6.0, -5.0], [6.0, 2.0], [4.0, 2.0], [4.0, 5.0], [3.0, 5.0]];
        let part = Node::Revolve { profile };
        let m = polygonize(&part, 48);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "a revolved solid must close all the way around");
    }

    #[test]
    fn a_shelled_box_meshes_watertight_with_two_surfaces() {
        // #3426's acceptance: shell implemented with a test. A hollowed box polygonizes to TWO
        // separate closed shells (outer + inner wall) — both must close, and the enclosed volume
        // (outer minus inner) must reflect the wall thickness rather than a solid or a leaky mesh.
        let solid = Node::Box { size: [20.0, 20.0, 20.0] };
        let shell = Node::Shell { thickness: 2.0, node: Box::new(solid) };
        let m = polygonize(&shell, 40);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "both the outer and inner wall must close");
        // Outer 20mm cube (8000 mm3) minus the inner 16mm cube (4096 mm3) = 3904 mm3 of wall material.
        let expected = 20.0f64.powi(3) - 16.0f64.powi(3);
        assert!((m.volume() - expected).abs() / expected < 0.15, "wall volume {} vs {expected}", m.volume());
    }

    #[test]
    fn a_linear_pattern_of_bolt_bosses_meshes_watertight() {
        // #3426's acceptance: pattern implemented with a test. Three separate spheres, none touching,
        // must still mesh into three independent watertight shells.
        let unit = Node::Sphere { r: 3.0 };
        let row = Node::LinearPattern { by: [10.0, 0.0, 0.0], count: 3, node: Box::new(unit) };
        let m = polygonize(&row, 60);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "three disjoint copies must each close on their own");
        let one_sphere = 4.0 / 3.0 * std::f64::consts::PI * 3.0f64.powi(3);
        assert!((m.volume() - 3.0 * one_sphere).abs() / (3.0 * one_sphere) < 0.1);
    }

    #[test]
    fn a_radial_pattern_of_slots_stays_watertight() {
        // A ring of four bosses around Z, in a single mesh call.
        let boss = Node::Translate { by: [10.0, 0.0, 0.0], node: Box::new(Node::Sphere { r: 2.0 }) };
        let ring = Node::RadialPattern { axis: [0.0, 0.0, 1.0], count: 4, node: Box::new(boss) };
        let m = polygonize(&ring, 60);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "every copy around the ring must close");
    }

    #[test]
    fn a_filleted_box_meshes_watertight_and_grows_by_r() {
        // #3426's acceptance: fillet implemented with a test, distinguishable from smooth_union by
        // its effect on a SINGLE solid (smooth_union of one node is a no-op; Fillet is not).
        let cube = Node::Box { size: [20.0, 20.0, 20.0] };
        let rounded = Node::Fillet { r: 2.0, node: Box::new(cube) };
        let m = polygonize(&rounded, 40);
        assert!(!m.is_empty());
        assert!(m.is_watertight(), "a rounded box must still be a closed 2-manifold");
        // Volume grows past the plain 8000 mm3 cube (the whole envelope dilated outward by r=2).
        assert!(m.volume() > 8000.0, "opRound must enlarge the part: {}", m.volume());
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
