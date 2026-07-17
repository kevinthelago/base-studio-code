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
    let mut decoder = png::Decoder::new(bytes);
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| format!("not a decodable PNG: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
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

/// Crop `png_bytes` to `rect`, returning `(png, w, h)`.
///
/// The rect is CLAMPED to the image rather than rejected: the frontend measures a
/// `getBoundingClientRect()` that can legitimately sit a pixel past the edge (fractional CSS px,
/// rounding, a scrollbar), and failing the whole capture over one pixel would make the loop flaky for
/// no benefit. A rect entirely outside the image IS an error — that is a real caller bug, not rounding.
pub fn crop_png(png_bytes: &[u8], rect: Rect) -> Result<(Vec<u8>, u32, u32), String> {
    let img = decode_rgba(png_bytes)?;

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
    let decoder = png::Decoder::new(png_bytes);
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
        let (out, w, h) = crop_png(&src, Rect { x: 10, y: 20, w: 30, h: 40 }).unwrap();
        assert_eq!((w, h), (30, 40));
        // The crop's (0,0) must be the source's (10,20) — not merely a 30x40 image.
        assert_eq!(pixel_at(&out, 0, 0), [10, 20, 0, 255]);
        assert_eq!(pixel_at(&out, 29, 39), [39, 59, 0, 255]);
    }

    #[test]
    fn a_full_size_rect_is_the_whole_image() {
        let src = coord_png(8, 6);
        let (out, w, h) = crop_png(&src, Rect { x: 0, y: 0, w: 8, h: 6 }).unwrap();
        assert_eq!((w, h), (8, 6));
        assert_eq!(pixel_at(&out, 7, 5), [7, 5, 0, 255]);
    }

    #[test]
    fn a_rect_overhanging_the_edge_clamps_instead_of_failing() {
        // The real case: a getBoundingClientRect() lands a pixel past the edge (fractional CSS px,
        // rounding, a scrollbar). Failing the capture over that would make the loop flaky for nothing.
        let src = coord_png(20, 20);
        let (out, w, h) = crop_png(&src, Rect { x: 15, y: 15, w: 999, h: 999 }).unwrap();
        assert_eq!((w, h), (5, 5), "clamped to what actually exists");
        assert_eq!(pixel_at(&out, 0, 0), [15, 15, 0, 255]);
    }

    #[test]
    fn a_rect_entirely_outside_the_image_is_a_real_error() {
        // Distinct from the overhang case: this is a caller bug, not rounding — say so.
        let src = coord_png(20, 20);
        let err = crop_png(&src, Rect { x: 20, y: 0, w: 5, h: 5 }).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert!(crop_png(&src, Rect { x: 0, y: 99, w: 5, h: 5 }).is_err());
    }

    #[test]
    fn the_crop_output_is_a_real_png() {
        let src = coord_png(10, 10);
        let (out, _, _) = crop_png(&src, Rect { x: 1, y: 1, w: 4, h: 4 }).unwrap();
        assert!(bsc_shot::is_png(&out), "the CLI verifies PNG magic before reporting success");
    }

    #[test]
    fn garbage_in_is_an_error_not_a_panic() {
        assert!(crop_png(b"not-a-png", Rect { x: 0, y: 0, w: 1, h: 1 }).is_err());
        assert!(png_dimensions(b"").is_err());
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
        let (out, w, h) = crop_png(&rgb, Rect { x: 0, y: 0, w: 2, h: 1 }).unwrap();
        assert_eq!((w, h), (2, 1));
        assert_eq!(pixel_at(&out, 0, 0), [1, 2, 3, 255], "RGB gains an opaque alpha");
        assert_eq!(pixel_at(&out, 1, 0), [4, 5, 6, 255]);
    }
}
