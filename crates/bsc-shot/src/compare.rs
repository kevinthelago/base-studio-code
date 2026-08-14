//! Visual comparison for `bsc shot` (#shot-baseline-and-diff-a-measured-visual-verdict) — how much did
//! this render change, and WHERE.
//!
//! ## Why not a hash, and why not a pixel count
//!
//! Designer request #65 asked for "pixel diff or at minimum a hash comparison". Both were measured
//! against reality first, by capturing the SAME component twice with nothing changed:
//!
//! ```text
//! 419x495 both     pixels differing: 5,291/207,405 (2.6%)
//!                  mean abs difference: 0.33/255
//! ```
//!
//! A **hash** is the worst of the options: byte-identical renders essentially never happen, so every
//! component would report `changed` on every run and the tool would be ignored within a day. A **count**
//! of differing pixels carries a ~2.6% floor for the same reason.
//!
//! The AMPLITUDE, though, is 0.33 of 255 — about a tenth of a percent. Many pixels, all barely
//! different, is the fingerprint of anti-aliasing and subpixel text rendering. So the metric measures
//! how MUCH pixels moved, not how many.
//!
//! ## Why a tile grid
//!
//! Overall amplitude alone cannot separate "a button lost its border" from "the whole image is 0.3
//! noisier": a small real change is diluted across the full frame. But a real change is
//! **concentrated** and AA noise is **uniform**, so the worst TILE is the discriminator — and it also
//! answers *where*, which a single global number never can.
//!
//! ## What this deliberately does NOT do
//!
//! - **No pixels leave.** Everything here reduces to scalars; the caller reports numbers, never image
//!   data. That was the requirement and it is also the cheap path.
//! - **No baked threshold, and no boolean.** "Same" depends on a subject's own measured noise floor —
//!   the two-captures-of-nothing number above — so the tolerance is the caller's to supply. A constant
//!   picked here would be a guess wearing a number's clothes.
//! - **No rescaling.** Different dimensions are their own outcome, not something to normalise away.

/// Decode a PNG file to RGBA8. Normalises colour type rather than assuming, because a capture is not the
/// only thing that can land in a baseline directory — a hand-placed reference PNG is legitimate input.
pub fn load(path: &std::path::Path) -> Result<Image, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut dec = png::Decoder::new(std::io::Cursor::new(bytes));
    dec.set_transformations(png::Transformations::normalize_to_color8());
    let mut r = dec.read_info().map_err(|e| format!("{} is not a decodable PNG: {e}", path.display()))?;
    let size = r.output_buffer_size().ok_or("PNG frame too large to decode")?;
    let mut buf = vec![0u8; size];
    let info = r.next_frame(&mut buf).map_err(|e| format!("cannot read pixels from {}: {e}", path.display()))?;
    buf.truncate(info.buffer_size());
    let px = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        other => return Err(format!("unsupported PNG colour type: {other:?}")),
    };
    Ok(Image { w: info.width, h: info.height, px })
}

/// A decoded image: RGBA8, `w * h * 4` bytes.
pub struct Image {
    pub w: u32,
    pub h: u32,
    pub px: Vec<u8>,
}

/// The comparison verdict — scalars only, by design.
///
/// camelCase on the wire to match every other `--json` surface in `bsc` (and the documented field names
/// in `shot diff help`); snake_case in Rust.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// Mean absolute RGB difference over every pixel, normalised to `0.0..=1.0`.
    ///
    /// The measured anti-aliasing floor sits near `0.0013` (0.33/255), so a tolerance in the low
    /// thousandths distinguishes "re-rendered" from "changed" without hard-coding either.
    pub distance: f64,
    /// The highest per-tile mean absolute difference, same scale. A CONCENTRATED change shows here even
    /// when `distance` stays tiny — which is the case the global number cannot see.
    pub worst_tile: f64,
    /// Which tile that was, as `[col, row]` on the [`TILES`]-square grid. The answer to "where".
    pub tile: [u32; 2],
    /// Fraction of pixels whose RGB differs at all, `0.0..=1.0`. Reported for continuity with the
    /// original request — NOT a verdict input, because its floor was measured at 2.6%.
    pub changed_fraction: f64,
}

/// Grid resolution for the locality pass. Small on purpose: the tile must be big enough that AA noise
/// averages out inside it, and small enough that one changed control does not vanish into it.
pub const TILES: u32 = 8;

/// Why two images could not be compared at all — a stated outcome rather than a swallowed error.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum Mismatch {
    /// The renders are different sizes. NEVER rescaled to force a comparison: a size change means the
    /// layout moved, which is the loudest signal this pipeline can receive, and normalising it away
    /// would convert the strongest evidence into a small blur.
    Dimensions { baseline: [u32; 2], current: [u32; 2] },
}

/// Compare `current` against `baseline`.
///
/// `Err(Mismatch)` is a real answer, not a failure to compute one.
pub fn compare(baseline: &Image, current: &Image) -> Result<Diff, Mismatch> {
    if baseline.w != current.w || baseline.h != current.h {
        return Err(Mismatch::Dimensions {
            baseline: [baseline.w, baseline.h],
            current: [current.w, current.h],
        });
    }
    let (w, h) = (baseline.w, baseline.h);
    if w == 0 || h == 0 {
        return Ok(Diff { distance: 0.0, worst_tile: 0.0, tile: [0, 0], changed_fraction: 0.0 });
    }

    // Per-tile accumulators, plus the whole-image totals. One pass over the pixels: the tile a pixel
    // belongs to is arithmetic, so there is no reason to walk the image once per tile.
    let mut tile_sum = vec![0f64; (TILES * TILES) as usize];
    let mut tile_n = vec![0f64; (TILES * TILES) as usize];
    let mut total = 0f64;
    let mut changed = 0u64;

    for y in 0..h {
        let ty = (y * TILES / h).min(TILES - 1);
        for x in 0..w {
            let i = ((y as usize * w as usize) + x as usize) * 4;
            // ALPHA IS EXCLUDED. The capture is opaque, and a transparent pixel's RGB is undefined —
            // comparing it would report differences in bytes nobody can see.
            let d = (baseline.px[i].abs_diff(current.px[i]) as f64
                + baseline.px[i + 1].abs_diff(current.px[i + 1]) as f64
                + baseline.px[i + 2].abs_diff(current.px[i + 2]) as f64)
                / 3.0;
            if d > 0.0 {
                changed += 1;
            }
            total += d;
            let tx = (x * TILES / w).min(TILES - 1);
            let t = (ty * TILES + tx) as usize;
            tile_sum[t] += d;
            tile_n[t] += 1.0;
        }
    }

    let px_count = (w as f64) * (h as f64);
    let mut worst = 0f64;
    let mut worst_at = [0u32, 0];
    for t in 0..tile_sum.len() {
        if tile_n[t] == 0.0 {
            continue;
        }
        let mean = tile_sum[t] / tile_n[t] / 255.0;
        if mean > worst {
            worst = mean;
            worst_at = [(t as u32) % TILES, (t as u32) / TILES];
        }
    }

    Ok(Diff {
        distance: total / px_count / 255.0,
        worst_tile: worst,
        tile: worst_at,
        changed_fraction: changed as f64 / px_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A solid image of one colour.
    fn solid(w: u32, h: u32, rgb: [u8; 3]) -> Image {
        Image { w, h, px: (0..w * h).flat_map(|_| [rgb[0], rgb[1], rgb[2], 255]).collect() }
    }

    #[test]
    fn the_json_field_names_are_camel_case_as_the_help_documents() {
        // `shot diff help` names `worstTile`/`changedFraction`; a snake_case wire shape would make the
        // documentation wrong for every consumer that reads `--json`.
        let j = serde_json::to_string(&Diff { distance: 0.5, worst_tile: 0.25, tile: [1, 2], changed_fraction: 0.1 }).unwrap();
        assert!(j.contains("\"worstTile\""), "{j}");
        assert!(j.contains("\"changedFraction\""), "{j}");
    }

    #[test]
    fn an_image_compared_with_itself_is_exactly_zero() {
        let a = solid(64, 64, [30, 40, 50]);
        let d = compare(&a, &a).unwrap();
        assert_eq!(d.distance, 0.0);
        assert_eq!(d.worst_tile, 0.0);
        assert_eq!(d.changed_fraction, 0.0);
    }

    #[test]
    fn a_localised_change_shows_in_the_tile_even_though_the_overall_distance_stays_tiny() {
        // THE case the metric exists for, and the one a global average cannot see. One tile of a 8x8
        // grid is blacked out: 1/64th of the image, so the overall number is diluted ~64x while the
        // tile itself is unmistakable.
        let base = solid(64, 64, [255, 255, 255]);
        let mut cur = solid(64, 64, [255, 255, 255]);
        for y in 8..16 {
            for x in 16..24 {
                let i = ((y * 64) + x) * 4;
                cur.px[i] = 0;
                cur.px[i + 1] = 0;
                cur.px[i + 2] = 0;
            }
        }
        let d = compare(&base, &cur).unwrap();
        assert!(d.distance < 0.02, "diluted across the frame: {}", d.distance);
        assert!(d.worst_tile > 0.9, "but unmistakable in its own tile: {}", d.worst_tile);
        assert_eq!(d.tile, [2, 1], "and it says WHERE");
    }

    #[test]
    fn uniform_antialiasing_noise_does_not_read_as_a_change() {
        // The MEASURED shape from two captures of an unchanged component: ~2.6% of pixels differing at
        // an amplitude near 0.33/255. This is the false positive the whole design exists to avoid, so it
        // is pinned with the real numbers rather than a guess.
        let base = solid(100, 100, [128, 128, 128]);
        let mut cur = solid(100, 100, [128, 128, 128]);
        for k in 0..(100 * 100 * 26 / 1000) {
            let i = (k * 37 % (100 * 100)) * 4; // scattered, not clustered — AA is not local
            cur.px[i] = 141; // ~13/255 on 2.6% of pixels ⇒ ~0.33/255 mean, the measured floor
            cur.px[i + 1] = 141;
            cur.px[i + 2] = 141;
        }
        let d = compare(&base, &cur).unwrap();
        assert!(d.changed_fraction > 0.02, "the COUNT metric would call this changed: {}", d.changed_fraction);
        assert!(d.distance < 0.005, "amplitude stays at the noise floor: {}", d.distance);
        assert!(d.worst_tile < 0.02, "and it is uniform, so no tile stands out: {}", d.worst_tile);
    }

    #[test]
    fn different_dimensions_are_reported_not_rescaled() {
        // A resized render means the layout moved — the loudest evidence available. Rescaling to force a
        // number would turn it into a small blur.
        let a = solid(64, 64, [0, 0, 0]);
        let b = solid(64, 65, [0, 0, 0]);
        assert_eq!(
            compare(&a, &b),
            Err(Mismatch::Dimensions { baseline: [64, 64], current: [64, 65] })
        );
    }

    #[test]
    fn a_wholesale_repaint_saturates_both_numbers() {
        let a = solid(32, 32, [0, 0, 0]);
        let b = solid(32, 32, [255, 255, 255]);
        let d = compare(&a, &b).unwrap();
        assert_eq!(d.distance, 1.0);
        assert_eq!(d.worst_tile, 1.0);
        assert_eq!(d.changed_fraction, 1.0);
    }

    #[test]
    fn an_empty_image_is_not_an_error() {
        // A zero-size capture is degenerate but not a crash — the caller decides what to make of it.
        let a = Image { w: 0, h: 0, px: vec![] };
        assert_eq!(compare(&a, &a).unwrap().distance, 0.0);
    }
}
