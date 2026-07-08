//! Minimal `f64` 3-vector + axis-aligned box math for the SDF kernel — dependency-free on purpose
//! (the kernel ships as a lean, WASM-friendly library). `f64` throughout for millimetre precision;
//! STL narrows to `f32` at write time.
use std::ops::{Add, Div, Mul, Neg, Sub};

/// A 3D point / vector in millimetres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 { x: 0.0, y: 0.0, z: 0.0 };

    pub fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }
    pub fn splat(v: f64) -> Self {
        Self { x: v, y: v, z: v }
    }
    pub fn from_arr(a: [f64; 3]) -> Self {
        Self::new(a[0], a[1], a[2])
    }
    pub fn dot(self, o: Vec3) -> f64 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: Vec3) -> Vec3 {
        Vec3::new(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }
    pub fn abs(self) -> Vec3 {
        Vec3::new(self.x.abs(), self.y.abs(), self.z.abs())
    }
    /// Component-wise `max(self, 0)` — the "outside" part of a box/cylinder distance.
    pub fn max0(self) -> Vec3 {
        Vec3::new(self.x.max(0.0), self.y.max(0.0), self.z.max(0.0))
    }
    pub fn cmin(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }
    pub fn cmax(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }
    pub fn max_component(self) -> f64 {
        self.x.max(self.y).max(self.z)
    }
    pub fn normalize(self) -> Vec3 {
        let l = self.length();
        if l == 0.0 {
            self
        } else {
            self * (1.0 / l)
        }
    }
    /// Rotate `self` by `theta` radians about the (assumed-normalized) `axis` — Rodrigues' formula.
    pub fn rotate(self, axis: Vec3, theta: f64) -> Vec3 {
        let (s, c) = theta.sin_cos();
        self * c + axis.cross(self) * s + axis * (axis.dot(self) * (1.0 - c))
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        Vec3::new(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl Mul<f64> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f64) -> Vec3 {
        Vec3::new(self.x * s, self.y * s, self.z * s)
    }
}
impl Div<f64> for Vec3 {
    type Output = Vec3;
    fn div(self, s: f64) -> Vec3 {
        Vec3::new(self.x / s, self.y / s, self.z / s)
    }
}
impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        Vec3::new(-self.x, -self.y, -self.z)
    }
}

/// An axis-aligned bounding box (millimetres). `min > max` on any axis means "empty".
#[derive(Clone, Copy, Debug)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub fn new(min: Vec3, max: Vec3) -> Self {
        Self { min, max }
    }
    /// A box of half-extents `half` centred on the origin.
    pub fn centered(half: Vec3) -> Self {
        Self { min: -half, max: half }
    }
    pub const EMPTY: Aabb = Aabb {
        min: Vec3 { x: f64::INFINITY, y: f64::INFINITY, z: f64::INFINITY },
        max: Vec3 { x: f64::NEG_INFINITY, y: f64::NEG_INFINITY, z: f64::NEG_INFINITY },
    };
    pub fn union(self, o: Aabb) -> Aabb {
        Aabb::new(self.min.cmin(o.min), self.max.cmax(o.max))
    }
    pub fn intersection(self, o: Aabb) -> Aabb {
        Aabb::new(self.min.cmax(o.min), self.max.cmin(o.max))
    }
    pub fn expand(self, pad: f64) -> Aabb {
        Aabb::new(self.min - Vec3::splat(pad), self.max + Vec3::splat(pad))
    }
    pub fn size(self) -> Vec3 {
        self.max - self.min
    }
    pub fn is_empty(self) -> bool {
        self.min.x > self.max.x || self.min.y > self.max.y || self.min.z > self.max.z
    }
    pub fn corners(self) -> [Vec3; 8] {
        let (a, b) = (self.min, self.max);
        [
            Vec3::new(a.x, a.y, a.z),
            Vec3::new(b.x, a.y, a.z),
            Vec3::new(a.x, b.y, a.z),
            Vec3::new(b.x, b.y, a.z),
            Vec3::new(a.x, a.y, b.z),
            Vec3::new(b.x, a.y, b.z),
            Vec3::new(a.x, b.y, b.z),
            Vec3::new(b.x, b.y, b.z),
        ]
    }
}
