//! Metadata stripping for JPEG originals: removes APP1 EXIF/XMP segments (GPS, camera, time).
//! The EXIF orientation is kept as a minimal EXIF block so the image still displays upright.
//! Other formats (HEIC, PNG, TIFF, DNG) are copied unchanged.

use std::io::{self, Read, Seek, SeekFrom};

const EXIF_SIG: [u8; 6] = [b'E', b'x', b'i', b'f', 0, 0];
const XMP_SIG: &[u8] = b"http://ns.adobe.com/xap/1.0/";

/// What to cut from one JPEG.
pub struct Plan {
    /// Byte ranges `[start, end)` of segments to drop.
    removed: Vec<(u64, u64)>,
    /// EXIF orientation (2-8) to re-insert as a minimal block; `None` when upright or unknown.
    orientation: Option<u16>,
    total: u64,
}

impl Plan {
    pub fn is_noop(&self) -> bool {
        self.removed.is_empty()
    }

    /// Size of the file after [`apply`](Self::apply).
    pub fn output_len(&self) -> u64 {
        let removed: u64 = self.removed.iter().map(|(s, e)| e - s).sum();
        let added = self.orientation.map_or(0, |o| orientation_block(o).len() as u64);
        self.total - removed + added
    }

    pub fn apply(&self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        out.extend_from_slice(&data[..2]);
        if let Some(o) = self.orientation {
            out.extend_from_slice(&orientation_block(o));
        }
        let mut pos = 2usize;
        for &(s, e) in &self.removed {
            out.extend_from_slice(&data[pos..s as usize]);
            pos = e as usize;
        }
        out.extend_from_slice(&data[pos..]);
        out
    }
}

/// APP1 segment holding only the orientation tag (big endian TIFF).
fn orientation_block(orientation: u16) -> Vec<u8> {
    let mut b = vec![0xFF, 0xE1, 0x00, 0x22];
    b.extend_from_slice(&EXIF_SIG);
    b.extend_from_slice(&[b'M', b'M', 0, 0x2A, 0, 0, 0, 8]);
    b.extend_from_slice(&1u16.to_be_bytes());
    b.extend_from_slice(&0x0112u16.to_be_bytes());
    b.extend_from_slice(&3u16.to_be_bytes());
    b.extend_from_slice(&1u32.to_be_bytes());
    b.extend_from_slice(&orientation.to_be_bytes());
    b.extend_from_slice(&[0, 0]);
    b.extend_from_slice(&0u32.to_be_bytes());
    b
}

fn tiff_orientation(tiff: &[u8]) -> Option<u16> {
    let big = match tiff.get(..2)? {
        b"MM" => true,
        b"II" => false,
        _ => return None,
    };
    let u16_at = |o: usize| -> Option<u16> {
        let b: [u8; 2] = tiff.get(o..o + 2)?.try_into().ok()?;
        Some(if big {
            u16::from_be_bytes(b)
        } else {
            u16::from_le_bytes(b)
        })
    };
    let u32_at = |o: usize| -> Option<u32> {
        let b: [u8; 4] = tiff.get(o..o + 4)?.try_into().ok()?;
        Some(if big {
            u32::from_be_bytes(b)
        } else {
            u32::from_le_bytes(b)
        })
    };
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    (0..count).find_map(|i| {
        let e = ifd + 2 + i * 12;
        (u16_at(e)? == 0x0112).then(|| u16_at(e + 8)).flatten()
    })
}

/// Scans the segment headers of a JPEG. `None` when `r` is not a JPEG.
pub fn plan<R: Read + Seek>(mut r: R) -> io::Result<Option<Plan>> {
    let total = r.seek(SeekFrom::End(0))?;
    r.seek(SeekFrom::Start(0))?;
    let mut soi = [0u8; 2];
    if r.read_exact(&mut soi).is_err() || soi != [0xFF, 0xD8] {
        return Ok(None);
    }
    let mut removed = Vec::new();
    let mut orientation = None;
    let mut pos = 2u64;
    loop {
        let mut m = [0u8; 2];
        if r.read_exact(&mut m).is_err() || m[0] != 0xFF {
            break;
        }
        if m[1] == 0xFF {
            // Fill byte: the marker starts one byte later.
            pos += 1;
            r.seek(SeekFrom::Start(pos))?;
            continue;
        }
        // SOS and EOI end the header part; standalone markers have no length.
        if m[1] == 0xDA || m[1] == 0xD9 {
            break;
        }
        if m[1] == 0x01 || (0xD0..=0xD8).contains(&m[1]) {
            pos += 2;
            continue;
        }
        let mut len = [0u8; 2];
        if r.read_exact(&mut len).is_err() {
            break;
        }
        let len = u16::from_be_bytes(len) as u64;
        if len < 2 || pos + 2 + len > total {
            break;
        }
        if m[1] == 0xE1 {
            let mut payload = vec![0u8; (len - 2) as usize];
            r.read_exact(&mut payload)?;
            if payload.starts_with(&EXIF_SIG) {
                removed.push((pos, pos + 2 + len));
                if orientation.is_none() {
                    orientation =
                        tiff_orientation(&payload[EXIF_SIG.len()..]).filter(|o| (2..=8).contains(o));
                }
            } else if payload.starts_with(XMP_SIG) {
                removed.push((pos, pos + 2 + len));
            }
        }
        pos += 2 + len;
        r.seek(SeekFrom::Start(pos))?;
    }
    Ok(Some(Plan {
        removed,
        orientation,
        total,
    }))
}

/// `data` without EXIF/XMP, or `None` when it is not a JPEG or has nothing to strip.
pub fn strip(data: &[u8]) -> Option<Vec<u8>> {
    let plan = plan(io::Cursor::new(data)).ok()??;
    (!plan.is_noop()).then(|| plan.apply(data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app1(payload: &[u8]) -> Vec<u8> {
        let mut s = vec![0xFF, 0xE1];
        s.extend_from_slice(&((payload.len() + 2) as u16).to_be_bytes());
        s.extend_from_slice(payload);
        s
    }

    fn sample(orientation: u16) -> Vec<u8> {
        let mut j = vec![0xFF, 0xD8];
        j.extend(orientation_block(orientation));
        j.extend(app1(&[XMP_SIG, &[0], b"<x/>"].concat()));
        j.extend([0xFF, 0xE2, 0x00, 0x04, 1, 2]);
        j.extend([0xFF, 0xDA, 0x00, 0x02, 0xAA, 0xBB, 0xFF, 0xD9]);
        j
    }

    #[test]
    fn strips_exif_and_xmp_keeps_the_rest_and_orientation() {
        let src = sample(6);
        let out = strip(&src).unwrap();
        assert!(!out.windows(4).any(|w| w == b"<x/>"));
        assert!(out.windows(6).any(|w| w == [0xFF, 0xE2, 0x00, 0x04, 1, 2]));
        let p = plan(io::Cursor::new(&src)).unwrap().unwrap();
        assert_eq!(p.output_len(), out.len() as u64);
        let again = plan(io::Cursor::new(&out)).unwrap().unwrap();
        assert_eq!(again.orientation, Some(6));
    }

    #[test]
    fn upright_images_lose_exif_entirely() {
        let out = strip(&sample(1)).unwrap();
        assert!(!out.windows(4).any(|w| w == b"Exif"));
    }

    #[test]
    fn non_jpeg_is_left_alone() {
        assert!(strip(b"PNG....").is_none());
    }
}
