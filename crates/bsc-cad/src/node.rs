//! The declarative implicit CSG op-tree (#2621) — the kernel's SOURCE OF TRUTH and the surface an AI
//! authors (via `bsc cad`). A node describes *what a solid is*, in millimetres; the kernel evaluates
//! it as a signed-distance field (negative inside, zero on the surface, positive outside) and — in
//! `mesh.rs` — polygonizes that field. Fillets are the SDF `smooth_union` (smooth-min), so the single
//! hardest B-rep operation is nearly free here.
//!
//! Primitives stay ANALYTIC on purpose (#2621): it keeps the door open to a future limited-STEP writer
//! for prismatic parts without re-authoring the model.
use crate::math::{Aabb, Vec3};
use serde::{Deserialize, Serialize};

/// One node of the op-tree. Serde tag `op` (snake_case) is the JSON/CLI wire form, e.g.
/// `{"op":"box","size":[20,10,5]}` or `{"op":"difference","base":{…},"tools":[{…}]}`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Node {
    /// Axis-aligned box; `size` is the FULL extents (mm), centred on the origin.
    Box { size: [f64; 3] },
    /// Sphere of radius `r` (mm), centred on the origin.
    Sphere { r: f64 },
    /// Z-axis capped cylinder: radius `r`, total height `h` (mm), centred on the origin.
    Cylinder { r: f64, h: f64 },
    /// Translate the child by `by` (mm).
    Translate { by: [f64; 3], node: Box<Node> },
    /// Rotate the child `deg` degrees about `axis` (need not be normalized).
    Rotate {
        deg: f64,
        axis: [f64; 3],
        node: Box<Node>,
    },
    /// Uniform scale by `factor` (non-uniform would break the distance metric, so it's excluded).
    Scale { factor: f64, node: Box<Node> },
    /// Boolean OR — the merged solid.
    Union { nodes: Vec<Node> },
    /// `base` minus every solid in `tools`.
    Difference { base: Box<Node>, tools: Vec<Node> },
    /// Boolean AND — the overlapping solid.
    Intersect { nodes: Vec<Node> },
    /// Union with a fillet of radius ~`k` mm at the joins (SDF polynomial smooth-min).
    SmoothUnion { k: f64, nodes: Vec<Node> },
}

/// iq's polynomial smooth-min — blends two distances with a fillet of scale `k`.
fn smin(a: f64, b: f64, k: f64) -> f64 {
    if k <= 0.0 {
        return a.min(b);
    }
    let h = (0.5 + 0.5 * (b - a) / k).clamp(0.0, 1.0);
    // lerp(b, a, h) - k*h*(1-h)
    (b + (a - b) * h) - k * h * (1.0 - h)
}

impl Node {
    /// Signed distance from `p` (mm) to this solid's surface: `< 0` inside, `0` on it, `> 0` outside.
    pub fn sdf(&self, p: Vec3) -> f64 {
        match self {
            Node::Box { size } => {
                let q = p.abs() - Vec3::from_arr(*size) * 0.5;
                q.max0().length() + q.max_component().min(0.0)
            }
            Node::Sphere { r } => p.length() - r,
            Node::Cylinder { r, h } => {
                let d_xy = (p.x * p.x + p.y * p.y).sqrt() - r;
                let d_z = p.z.abs() - h * 0.5;
                let outside = (d_xy.max(0.0).powi(2) + d_z.max(0.0).powi(2)).sqrt();
                d_xy.max(d_z).min(0.0) + outside
            }
            Node::Translate { by, node } => node.sdf(p - Vec3::from_arr(*by)),
            Node::Rotate { deg, axis, node } => {
                // Sample the child by INVERSE-rotating the query point.
                let a = Vec3::from_arr(*axis).normalize();
                node.sdf(p.rotate(a, -deg.to_radians()))
            }
            Node::Scale { factor, node } => node.sdf(p / *factor) * factor,
            Node::Union { nodes } => nodes
                .iter()
                .map(|n| n.sdf(p))
                .fold(f64::INFINITY, f64::min),
            Node::Difference { base, tools } => {
                let mut d = base.sdf(p);
                for t in tools {
                    d = d.max(-t.sdf(p));
                }
                d
            }
            Node::Intersect { nodes } => nodes
                .iter()
                .map(|n| n.sdf(p))
                .fold(f64::NEG_INFINITY, f64::max),
            Node::SmoothUnion { k, nodes } => nodes
                .iter()
                .map(|n| n.sdf(p))
                .reduce(|a, b| smin(a, b, *k))
                .unwrap_or(f64::INFINITY),
        }
    }

    /// A conservative axis-aligned bound of the solid (mm) — the grid the polygonizer samples over.
    pub fn bbox(&self) -> Aabb {
        match self {
            Node::Box { size } => Aabb::centered(Vec3::from_arr(*size) * 0.5),
            Node::Sphere { r } => Aabb::centered(Vec3::splat(*r)),
            Node::Cylinder { r, h } => Aabb::centered(Vec3::new(*r, *r, h * 0.5)),
            Node::Translate { by, node } => {
                let b = node.bbox();
                let t = Vec3::from_arr(*by);
                Aabb::new(b.min + t, b.max + t)
            }
            Node::Rotate { deg, axis, node } => {
                let a = Vec3::from_arr(*axis).normalize();
                let th = deg.to_radians();
                node.bbox().corners().iter().fold(Aabb::EMPTY, |acc, &c| {
                    let r = c.rotate(a, th);
                    acc.union(Aabb::new(r, r))
                })
            }
            Node::Scale { factor, node } => {
                let b = node.bbox();
                Aabb::new(b.min * *factor, b.max * *factor)
            }
            Node::Union { nodes } => nodes.iter().fold(Aabb::EMPTY, |a, n| a.union(n.bbox())),
            Node::SmoothUnion { k, nodes } => nodes
                .iter()
                .fold(Aabb::EMPTY, |a, n| a.union(n.bbox()))
                .expand(*k), // the blend can bulge slightly past the union
            Node::Intersect { nodes } => nodes
                .iter()
                .map(Node::bbox)
                .reduce(Aabb::intersection)
                .unwrap_or(Aabb::EMPTY),
            // Subtraction can never grow the base, so the base bound is conservative.
            Node::Difference { base, .. } => base.bbox(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    #[test]
    fn box_sdf_signs_and_distances() {
        let b = Node::Box { size: [20.0, 10.0, 5.0] };
        // Centre: distance to the nearest face = half the smallest extent (2.5), inside → negative.
        assert!((b.sdf(Vec3::ZERO) + 2.5).abs() < EPS);
        // On the +x face (half = 10) → 0; 5 mm beyond → 5.
        assert!(b.sdf(Vec3::new(10.0, 0.0, 0.0)).abs() < EPS);
        assert!((b.sdf(Vec3::new(15.0, 0.0, 0.0)) - 5.0).abs() < EPS);
    }

    #[test]
    fn sphere_and_cylinder_sdf() {
        let s = Node::Sphere { r: 5.0 };
        assert!((s.sdf(Vec3::ZERO) + 5.0).abs() < EPS);
        assert!((s.sdf(Vec3::new(10.0, 0.0, 0.0)) - 5.0).abs() < EPS);
        let c = Node::Cylinder { r: 3.0, h: 10.0 };
        assert!((c.sdf(Vec3::ZERO) + 3.0).abs() < EPS); // nearest wall is the radius
        assert!(c.sdf(Vec3::new(3.0, 0.0, 0.0)).abs() < EPS);
        assert!((c.sdf(Vec3::new(0.0, 0.0, 8.0)) - 3.0).abs() < EPS); // 3 mm above the cap
    }

    #[test]
    fn translate_moves_the_field() {
        let s = Node::Translate {
            by: [10.0, 0.0, 0.0],
            node: Box::new(Node::Sphere { r: 5.0 }),
        };
        assert!((s.sdf(Vec3::new(10.0, 0.0, 0.0)) + 5.0).abs() < EPS);
    }

    #[test]
    fn difference_removes_material() {
        let plate = Node::Difference {
            base: Box::new(Node::Box { size: [20.0, 20.0, 4.0] }),
            tools: vec![Node::Cylinder { r: 3.0, h: 10.0 }],
        };
        // A point on the axis inside the drilled hole is now OUTSIDE the solid.
        assert!(plate.sdf(Vec3::new(0.0, 0.0, 0.0)) > 0.0);
        // A point in the remaining material stays inside.
        assert!(plate.sdf(Vec3::new(9.0, 9.0, 0.0)) < 0.0);
    }

    #[test]
    fn smooth_union_bounds_expand_by_k() {
        let n = Node::SmoothUnion {
            k: 2.0,
            nodes: vec![Node::Sphere { r: 5.0 }],
        };
        // Sphere bound is ±5; the blend expands it by k.
        assert!((n.bbox().max.x - 7.0).abs() < EPS);
    }
}
