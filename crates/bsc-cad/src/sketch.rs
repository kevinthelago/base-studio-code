//! 2D closed-polygon **sketch** profiles (#3425) — the flat shape `Node::Extrude`/`Node::Revolve`
//! build a solid from. A profile is just a list of `[u, v]` mm points; the polygon is implicitly
//! closed (the last point connects back to the first), so callers never repeat the first point.
//!
//! [`profile_sdf`] is the 2D analogue of [`crate::node::Node::sdf`]: negative inside, zero on the
//! boundary, positive outside. It uses the standard even-odd ray-cast for the inside/outside test and
//! the true nearest-edge distance for the magnitude (iq's `sdPolygon`), so the boundary is exact —
//! not a coarse per-vertex approximation — which is what lets `Extrude`/`Revolve` reuse the same
//! crossing-refinement (`mesh.rs`'s `crossing`) that the primitives get.

/// A closed 2D polygon, in millimetres. Implicitly closed: edge `i` runs from `profile[i]` to
/// `profile[(i + 1) % len]`. Fewer than 3 points cannot enclose an area (see [`profile_sdf`]).
pub type Profile = Vec<[f64; 2]>;

/// Signed distance from `p` to the boundary of `profile`: `< 0` inside, `0` on it, `> 0` outside. A
/// degenerate profile (fewer than 3 points) reports every point as outside at `+infinity`, so a caller
/// sees "no solid" (propagating to an empty mesh) rather than a panic or a nonsensical answer.
pub fn profile_sdf(profile: &[[f64; 2]], p: [f64; 2]) -> f64 {
    let n = profile.len();
    if n < 3 {
        return f64::INFINITY;
    }
    let py = p[1];
    let px = p[0];
    let mut best = f64::INFINITY;
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let a = profile[j];
        let b = profile[i];
        best = best.min(segment_distance(a, b, p));
        // Even-odd crossing test: does edge a→b cross the horizontal ray from p toward +u?
        if (a[1] > py) != (b[1] > py) {
            let t = (py - a[1]) / (b[1] - a[1]);
            let x_at_y = a[0] + t * (b[0] - a[0]);
            if px < x_at_y {
                inside = !inside;
            }
        }
        j = i;
    }
    if inside {
        -best
    } else {
        best
    }
}

/// Distance from `p` to the segment `a..b` (2D) — the closest-point-on-segment clamp.
fn segment_distance(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
    let len2 = ex * ex + ey * ey;
    let t = if len2 > 1e-300 {
        (((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (cx, cy) = (a[0] + ex * t, a[1] + ey * t);
    let (dx, dy) = (p[0] - cx, p[1] - cy);
    (dx * dx + dy * dy).sqrt()
}

/// Signed distance from `(r, z)` to the boundary a REVOLVE of `profile` about the Z axis actually
/// sweeps out — [`profile_sdf`] specialized for the one case revolve needs that a plain 2D reading
/// gets wrong: an edge lying entirely ON `u = 0` (the axis) sweeps out no surface at all when revolved
/// (every point on it stays at radius 0), so it is not a real face of the solid and must be excluded
/// from the NEAREST-edge distance — a profile like a solid disc that touches the axis along a whole
/// edge would otherwise read the axis itself as sitting exactly ON that "edge" (distance 0) instead of
/// deep inside the swept solid, where its true nearest surface is whatever real face is actually
/// closest (a flat cap, a curved wall, …). The inside/outside SIGN still needs the full boundary
/// (including the axis edge) to come out right, so only the magnitude drops it.
pub fn revolve_profile_sdf(profile: &[[f64; 2]], p: [f64; 2]) -> f64 {
    let n = profile.len();
    if n < 3 {
        return f64::INFINITY;
    }
    let py = p[1];
    let px = p[0];
    let mut best = f64::INFINITY;
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let a = profile[j];
        let b = profile[i];
        if a[0].abs() > 1e-12 || b[0].abs() > 1e-12 {
            best = best.min(segment_distance(a, b, p));
        }
        if (a[1] > py) != (b[1] > py) {
            let t = (py - a[1]) / (b[1] - a[1]);
            let x_at_y = a[0] + t * (b[0] - a[0]);
            if px < x_at_y {
                inside = !inside;
            }
        }
        j = i;
    }
    if inside {
        -best
    } else {
        best
    }
}

/// `(u_min, u_max, v_min, v_max)` — the profile's own bounding rectangle, used by `Extrude`/`Revolve`
/// to bound the solid built from it. A degenerate (fewer-than-3-point) profile reports all zeros —
/// callers check the point count separately before trusting this (see `Node::bbox`).
pub fn profile_bounds(profile: &[[f64; 2]]) -> (f64, f64, f64, f64) {
    if profile.is_empty() {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let (mut umin, mut umax) = (f64::INFINITY, f64::NEG_INFINITY);
    let (mut vmin, mut vmax) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in profile {
        umin = umin.min(p[0]);
        umax = umax.max(p[0]);
        vmin = vmin.min(p[1]);
        vmax = vmax.max(p[1]);
    }
    (umin, umax, vmin, vmax)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-9;

    /// A 10×10 square centred on the origin, corners at ±5.
    fn square() -> Profile {
        vec![[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]]
    }

    #[test]
    fn centre_and_face_distances_on_a_square() {
        let s = square();
        // Centre: nearest edge is any face, 5 mm away, inside → negative.
        assert!((profile_sdf(&s, [0.0, 0.0]) + 5.0).abs() < EPS);
        // On the +u face → 0; 2 mm beyond → +2.
        assert!(profile_sdf(&s, [5.0, 0.0]).abs() < EPS);
        assert!((profile_sdf(&s, [7.0, 0.0]) - 2.0).abs() < EPS);
    }

    #[test]
    fn a_corner_is_the_nearest_point_outside_the_diagonal() {
        let s = square();
        // Due outside a corner, the nearest boundary point IS the corner — Euclidean distance.
        let d = profile_sdf(&s, [8.0, 9.0]);
        let expected = ((8.0f64 - 5.0).powi(2) + (9.0f64 - 5.0).powi(2)).sqrt();
        assert!((d - expected).abs() < EPS);
    }

    #[test]
    fn winding_direction_does_not_flip_the_sign() {
        // The reversed vertex order describes the identical boundary; inside/outside must not flip.
        let mut rev = square();
        rev.reverse();
        for p in [[0.0, 0.0], [7.0, 0.0], [8.0, 9.0]] {
            assert!((profile_sdf(&square(), p) - profile_sdf(&rev, p)).abs() < EPS, "{p:?}");
        }
    }

    #[test]
    fn a_concave_l_shape_is_read_correctly() {
        // An L: the notch at (6,6) must read OUTSIDE even though it's within the bounding square.
        let l = vec![
            [0.0, 0.0],
            [10.0, 0.0],
            [10.0, 4.0],
            [4.0, 4.0],
            [4.0, 10.0],
            [0.0, 10.0],
        ];
        assert!(profile_sdf(&l, [6.0, 6.0]) > 0.0, "the notch must be outside the L");
        assert!(profile_sdf(&l, [2.0, 2.0]) < 0.0, "the leg must stay inside");
    }

    #[test]
    fn degenerate_profiles_report_infinity_everywhere() {
        assert_eq!(profile_sdf(&[], [0.0, 0.0]), f64::INFINITY);
        assert_eq!(profile_sdf(&[[0.0, 0.0], [1.0, 0.0]], [0.0, 0.0]), f64::INFINITY);
    }

    #[test]
    fn bounds_match_the_squares_extents_and_a_degenerate_profile_is_all_zero() {
        assert_eq!(profile_bounds(&square()), (-5.0, 5.0, -5.0, 5.0));
        assert_eq!(profile_bounds(&[]), (0.0, 0.0, 0.0, 0.0));
    }
}
