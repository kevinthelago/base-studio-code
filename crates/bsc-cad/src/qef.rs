//! The **quadratic error function** (#3388) — the numerical core that makes dual contouring preserve
//! sharp edges, kept in its own module because it is pure linear algebra with no geometry around it.
//!
//! Surface nets places a cell's vertex at the MEAN of its edge crossings, which is why it rounds every
//! sharp feature: the mean of points scattered around a cube's corner sits *inside* the cube, never on
//! the corner. Dual contouring instead keeps **hermite data** — for each crossing, the point `p` AND
//! the surface normal `n` there — and places the vertex where it best satisfies every tangent plane at
//! once:
//!
//! ```text
//! minimize  E(x) = Σ (nᵢ · (x - pᵢ))²
//! ```
//!
//! On a flat patch the planes are parallel and the minimum is a whole plane (under-determined); along
//! an edge it is a line; at a corner it is a single point — which is exactly the sharp vertex surface
//! nets loses. Expanding `E` gives the normal equations `AᵀA x = Aᵀb` with `A`'s rows the normals and
//! `bᵢ = nᵢ · pᵢ`.
//!
//! `AᵀA` is 3×3, symmetric and positive semi-definite, and is SINGULAR in exactly the flat/edge cases
//! above — so it must be inverted by **pseudo-inverse**, not by a plain solve. We eigen-decompose it
//! with cyclic Jacobi rotations (exact for symmetric matrices, and only 3×3 here) and drop the
//! near-zero eigenvalues; the dropped directions are the ones the data does not constrain, and we
//! leave the answer at the mass point along them. That combination — pseudo-inverse plus a mass-point
//! origin — is what keeps the solve stable on flat regions instead of flinging the vertex to infinity.
use crate::math::Vec3;

/// Eigenvalues below `tol · λ_max` are treated as zero by the pseudo-inverse. The dropped directions
/// are the ones the tangent planes leave unconstrained (a flat patch drops two, an edge one), so this
/// threshold IS the "is this a sharp feature?" test. Loose enough that near-parallel normals on a
/// curved patch don't fake a corner; tight enough that a real edge still resolves.
pub const DEFAULT_TOL: f64 = 1e-3;

/// An accumulated quadratic error function `E(x) = Σ (nᵢ · (x - pᵢ))²`, held in its expanded form so
/// planes can be added one at a time without storing them: `E(x) = xᵀ·AᵀA·x - 2·x·Aᵀb + bᵀb`.
#[derive(Clone, Debug)]
pub struct Qef {
    /// `AᵀA` — symmetric, so only the full 3×3 is kept for readability (the redundancy is 3 f64s).
    ata: [[f64; 3]; 3],
    atb: Vec3,
    btb: f64,
    planes: usize,
}

impl Default for Qef {
    fn default() -> Self {
        Self::new()
    }
}

impl Qef {
    /// An empty QEF — no planes, so [`Qef::solve`] returns the mass point it is given.
    pub fn new() -> Self {
        Self { ata: [[0.0; 3]; 3], atb: Vec3::ZERO, btb: 0.0, planes: 0 }
    }

    /// Add the tangent plane through `p` with (unit) normal `n`. A zero-length normal is ignored — an
    /// SDF gradient can degenerate at a singular point, and a garbage plane would bias the solve.
    pub fn add(&mut self, p: Vec3, n: Vec3) {
        let len = n.length();
        if !len.is_finite() || len < 1e-12 {
            return;
        }
        let n = n * (1.0 / len);
        let d = n.dot(p);
        let na = [n.x, n.y, n.z];
        for r in 0..3 {
            for c in 0..3 {
                self.ata[r][c] += na[r] * na[c];
            }
        }
        self.atb = self.atb + n * d;
        self.btb += d * d;
        self.planes += 1;
    }

    /// How many tangent planes were accumulated.
    pub fn planes(&self) -> usize {
        self.planes
    }

    /// The residual `E(x)` at `x` — zero when `x` lies on every accumulated plane. Clamped at zero
    /// because catastrophic cancellation in the expanded form can round a true zero slightly negative.
    pub fn error(&self, x: Vec3) -> f64 {
        let xa = [x.x, x.y, x.z];
        let mut quad = 0.0;
        for r in 0..3 {
            for c in 0..3 {
                quad += xa[r] * self.ata[r][c] * xa[c];
            }
        }
        (quad - 2.0 * x.dot(self.atb) + self.btb).max(0.0)
    }

    /// Minimize `E`, expressed relative to `mass` — the mean of the crossing points.
    ///
    /// Solving for the offset from `mass` rather than from the origin is what makes the
    /// under-determined cases behave: the pseudo-inverse zeroes the unconstrained directions, so the
    /// answer keeps `mass`'s coordinate along them (a sane, in-cell point) instead of collapsing
    /// toward the origin. Falls back to `mass` outright when there is no data or the solve produces a
    /// non-finite result.
    pub fn solve(&self, mass: Vec3, tol: f64) -> Vec3 {
        if self.planes == 0 {
            return mass;
        }
        // Right-hand side shifted to the mass point: AᵀA·y = Aᵀb - AᵀA·mass, x = mass + y.
        let rhs = self.atb - mat_mul(&self.ata, mass);
        let (vals, vecs) = eigen_sym3(self.ata);
        let max = vals.iter().fold(0.0f64, |m, v| m.max(v.abs()));
        if max <= 0.0 {
            return mass;
        }
        let cutoff = max * tol;
        let mut y = Vec3::ZERO;
        for (j, &lambda) in vals.iter().enumerate() {
            if lambda.abs() <= cutoff {
                continue; // unconstrained direction — keep the mass point's coordinate along it
            }
            let col = Vec3::new(vecs[0][j], vecs[1][j], vecs[2][j]);
            y = y + col * (col.dot(rhs) / lambda);
        }
        let x = mass + y;
        if x.x.is_finite() && x.y.is_finite() && x.z.is_finite() {
            x
        } else {
            mass
        }
    }
}

fn mat_mul(m: &[[f64; 3]; 3], v: Vec3) -> Vec3 {
    let a = [v.x, v.y, v.z];
    let mut o = [0.0; 3];
    for (r, oi) in o.iter_mut().enumerate() {
        for c in 0..3 {
            *oi += m[r][c] * a[c];
        }
    }
    Vec3::new(o[0], o[1], o[2])
}

/// Eigen-decompose a **symmetric** 3×3 matrix by cyclic Jacobi rotation: returns the eigenvalues and
/// the matrix whose COLUMNS are the matching unit eigenvectors (`vecs[row][j]` is component `row` of
/// eigenvector `j`).
///
/// Jacobi repeatedly zeroes the largest off-diagonal entry with a similarity rotation; for a symmetric
/// matrix it converges unconditionally, and at 3×3 that is a handful of iterations. Chosen over a
/// closed-form cubic root because the cubic loses precision badly on the near-degenerate matrices
/// (repeated eigenvalues) that flat and edge cells produce — which is precisely where this is used.
pub fn eigen_sym3(m: [[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = m;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..32 {
        // Pick the largest off-diagonal magnitude to annihilate.
        let (mut p, mut q, mut best) = (0usize, 1usize, 0.0f64);
        for &(i, j) in &[(0usize, 1usize), (0, 2), (1, 2)] {
            let mag = a[i][j].abs();
            if mag > best {
                best = mag;
                p = i;
                q = j;
            }
        }
        if best <= 1e-15 {
            break; // already diagonal to working precision
        }
        // Rotation angle: theta = (a_qq - a_pp) / (2 a_pq); t = tan of the rotation.
        let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
        let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
        let c = 1.0 / (t * t + 1.0).sqrt();
        let s = t * c;

        let (app, aqq, apq) = (a[p][p], a[q][q], a[p][q]);
        a[p][p] = app - t * apq;
        a[q][q] = aqq + t * apq;
        a[p][q] = 0.0;
        a[q][p] = 0.0;
        // The remaining row/column (the index that is neither p nor q).
        let r = 3 - p - q;
        let (arp, arq) = (a[r][p], a[r][q]);
        a[r][p] = c * arp - s * arq;
        a[p][r] = a[r][p];
        a[r][q] = s * arp + c * arq;
        a[q][r] = a[r][q];
        // Accumulate the rotation into the eigenvector basis.
        for row in v.iter_mut() {
            let (vp, vq) = (row[p], row[q]);
            row[p] = c * vp - s * vq;
            row[q] = s * vp + c * vq;
        }
    }
    ([a[0][0], a[1][1], a[2][2]], v)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f64 = 1e-6;

    fn close(a: Vec3, b: Vec3, eps: f64) -> bool {
        (a - b).length() < eps
    }

    #[test]
    fn eigen_recovers_a_known_symmetric_matrix() {
        // Diagonal: eigenvalues ARE the diagonal, eigenvectors the axes (in some order).
        let (vals, _) = eigen_sym3([[3.0, 0.0, 0.0], [0.0, 5.0, 0.0], [0.0, 0.0, 1.0]]);
        let mut sorted = vals;
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!((sorted[0] - 1.0).abs() < EPS);
        assert!((sorted[1] - 3.0).abs() < EPS);
        assert!((sorted[2] - 5.0).abs() < EPS);
    }

    #[test]
    fn eigen_decomposition_reconstructs_the_matrix() {
        // The real contract: A == V·diag(λ)·Vᵀ. Verified on a full (non-diagonal) symmetric matrix,
        // which is what an actual cell's AᵀA looks like.
        let m = [[4.0, 1.0, -2.0], [1.0, 2.0, 0.5], [-2.0, 0.5, 3.0]];
        let (vals, vecs) = eigen_sym3(m);
        for r in 0..3 {
            for c in 0..3 {
                let recon: f64 = (0..3).map(|j| vals[j] * vecs[r][j] * vecs[c][j]).sum();
                assert!((recon - m[r][c]).abs() < EPS, "V·Λ·Vᵀ != A at ({r},{c})");
            }
        }
        // Eigenvectors are orthonormal.
        let cols = [0usize, 1, 2].map(|j| Vec3::new(vecs[0][j], vecs[1][j], vecs[2][j]));
        for (j, col) in cols.iter().enumerate() {
            assert!((col.length() - 1.0).abs() < EPS, "eigenvector {j} is not unit");
        }
    }

    #[test]
    fn three_orthogonal_planes_pin_the_corner_exactly() {
        // THE sharp-feature case: a cube corner. Three axis planes meeting at (2,3,4) — fully
        // determined, so the QEF must land on the corner itself, NOT on the mean of the crossings
        // (which is what surface nets would produce and why it rounds corners off).
        let corner = Vec3::new(2.0, 3.0, 4.0);
        let mut q = Qef::new();
        q.add(Vec3::new(2.0, 9.0, 9.0), Vec3::new(1.0, 0.0, 0.0));
        q.add(Vec3::new(9.0, 3.0, 9.0), Vec3::new(0.0, 1.0, 0.0));
        q.add(Vec3::new(9.0, 9.0, 4.0), Vec3::new(0.0, 0.0, 1.0));
        let mass = Vec3::new(20.0, -7.0, 13.0); // deliberately nowhere near the answer
        let x = q.solve(mass, DEFAULT_TOL);
        assert!(close(x, corner, EPS), "corner not recovered: {x:?}");
        assert!(q.error(x) < EPS, "residual at the exact corner must vanish");
    }

    #[test]
    fn two_planes_pin_an_edge_and_slide_along_it() {
        // An edge is under-determined along its direction: the solve must fix the two constrained
        // axes exactly and leave the third at the mass point rather than drifting or blowing up.
        let mut q = Qef::new();
        q.add(Vec3::new(5.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0)); // x = 5
        q.add(Vec3::new(0.0, 7.0, 0.0), Vec3::new(0.0, 1.0, 0.0)); // y = 7
        let mass = Vec3::new(100.0, 100.0, 42.0);
        let x = q.solve(mass, DEFAULT_TOL);
        assert!((x.x - 5.0).abs() < EPS, "x pinned by plane 1");
        assert!((x.y - 7.0).abs() < EPS, "y pinned by plane 2");
        assert!((x.z - 42.0).abs() < EPS, "z is unconstrained → stays at the mass point");
    }

    #[test]
    fn a_flat_patch_stays_at_the_mass_point_in_plane() {
        // Coplanar normals: rank 1. Only the plane's normal direction is constrained; the other two
        // must keep the mass point's coordinates — this is the case that would explode without the
        // pseudo-inverse, and it is by far the most common cell in a real model.
        let mut q = Qef::new();
        for p in [Vec3::new(0.0, 0.0, 3.0), Vec3::new(5.0, 1.0, 3.0), Vec3::new(-2.0, 4.0, 3.0)] {
            q.add(p, Vec3::new(0.0, 0.0, 1.0)); // the plane z = 3
        }
        let mass = Vec3::new(1.0, 2.0, 9.0);
        let x = q.solve(mass, DEFAULT_TOL);
        assert!((x.z - 3.0).abs() < EPS, "pulled onto the plane");
        assert!((x.x - 1.0).abs() < EPS && (x.y - 2.0).abs() < EPS, "in-plane: mass point kept");
    }

    #[test]
    fn an_empty_qef_and_degenerate_normals_fall_back_to_the_mass_point() {
        let mass = Vec3::new(1.0, 2.0, 3.0);
        assert!(close(Qef::new().solve(mass, DEFAULT_TOL), mass, EPS));

        let mut q = Qef::new();
        q.add(Vec3::new(4.0, 4.0, 4.0), Vec3::ZERO); // a zero gradient is not a plane
        assert_eq!(q.planes(), 0, "a degenerate normal must be rejected, not accumulated");
        assert!(close(q.solve(mass, DEFAULT_TOL), mass, EPS));
    }

    #[test]
    fn the_solution_is_the_least_squares_minimum() {
        // Over-determined and inconsistent (four planes, no common point): the answer is not any one
        // plane but the error minimum — check no nearby point scores lower.
        let mut q = Qef::new();
        q.add(Vec3::new(1.0, 0.0, 0.0), Vec3::new(1.0, 0.0, 0.0));
        q.add(Vec3::new(0.0, 1.0, 0.0), Vec3::new(0.0, 1.0, 0.0));
        q.add(Vec3::new(0.0, 0.0, 1.0), Vec3::new(0.0, 0.0, 1.0));
        q.add(Vec3::new(0.0, 0.0, 0.0), Vec3::new(1.0, 1.0, 1.0).normalize());
        let x = q.solve(Vec3::splat(0.5), DEFAULT_TOL);
        let e = q.error(x);
        for d in [Vec3::new(0.01, 0.0, 0.0), Vec3::new(0.0, 0.01, 0.0), Vec3::new(0.0, 0.0, 0.01)] {
            assert!(q.error(x + d) >= e - 1e-12, "perturbing +{d:?} lowered the error");
            assert!(q.error(x - d) >= e - 1e-12, "perturbing -{d:?} lowered the error");
        }
    }
}
