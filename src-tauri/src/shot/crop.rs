//! PNG crop (#3261) — the pure half of the capture path.
//!
//! `CapturePreview` hands back a PNG of the WHOLE webview; a caller that asked for `--rect` wants one
//! component. Cropping means decode → slice → re-encode, so it is kept here, pure and unit-tested,
//! away from the COM code that cannot run under `cargo test`.
//!
//! Uses `png` directly rather than `image`: it is already in the tree (transitively), it is the only
//! format `CapturePreview` emits, and it keeps the desktop binary from growing a whole codec matrix.

use bsc_shot::Rect;

/// Decoded RGBA8 pixels + dimensions.
struct Rgba {
    w: u32,
    h: u32,
    /// `w * h * 4` bytes.
    px: Vec<u8>,
}

/// Decode a PNG to RGBA8. `CapturePreview` emits RGBA8, but a PNG can legally be RGB/palette/16-bit —
/// so normalise rather than assume, or a future WebView2 change silently corrupts every crop.
fn decode_rgba(bytes: &[u8]) -> Result<Rgba, String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| format!("not a decodable PNG: {e}"))?;
    // png 0.18 returns None when the frame's buffer size would overflow `usize`.
    let size = reader.output_buffer_size().ok_or("PNG frame too large to decode")?;
    let mut buf = vec![0u8; size];
    let info = reader.next_frame(&mut buf).map_err(|e| format!("cannot read PNG pixels: {e}"))?;
    buf.truncate(info.buffer_size());

    let (w, h) = (info.width, info.height);
    let px = match info.color_type {
        png::ColorType::Rgba => buf,
        png::ColorType::Rgb => buf.chunks_exact(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        png::ColorType::Grayscale => buf.iter().flat_map(|&g| [g, g, g, 255]).collect(),
        png::ColorType::GrayscaleAlpha => buf.chunks_exact(2).flat_map(|p| [p[0], p[0], p[0], p[1]]).collect(),
        other => return Err(format!("unsupported PNG colour type: {other:?}")),
    };
    Ok(Rgba { w, h, px })
}

fn encode_rgba(img: &Rgba) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = vec![];
    {
        let mut encoder = png::Encoder::new(&mut out, img.w, img.h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| format!("cannot write PNG header: {e}"))?;
        writer.write_image_data(&img.px).map_err(|e| format!("cannot write PNG pixels: {e}"))?;
    }
    Ok(out)
}

/// Map a CSS-pixel rect onto the DEVICE-pixel grid of the capture (#3467).
///
/// `CapturePreview` emits **device** pixels; `getBoundingClientRect()` — and therefore every `--rect`
/// and named-target caller — is in **CSS** pixels. On a HiDPI display those differ by `scale`, so
/// applying a CSS rect directly took roughly the top-left `1/scale` of the intended region. It failed
/// *silently*: the clamp below absorbed the overhang instead of erroring, so the shot looked plausible
/// while showing the wrong thing — the worst possible failure for a loop whose premise is that the
/// shot is ground truth.
///
/// The origin floors and the far edge ceils, so a fractional CSS box never drops a device pixel it
/// partially covers. A non-finite or non-positive scale is treated as 1.0 rather than panicking.
fn to_device(rect: Rect, scale: f64) -> Rect {
    let s = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let x = (rect.x as f64 * s).floor();
    let y = (rect.y as f64 * s).floor();
    let right = ((rect.x as f64 + rect.w as f64) * s).ceil();
    let bottom = ((rect.y as f64 + rect.h as f64) * s).ceil();
    Rect {
        x: x as u32,
        y: y as u32,
        w: (right - x).max(1.0) as u32,
        h: (bottom - y).max(1.0) as u32,
    }
}

/// Crop `png_bytes` to `rect`, returning `(png, w, h)`.
///
/// `rect` is in **CSS pixels**; `scale` is the capture's device-pixels-per-CSS-pixel ratio (1.0 on a
/// standard display, 2.0 on a typical HiDPI one) and is applied here so EVERY crop path — explicit
/// `--rect`, a named target, and component targeting — is corrected in one place (#3467). Callers
/// derive the scale from the capture, never from user input.
///
/// The rect is CLAMPED to the image rather than rejected: the frontend measures a
/// `getBoundingClientRect()` that can legitimately sit a pixel past the edge (fractional CSS px,
/// rounding, a scrollbar), and failing the whole capture over one pixel would make the loop flaky for
/// no benefit. A rect entirely outside the image IS an error — that is a real caller bug, not rounding.
pub fn crop_png(png_bytes: &[u8], rect: Rect, scale: f64) -> Result<(Vec<u8>, u32, u32), String> {
    let img = decode_rgba(png_bytes)?;
    let rect = to_device(rect, scale);

    if rect.x >= img.w || rect.y >= img.h {
        return Err(format!(
            "rect origin ({},{}) is outside the {}x{} capture",
            rect.x, rect.y, img.w, img.h
        ));
    }
    let w = rect.w.min(img.w - rect.x);
    let h = rect.h.min(img.h - rect.y);
    if w == 0 || h == 0 {
        return Err(format!("rect {}x{} at ({},{}) clamps to zero pixels", rect.w, rect.h, rect.x, rect.y));
    }

    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        let src_y = (rect.y + row) as usize;
        let start = (src_y * img.w as usize + rect.x as usize) * 4;
        let end = start + (w as usize) * 4;
        px.extend_from_slice(&img.px[start..end]);
    }
    let out = encode_rgba(&Rgba { w, h, px })?;
    Ok((out, w, h))
}

/// Dimensions of a PNG without decoding its pixels — for the whole-webview (no-crop) path, which
/// still has to report `w`/`h` in the response.
pub fn png_dimensions(png_bytes: &[u8]) -> Result<(u32, u32), String> {
    let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
    let reader = decoder.read_info().map_err(|e| format!("not a decodable PNG: {e}"))?;
    let info = reader.info();
    Ok((info.width, info.height))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `w`x`h` PNG whose every pixel encodes its own coordinate, so a crop can be proven to have taken
    /// the RIGHT pixels rather than merely the right NUMBER of them.
    fn coord_png(w: u32, h: u32) -> Vec<u8> {
        let mut px = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                px.extend_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        encode_rgba(&Rgba { w, h, px }).unwrap()
    }

    fn pixel_at(png_bytes: &[u8], x: u32, y: u32) -> [u8; 4] {
        let img = decode_rgba(png_bytes).unwrap();
        let i = ((y * img.w + x) * 4) as usize;
        [img.px[i], img.px[i + 1], img.px[i + 2], img.px[i + 3]]
    }

    #[test]
    fn crops_to_the_requested_region_and_takes_the_right_pixels() {
        let src = coord_png(100, 80);
        let (out, w, h) = crop_png(&src, Rect { x: 10, y: 20, w: 30, h: 40 }, 1.0).unwrap();
        assert_eq!((w, h), (30, 40));
        // The crop's (0,0) must be the source's (10,20) — not merely a 30x40 image.
        assert_eq!(pixel_at(&out, 0, 0), [10, 20, 0, 255]);
        assert_eq!(pixel_at(&out, 29, 39), [39, 59, 0, 255]);
    }

    #[test]
    fn a_full_size_rect_is_the_whole_image() {
        let src = coord_png(8, 6);
        let (out, w, h) = crop_png(&src, Rect { x: 0, y: 0, w: 8, h: 6 }, 1.0).unwrap();
        assert_eq!((w, h), (8, 6));
        assert_eq!(pixel_at(&out, 7, 5), [7, 5, 0, 255]);
    }

    #[test]
    fn a_rect_overhanging_the_edge_clamps_instead_of_failing() {
        // The real case: a getBoundingClientRect() lands a pixel past the edge (fractional CSS px,
        // rounding, a scrollbar). Failing the capture over that would make the loop flaky for nothing.
        let src = coord_png(20, 20);
        let (out, w, h) = crop_png(&src, Rect { x: 15, y: 15, w: 999, h: 999 }, 1.0).unwrap();
        assert_eq!((w, h), (5, 5), "clamped to what actually exists");
        assert_eq!(pixel_at(&out, 0, 0), [15, 15, 0, 255]);
    }

    #[test]
    fn a_rect_entirely_outside_the_image_is_a_real_error() {
        // Distinct from the overhang case: this is a caller bug, not rounding — say so.
        let src = coord_png(20, 20);
        let err = crop_png(&src, Rect { x: 20, y: 0, w: 5, h: 5 }, 1.0).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(crop_png(&src, Rect { x: 0, y: 99, w: 5, h: 5 }, 1.0).is_err());
    }

    #[test]
    fn the_crop_output_is_a_real_png() {
        let src = coord_png(10, 10);
        let (out, _, _) = crop_png(&src, Rect { x: 1, y: 1, w: 4, h: 4 }, 1.0).unwrap();
        assert!(bsc_shot::is_png(&out), "the CLI verifies PNG magic before reporting success");
    }

    #[test]
    fn garbage_in_is_an_error_not_a_panic() {
        assert!(crop_png(b"not-a-png", Rect { x: 0, y: 0, w: 1, h: 1 }, 1.0).is_err());
        assert!(png_dimensions(b"").is_err());
    }

    // ── HiDPI: a CSS-pixel rect against a device-pixel capture (#3467) ────────────────────────────

    #[test]
    fn a_css_rect_maps_onto_the_device_grid_at_dpr_2() {
        // THE REGRESSION. The capture is 2x the CSS viewport, so CSS (10,20 30x40) is device
        // (20,40 60x80). Before the fix the rect was used verbatim and this took (10,20 30x40) —
        // the top-left quarter of the intended region, silently.
        let src = coord_png(200, 160); // a 100x80 CSS viewport captured at DPR 2
        let (out, w, h) = crop_png(&src, Rect { x: 10, y: 20, w: 30, h: 40 }, 2.0).unwrap();
        assert_eq!((w, h), (60, 80), "the crop covers the region in DEVICE pixels");
        assert_eq!(pixel_at(&out, 0, 0), [20, 40, 0, 255], "origin scaled, not copied");
        assert_eq!(pixel_at(&out, 59, 79), [79, 119, 0, 255]);
    }

    #[test]
    fn a_fractional_scale_never_drops_a_partially_covered_pixel() {
        // DPR 1.5: CSS (3,5 10x10) → device x=4.5→floor 4, right=19.5→ceil 20 ⇒ w=16. Ceiling the far
        // edge (rather than scaling the width) is what keeps a fractional box from losing its last row.
        let src = coord_png(60, 60);
        let (_, w, h) = crop_png(&src, Rect { x: 3, y: 5, w: 10, h: 10 }, 1.5).unwrap();
        assert_eq!((w, h), (16, 16), "floor the origin, ceil the far edge");
    }

    #[test]
    fn scale_1_is_byte_identical_to_the_unscaled_crop() {
        // The standard-DPI path must be untouched by the fix.
        let src = coord_png(40, 40);
        let a = crop_png(&src, Rect { x: 7, y: 9, w: 11, h: 13 }, 1.0).unwrap();
        assert_eq!((a.1, a.2), (11, 13));
        assert_eq!(pixel_at(&a.0, 0, 0), [7, 9, 0, 255]);
    }

    #[test]
    fn an_implausible_scale_falls_back_to_1_rather_than_panicking() {
        // A wrong-but-sane crop beats a panic mid-loop; 0/negative/NaN can only come from a broken
        // window query, and the caller already clamps — this is the last line of defence.
        let src = coord_png(30, 30);
        for bad in [0.0, -2.0, f64::NAN, f64::INFINITY] {
            let (_, w, h) = crop_png(&src, Rect { x: 5, y: 5, w: 10, h: 10 }, bad).unwrap();
            assert_eq!((w, h), (10, 10), "scale {bad} treated as 1.0");
        }
    }

    #[test]
    fn a_scaled_rect_still_clamps_at_the_edge_instead_of_failing() {
        // Scaling must not turn a legitimate overhang into a hard error.
        let src = coord_png(40, 40); // 20x20 CSS at DPR 2
        let (_, w, h) = crop_png(&src, Rect { x: 15, y: 15, w: 10, h: 10 }, 2.0).unwrap();
        assert_eq!((w, h), (10, 10), "device origin (30,30) with 10 device px left in each axis");
    }

    #[test]
    fn dimensions_read_without_decoding_pixels() {
        assert_eq!(png_dimensions(&coord_png(37, 11)).unwrap(), (37, 11));
    }

    #[test]
    fn a_non_rgba_source_is_normalised_rather_than_corrupted() {
        // CapturePreview emits RGBA today; a PNG can legally be RGB. Normalise, don't assume.
        let mut rgb: Vec<u8> = vec![];
        {
            let mut enc = png::Encoder::new(&mut rgb, 2, 1);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().unwrap();
            w.write_image_data(&[1, 2, 3, 4, 5, 6]).unwrap();
        }
        let (out, w, h) = crop_png(&rgb, Rect { x: 0, y: 0, w: 2, h: 1 }, 1.0).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(pixel_at(&out, 0, 0), [1, 2, 3, 255], "RGB gains an opaque alpha");
        assert_eq!(pixel_at(&out, 1, 0), [4, 5, 6, 255]);
    }
}
