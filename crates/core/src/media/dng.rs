//! Find the embedded preview JPEG of a DNG (TIFF container) without decoding the raw data.

use std::collections::HashSet;

const TAG_COMPRESSION: u16 = 0x0103;
const TAG_ORIENTATION: u16 = 0x0112;
const TAG_STRIP_OFFSETS: u16 = 0x0111;
const TAG_STRIP_COUNTS: u16 = 0x0117;
const TAG_SUB_IFDS: u16 = 0x014A;
const TAG_JPEG_OFFSET: u16 = 0x0201;
const TAG_JPEG_LEN: u16 = 0x0202;
const MAX_IFDS: usize = 64;

pub(crate) struct Preview {
    /// Byte ranges (offset, length) of candidate JPEG streams, largest first.
    pub candidates: Vec<(usize, usize)>,
    /// Orientation tag of IFD0 (1 when absent).
    pub orientation: u8,
}

struct Reader<'a> {
    d: &'a [u8],
    le: bool,
}

impl Reader<'_> {
    fn u16(&self, o: usize) -> Option<u16> {
        let b: [u8; 2] = self.d.get(o..o.checked_add(2)?)?.try_into().ok()?;
        Some(if self.le {
            u16::from_le_bytes(b)
        } else {
            u16::from_be_bytes(b)
        })
    }

    fn u32(&self, o: usize) -> Option<u32> {
        let b: [u8; 4] = self.d.get(o..o.checked_add(4)?)?.try_into().ok()?;
        Some(if self.le {
            u32::from_le_bytes(b)
        } else {
            u32::from_be_bytes(b)
        })
    }

    /// Values of an IFD entry (SHORT or LONG) as u32s.
    fn values(&self, entry: usize) -> Option<Vec<u32>> {
        let typ = self.u16(entry + 2)?;
        let count = self.u32(entry + 4)? as usize;
        let size = match typ {
            3 => 2,
            4 => 4,
            _ => return None,
        };
        if count > 4096 {
            return None;
        }
        let base = if size * count <= 4 {
            entry + 8
        } else {
            self.u32(entry + 8)? as usize
        };
        (0..count)
            .map(|i| {
                if size == 2 {
                    self.u16(base + i * 2).map(u32::from)
                } else {
                    self.u32(base + i * 4)
                }
            })
            .collect()
    }
}

pub(crate) fn find_preview(data: &[u8]) -> Option<Preview> {
    let le = match data.get(..4)? {
        b"II*\0" => true,
        b"MM\0*" => false,
        _ => return None,
    };
    let r = Reader { d: data, le };
    let mut queue = vec![r.u32(4)? as usize];
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut orientation = 1u8;
    let mut first = true;

    while let Some(ifd) = queue.pop() {
        if !seen.insert(ifd) || seen.len() > MAX_IFDS {
            continue;
        }
        let Some(n) = r.u16(ifd) else { continue };
        let (mut compression, mut offsets, mut counts, mut jpeg_off, mut jpeg_len) =
            (0, None, None, None, None);
        for i in 0..n as usize {
            let e = ifd + 2 + i * 12;
            let Some(tag) = r.u16(e) else { break };
            match tag {
                TAG_COMPRESSION => compression = r.values(e).and_then(|v| v.first().copied()).unwrap_or(0),
                TAG_ORIENTATION if first => {
                    orientation = r
                        .values(e)
                        .and_then(|v| v.first().copied())
                        .unwrap_or(1)
                        .clamp(1, 8) as u8;
                }
                TAG_STRIP_OFFSETS => offsets = r.values(e),
                TAG_STRIP_COUNTS => counts = r.values(e),
                TAG_JPEG_OFFSET => jpeg_off = r.values(e).and_then(|v| v.first().copied()),
                TAG_JPEG_LEN => jpeg_len = r.values(e).and_then(|v| v.first().copied()),
                TAG_SUB_IFDS => queue.extend(r.values(e).unwrap_or_default().into_iter().map(|o| o as usize)),
                _ => {}
            }
        }
        if let (Some(o), Some(l)) = (jpeg_off, jpeg_len) {
            candidates.push((o as usize, l as usize));
        }
        if matches!(compression, 6 | 7)
            && let (Some(o), Some(c)) = (offsets, counts)
            && o.len() == 1
            && c.len() == 1
        {
            candidates.push((o[0] as usize, c[0] as usize));
        }
        if let Some(next) = r.u32(ifd + 2 + n as usize * 12)
            && next != 0
        {
            queue.push(next as usize);
        }
        first = false;
    }

    candidates.retain(|&(o, l)| l > 4 && data.get(o..o.saturating_add(3)) == Some(&[0xFF, 0xD8, 0xFF]));
    candidates.sort_by_key(|&(_, l)| std::cmp::Reverse(l));
    (!candidates.is_empty()).then_some(Preview {
        candidates,
        orientation,
    })
}
