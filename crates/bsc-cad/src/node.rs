//! The declarative implicit CSG op-tree (#2621) — the kernel's SOURCE OF TRUTH and the surface an AI
//! authors (via `bsc cad`). A node describes *what a solid is*, in millimetres; the kernel evaluates
//! it as a signed-distance field (negative inside, zero on the surface, positive outside) and — in
//! `mesh.rs` — polygonizes that field. Fillets are the SDF `smooth_union` (smooth-min), so the single
//! hardest B-rep operation is nearly free here.
//!
//! Primitives stay ANALYTIC on purpose (#2621): it keeps the door open to a future limited-STEP writer
//! for prismatic parts without re-authoring the model.
use crate::math::{Aabb, Vec3};
use crate::sketch::{profile_bounds, profile_sdf, revolve_profile_sdf, Profile};
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
    /// Extrude a closed 2D `profile` (mm, read as `[x, y]`) along Z by `height` (mm), centred on
    /// `z = 0`. The sketch→extrude authoring path (#3425): describe a flat shape once, then give it
    /// depth — a `Cylinder` is exactly `Extrude` of a circular profile, generalized to any polygon.
    Extrude { profile: Profile, height: f64 },
    /// Revolve a closed 2D `profile` (mm) a full 360° about the Z axis. The profile's first
    /// coordinate is read as the radial distance from Z (so it should stay `>= 0` for a physically
    /// sane part) and its second as the height along Z. The lathe-part authoring path (#3425).
    Revolve { profile: Profile },
    /// Hollow `node` to a wall thickness `thickness` (mm), keeping its OUTER surface exactly where
    /// it was and removing material beyond `thickness` inward (#3426). A `thickness` at least as
    /// large as the part's own half-extent leaves nothing — that degrades to an empty solid, not a
    /// self-intersecting mesh.
    Shell { thickness: f64, node: Box<Node> },
    /// A finite LINEAR array of `node`: `count` copies at `0, by, 2·by, …, (count-1)·by` (mm) — the
    /// pattern authoring path (#3426). `count == 0` yields no geometry; `count == 1` is `node` itself.
    LinearPattern {
        by: [f64; 3],
        count: usize,
        node: Box<Node>,
    },
    /// A finite RADIAL array of `node`: `count` copies spaced evenly around a full turn about `axis`
    /// (through the origin, need not be normalized) — the pattern authoring path (#3426). `count == 0`
    /// yields no geometry; `count == 1` is `node` itself.
    RadialPattern {
        axis: [f64; 3],
        count: usize,
        node: Box<Node>,
    },
    /// Round `node`'s own convex edges/corners with radius `r` (mm) by dilating its whole surface
    /// outward — iq's `opRound`: `sdf(p) - r` (#3426).
    ///
    /// This is a DIFFERENT operation from [`Node::SmoothUnion`], and the two are easy to conflate
    /// because both produce a rounded look: `smooth_union` blends the SEAM between two or more
    /// DISTINCT solids at their boolean join (it has no effect on a single solid alone — a
    /// `smooth_union` of one node is just that node). `Fillet` instead rounds ONE existing solid's
    /// own edges, uniformly, everywhere at once, and needs no second solid to blend against.
    ///
    /// The trade-off that keeps it simple enough to apply to ANY node — not just an analytic
    /// primitive whose parameters can be shrunk first, the way a textbook "round box" is built — is
    /// that the whole envelope grows by `r` in every direction (a true Minkowski dilation by a ball of
    /// radius `r`): flat faces move outward by `r`, convex edges/corners become radius-`r` fillets,
    /// and concave (reflex) edges are left sharp, exactly as offsetting any solid outward by a ball
    /// does. If the nominal envelope must stay fixed, shrink `node` first (e.g. narrower primitive
    /// parameters, or wrap it in `Scale`) to compensate.
    Fillet { r: f64, node: Box<Node> },
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
            Node::Extrude { profile, height } => {
                // Identical shape to Cylinder's combinator: intersect the profile's 2D field with a
                // Z-slab of thickness `height`. A degenerate profile's +infinity propagates through
                // unchanged (inf.max(dz).min(0.0) == 0.0, plus an infinite `outside` term == inf).
                let d2 = profile_sdf(profile, [p.x, p.y]);
                let dz = p.z.abs() - height * 0.5;
                let outside = (d2.max(0.0).powi(2) + dz.max(0.0).powi(2)).sqrt();
                d2.max(dz).min(0.0) + outside
            }
            Node::Revolve { profile } => {
                // Sample the profile in its own (radius, height) half-plane at this point's radius —
                // see revolve_profile_sdf for why a plain 2D reading gets the axis itself wrong.
                let r = (p.x * p.x + p.y * p.y).sqrt();
                revolve_profile_sdf(profile, [r, p.z])
            }
            Node::Shell { thickness, node } => {
                // difference(node, node-offset-inward-by-thickness): the inner wall's sdf is node's
                // own sdf shifted by `thickness`, so its zero level set sits exactly `thickness` mm
                // inside node's true surface (see Node::Difference for the same max/negate pattern).
                let d = node.sdf(p);
                d.max(-(d + thickness))
            }
            Node::LinearPattern { by, count, node } => {
                if *count == 0 {
                    return f64::INFINITY;
                }
                let step = Vec3::from_arr(*by);
                (0..*count)
                    .map(|i| node.sdf(p - step * (i as f64)))
                    .fold(f64::INFINITY, f64::min)
            }
            Node::RadialPattern { axis, count, node } => {
                if *count == 0 {
                    return f64::INFINITY;
                }
                let a = Vec3::from_arr(*axis).normalize();
                let n = *count as f64;
                (0..*count)
                    .map(|i| {
                        let theta = (i as f64) * std::f64::consts::TAU / n;
                        // Sample copy i by INVERSE-rotating the query point, same convention as Rotate.
                        node.sdf(p.rotate(a, -theta))
                    })
                    .fold(f64::INFINITY, f64::min)
            }
            Node::Fillet { r, node } => node.sdf(p) - r,
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
            Node::Extrude { profile, height } => {
                if profile.len() < 3 {
                    return Aabb::EMPTY;
                }
                let (umin, umax, vmin, vmax) = profile_bounds(profile);
                Aabb::new(
                    Vec3::new(umin, vmin, -height * 0.5),
                    Vec3::new(umax, vmax, height * 0.5),
                )
            }
            Node::Revolve { profile } => {
                if profile.len() < 3 {
                    return Aabb::EMPTY;
                }
                let (umin, umax, vmin, vmax) = profile_bounds(profile);
                // The reachable radius is bounded by the profile's farthest point from the axis in
                // EITHER direction — a profile that dips to u < 0 never produces real geometry there
                // (r = sqrt(x²+y²) can't go negative), but the bound must still cover it conservatively.
                let r = umax.max(umin.abs()).max(0.0);
                Aabb::new(Vec3::new(-r, -r, vmin), Vec3::new(r, r, vmax))
            }
            // The outer surface is untouched — only material inside it is removed.
            Node::Shell { node, .. } => node.bbox(),
            Node::LinearPattern { by, count, node } => {
                if *count == 0 {
                    return Aabb::EMPTY;
                }
                let step = Vec3::from_arr(*by);
                let base = node.bbox();
                (0..*count).fold(Aabb::EMPTY, |acc, i| {
                    let t = step * (i as f64);
                    acc.union(Aabb::new(base.min + t, base.max + t))
                })
            }
            Node::RadialPattern { axis, count, node } => {
                if *count == 0 {
                    return Aabb::EMPTY;
                }
                let a = Vec3::from_arr(*axis).normalize();
                let n = *count as f64;
                let base = node.bbox();
                (0..*count).fold(Aabb::EMPTY, |acc, i| {
                    let theta = (i as f64) * std::f64::consts::TAU / n;
                    let rotated = base.corners().iter().fold(Aabb::EMPTY, |a2, &c| {
                        let r = c.rotate(a, theta);
                        a2.union(Aabb::new(r, r))
                    });
                    acc.union(rotated)
                })
            }
            // A true Minkowski dilation by a ball of radius r — the same expand-by-blend-radius shape
            // as SmoothUnion's k, just applied to one node instead of a join between several.
            Node::Fillet { r, node } => node.bbox().expand(*r),
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

    /// A 10×10 square profile centred on the origin, corners at ±5.
    fn square_profile() -> Profile {
        vec![[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]]
    }

    #[test]
    fn extrude_reduces_to_a_box_for_a_square_profile() {
        // A square extruded IS a box — the same shape two authoring paths can reach — so its sdf
        // should agree with Node::Box's at matching points.
        let e = Node::Extrude { profile: square_profile(), height: 8.0 };
        let b = Node::Box { size: [10.0, 10.0, 8.0] };
        for p in [
            Vec3::ZERO,
            Vec3::new(5.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 4.0),
            Vec3::new(7.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 6.0),
            Vec3::new(6.0, 6.0, 5.0),
        ] {
            assert!((e.sdf(p) - b.sdf(p)).abs() < EPS, "mismatch at {p:?}: {} vs {}", e.sdf(p), b.sdf(p));
        }
    }

    #[test]
    fn extrude_bbox_matches_the_profile_extents_and_height() {
        let e = Node::Extrude { profile: square_profile(), height: 8.0 };
        let bb = e.bbox();
        assert!((bb.min.x + 5.0).abs() < EPS && (bb.max.x - 5.0).abs() < EPS);
        assert!((bb.min.z + 4.0).abs() < EPS && (bb.max.z - 4.0).abs() < EPS);
    }

    #[test]
    fn extrude_of_a_degenerate_profile_is_empty() {
        let e = Node::Extrude { profile: vec![[0.0, 0.0], [1.0, 0.0]], height: 8.0 };
        assert!(e.bbox().is_empty());
        assert!(e.sdf(Vec3::ZERO) > 0.0, "no solid, so every point reads as outside");
    }

    #[test]
    fn revolve_of_a_rectangle_reduces_to_a_cylinder() {
        // A rectangle [0,r] x [-h/2,h/2] revolved a full circle about Z IS a cylinder of radius r,
        // height h — the lathe-part case, checkable against the existing analytic primitive.
        let profile = vec![[0.0, -4.0], [6.0, -4.0], [6.0, 4.0], [0.0, 4.0]];
        let rev = Node::Revolve { profile };
        let cyl = Node::Cylinder { r: 6.0, h: 8.0 };
        for p in [
            Vec3::ZERO,
            Vec3::new(6.0, 0.0, 0.0),
            Vec3::new(0.0, 6.0, 0.0),
            Vec3::new(4.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, 3.0),
            Vec3::new(0.0, 0.0, 5.0),
        ] {
            assert!((rev.sdf(p) - cyl.sdf(p)).abs() < EPS, "mismatch at {p:?}: {} vs {}", rev.sdf(p), cyl.sdf(p));
        }
    }

    #[test]
    fn revolve_bbox_bounds_the_swept_radius_and_height() {
        let profile = vec![[0.0, -4.0], [6.0, -4.0], [6.0, 4.0], [0.0, 4.0]];
        let bb = Node::Revolve { profile }.bbox();
        assert!((bb.max.x - 6.0).abs() < EPS && (bb.min.x + 6.0).abs() < EPS);
        assert!((bb.max.z - 4.0).abs() < EPS && (bb.min.z + 4.0).abs() < EPS);
    }

    #[test]
    fn shell_keeps_the_outer_surface_and_hollows_the_interior() {
        let solid = Node::Box { size: [20.0, 20.0, 20.0] };
        let shell = Node::Shell { thickness: 2.0, node: Box::new(solid.clone()) };
        // The outer surface is untouched: same sdf as the plain box at and outside the boundary.
        for p in [Vec3::new(10.0, 0.0, 0.0), Vec3::new(15.0, 0.0, 0.0)] {
            assert!((shell.sdf(p) - solid.sdf(p)).abs() < EPS, "outer surface moved at {p:?}");
        }
        // 1 mm inside the surface (within the 2 mm wall) — still solid.
        assert!(shell.sdf(Vec3::new(9.0, 0.0, 0.0)) < 0.0, "the wall itself must read as solid");
        // Deep in the interior (10 mm from the wall, well past a 2 mm shell) — hollowed out.
        assert!(shell.sdf(Vec3::ZERO) > 0.0, "the interior must be hollow");
        // The bbox is exactly the original solid's — shelling never grows the envelope.
        let (bo, bs) = (solid.bbox(), shell.bbox());
        assert!((bo.min - bs.min).length() < EPS && (bo.max - bs.max).length() < EPS);
    }

    #[test]
    fn linear_pattern_places_count_copies_at_even_spacing() {
        let unit = Node::Sphere { r: 1.0 };
        let row = Node::LinearPattern { by: [10.0, 0.0, 0.0], count: 3, node: Box::new(unit) };
        // A copy sits at x=0, 10, 20 — so those centres must each read as deeply inside (~ -1).
        for cx in [0.0, 10.0, 20.0] {
            assert!((row.sdf(Vec3::new(cx, 0.0, 0.0)) + 1.0).abs() < EPS, "no copy centred at x={cx}");
        }
        // Between copies (x=5) is outside every sphere.
        assert!(row.sdf(Vec3::new(5.0, 0.0, 0.0)) > 0.0);
        // count=0 → no geometry; count=1 → exactly the node itself.
        let none = Node::LinearPattern { by: [10.0, 0.0, 0.0], count: 0, node: Box::new(Node::Sphere { r: 1.0 }) };
        assert!(none.bbox().is_empty());
        let one = Node::LinearPattern { by: [10.0, 0.0, 0.0], count: 1, node: Box::new(Node::Sphere { r: 1.0 }) };
        assert!((one.sdf(Vec3::ZERO) - Node::Sphere { r: 1.0 }.sdf(Vec3::ZERO)).abs() < EPS);
    }

    #[test]
    fn linear_pattern_bbox_spans_every_copy() {
        let bb = Node::LinearPattern {
            by: [10.0, 0.0, 0.0],
            count: 3,
            node: Box::new(Node::Sphere { r: 1.0 }),
        }
        .bbox();
        assert!((bb.min.x + 1.0).abs() < EPS, "first copy's left edge");
        assert!((bb.max.x - 21.0).abs() < EPS, "third copy's right edge (centre 20 + r 1)");
    }

    #[test]
    fn radial_pattern_places_count_copies_evenly_around_the_axis() {
        let unit = Node::Translate { by: [10.0, 0.0, 0.0], node: Box::new(Node::Sphere { r: 1.0 }) };
        let ring = Node::RadialPattern { axis: [0.0, 0.0, 1.0], count: 4, node: Box::new(unit) };
        // Copies land at 0°, 90°, 180°, 270° — i.e. (10,0), (0,10), (-10,0), (0,-10).
        for c in [
            Vec3::new(10.0, 0.0, 0.0),
            Vec3::new(0.0, 10.0, 0.0),
            Vec3::new(-10.0, 0.0, 0.0),
            Vec3::new(0.0, -10.0, 0.0),
        ] {
            assert!((ring.sdf(c) + 1.0).abs() < 1e-6, "no copy centred at {c:?}: {}", ring.sdf(c));
        }
        // Halfway between two copies (45°) is outside every sphere.
        let mid = Vec3::new(10.0 * std::f64::consts::FRAC_1_SQRT_2, 10.0 * std::f64::consts::FRAC_1_SQRT_2, 0.0);
        assert!(ring.sdf(mid) > 0.0);
    }

    #[test]
    fn radial_pattern_count_zero_and_one_are_the_empty_and_identity_cases() {
        let child = || Box::new(Node::Translate { by: [5.0, 0.0, 0.0], node: Box::new(Node::Sphere { r: 1.0 }) });
        let none = Node::RadialPattern { axis: [0.0, 0.0, 1.0], count: 0, node: child() };
        assert!(none.bbox().is_empty());
        let one = Node::RadialPattern { axis: [0.0, 0.0, 1.0], count: 1, node: child() };
        let plain = Node::Translate { by: [5.0, 0.0, 0.0], node: Box::new(Node::Sphere { r: 1.0 }) };
        assert!((one.sdf(Vec3::new(5.0, 0.0, 0.0)) - plain.sdf(Vec3::new(5.0, 0.0, 0.0))).abs() < EPS);
    }

    #[test]
    fn fillet_dilates_a_flat_face_by_a_uniform_shift() {
        let cube = Node::Box { size: [20.0, 20.0, 20.0] };
        let rounded = Node::Fillet { r: 2.0, node: Box::new(cube.clone()) };
        let face = Vec3::new(10.0, 0.0, 0.0);
        assert!((rounded.sdf(face) - (cube.sdf(face) - 2.0)).abs() < EPS);
        // The bbox grows by exactly r in every direction — the documented trade-off.
        let bb = rounded.bbox();
        assert!((bb.max.x - 12.0).abs() < EPS && (bb.min.x + 12.0).abs() < EPS);
    }

    #[test]
    fn fillet_rounds_a_cube_corner_into_a_true_radius_r_sphere() {
        // opRound's defining property, not just asserted: strictly beyond all three faces the box's
        // OWN sdf is exactly the Euclidean distance to the corner (q.max0().length() with every
        // component positive) — so subtracting r there is EXACTLY a sphere of radius r centred on
        // that corner. That is a genuinely rounded corner, distinct from a uniform outward shift
        // (which a flat face gets, and which would leave a sharp corner merely relocated).
        let cube = Node::Box { size: [20.0, 20.0, 20.0] };
        let rounded = Node::Fillet { r: 2.0, node: Box::new(cube) };
        let corner = Vec3::new(10.0, 10.0, 10.0);
        for offset in [Vec3::new(1.0, 1.0, 1.0), Vec3::new(2.0, 0.0, 0.0), Vec3::new(1.5, 1.5, 0.0)] {
            let p = corner + offset;
            let expected = offset.length() - 2.0; // distance to the corner, minus the fillet radius
            assert!((rounded.sdf(p) - expected).abs() < EPS, "not on a sphere of radius r at {p:?}");
        }
    }

    #[test]
    fn fillet_of_zero_is_a_no_op() {
        let s = Node::Sphere { r: 5.0 };
        let f = Node::Fillet { r: 0.0, node: Box::new(s.clone()) };
        assert!((f.sdf(Vec3::new(3.0, 0.0, 0.0)) - s.sdf(Vec3::new(3.0, 0.0, 0.0))).abs() < EPS);
        assert!((f.bbox().max.x - s.bbox().max.x).abs() < EPS);
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
