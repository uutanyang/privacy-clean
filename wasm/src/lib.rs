//! PrivacyClean WASM — High-performance metadata stripper
//!
//! Replaces Canvas re-encoding with lossless EXIF stripping:
//! - JPEG: Removes APP1 (EXIF), APP13 (IPTC), XMP segments, preserves image data
//! - PNG: Removes tEXt/iTXt/zTXt chunks, preserves pixel data
//! - PDF: Removes Author/Creator/Producer/etc metadata fields
//!
//! No re-encoding = zero quality loss

use wasm_bindgen::prelude::*;

// ── JPEG Processing ──────────────────────────────────────────

/// JPEG markers
const SOI: u8 = 0xD8;       // Start of Image
const EOI: u8 = 0xD9;       // End of Image
const SOS: u8 = 0xDA;       // Start of Scan
const APP0: u8 = 0xE0;      // JFIF
const APP1: u8 = 0xE1;      // EXIF / XMP
const APP13: u8 = 0xED;     // IPTC / Photoshop
const APP14: u8 = 0xEE;     // Adobe

/// Metadata found during stripping
#[wasm_bindgen]
#[derive(Clone)]
pub struct MetadataReport {
    fields: Vec<String>,
}

#[wasm_bindgen]
impl MetadataReport {
    pub fn fields(&self) -> Vec<JsValue> {
        self.fields.iter().map(|f| JsValue::from_str(f)).collect()
    }

    pub fn count(&self) -> usize {
        self.fields.len()
    }
}

/// Strip EXIF/metadata from a JPEG file — lossless (no re-encoding)
///
/// Returns the cleaned JPEG bytes. Image data is preserved bit-for-bit.
/// Only metadata segments (APP1/EXIF, APP13/IPTC, XMP) are removed.
#[wasm_bindgen]
pub fn strip_jpeg(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != SOI {
        return Err(JsValue::from_str("Not a valid JPEG file"));
    }

    let mut output: Vec<u8> = Vec::with_capacity(data.len());
    let mut fields = Vec::new();
    let mut i: usize = 2; // Skip SOI marker

    // Write SOI
    output.push(0xFF);
    output.push(SOI);

    while i < data.len() - 1 {
        if data[i] != 0xFF {
            return Err(JsValue::from_str("Invalid JPEG marker"));
        }

        let marker = data[i + 1];

        // End of Image
        if marker == EOI {
            output.push(0xFF);
            output.push(EOI);
            break;
        }

        // Start of Scan — everything after this is image data, copy verbatim
        if marker == SOS {
            output.extend_from_slice(&data[i..]);
            return Ok(output);
        }

        // Standalone markers (no length): RST0-RST7, TEM
        if (marker & 0xF0) == 0xD0 && (marker & 0x0F) <= 0x07 || marker == 0x01 {
            output.push(0xFF);
            output.push(marker);
            i += 2;
            continue;
        }

        // Read segment length (big-endian, includes the 2 length bytes)
        if i + 4 > data.len() {
            return Err(JsValue::from_str("Truncated JPEG segment"));
        }
        let seg_len = ((data[i + 2] as usize) << 8) | (data[i + 3] as usize);

        match marker {
            // APP0 (JFIF) — keep (contains resolution info)
            APP0 => {
                output.extend_from_slice(&data[i..i + 2 + seg_len]);
            }
            // APP1 (EXIF / XMP) — strip
            APP1 => {
                if i + 4 + 4 <= data.len() {
                    let ident = &data[i + 4..i + 8];
                    if ident == b"Exif" {
                        fields.push("EXIF".to_string());
                        // Check for GPS in EXIF
                        if seg_len > 20 {
                            let seg_data = &data[i + 4..i + 2 + seg_len];
                            if contains_bytes(seg_data, b"GPS") {
                                fields.push("GPS".to_string());
                            }
                        }
                    } else if ident == b"http" {
                        // XMP in APP1
                        fields.push("XMP".to_string());
                    }
                }
                // Skip this segment (don't copy to output)
            }
            // APP13 (IPTC / Photoshop) — strip
            APP13 => {
                fields.push("IPTC".to_string());
                // Skip
            }
            // APP14 (Adobe) — keep (contains color transform info needed for decoding)
            APP14 => {
                output.extend_from_slice(&data[i..i + 2 + seg_len]);
            }
            // All other APPn and markers — keep
            _ => {
                output.extend_from_slice(&data[i..i + 2 + seg_len]);
            }
        }

        i += 2 + seg_len;
    }

    Ok(output)
}

/// Analyze JPEG metadata (report only, no stripping)
#[wasm_bindgen]
pub fn analyze_jpeg(data: &[u8]) -> Result<MetadataReport, JsValue> {
    if data.len() < 4 || data[0] != 0xFF || data[1] != SOI {
        return Err(JsValue::from_str("Not a valid JPEG file"));
    }

    let mut fields = Vec::new();
    let mut i: usize = 2;

    while i < data.len() - 1 {
        if data[i] != 0xFF {
            break;
        }

        let marker = data[i + 1];

        if marker == EOI || marker == SOS {
            break;
        }

        if (marker & 0xF0) == 0xD0 && (marker & 0x0F) <= 0x07 || marker == 0x01 {
            i += 2;
            continue;
        }

        if i + 4 > data.len() {
            break;
        }
        let seg_len = ((data[i + 2] as usize) << 8) | (data[i + 3] as usize);

        if marker == APP1 {
            if i + 8 <= data.len() {
                let ident = &data[i + 4..i + 8];
                if ident == b"Exif" {
                    fields.push("EXIF".to_string());
                    let seg_data = &data[i + 4..std::cmp::min(i + 2 + seg_len, data.len())];
                    if contains_bytes(seg_data, b"GPS") {
                        fields.push("GPS".to_string());
                    }
                } else if ident == b"http" {
                    fields.push("XMP".to_string());
                }
            }
        } else if marker == APP13 {
            fields.push("IPTC".to_string());
            if i + 2 + seg_len <= data.len() {
                let seg_data = &data[i + 4..i + 2 + seg_len];
                if contains_bytes(seg_data, b"Photoshop") {
                    fields.push("Photoshop".to_string());
                }
            }
        }

        i += 2 + seg_len;
    }

    Ok(MetadataReport { fields })
}

// ── PNG Processing ──────────────────────────────────────────

/// Strip metadata from PNG — lossless
///
/// Removes tEXt, iTXt, zTXt chunks (textual metadata).
/// Preserves IHDR, PLTE, IDAT, IEND, and all other critical chunks.
#[wasm_bindgen]
pub fn strip_png(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    // PNG signature: 8 bytes
    const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

    if data.len() < 24 || data[..8] != PNG_SIG {
        return Err(JsValue::from_str("Not a valid PNG file"));
    }

    let mut output = Vec::with_capacity(data.len());
    output.extend_from_slice(&PNG_SIG);

    let mut fields = Vec::new();
    let mut i: usize = 8;

    while i + 12 <= data.len() {
        // Read chunk: 4 bytes length + 4 bytes type + data + 4 bytes CRC
        let chunk_len = u32_from_be(&data[i..i + 4]) as usize;
        let chunk_type = &data[i + 4..i + 8];

        if i + 12 + chunk_len > data.len() {
            // Truncated, copy remaining
            output.extend_from_slice(&data[i..]);
            break;
        }

        let chunk_data = &data[i + 8..i + 8 + chunk_len];

        match chunk_type {
            // Text chunks — strip
            b"tEXt" => {
                let key = chunk_data.iter()
                    .position(|&b| b == 0)
                    .map(|pos| String::from_utf8_lossy(&chunk_data[..pos]).to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                fields.push(format!("PNG:tEXt:{}", key));
            }
            b"iTXt" => {
                let key = chunk_data.iter()
                    .position(|&b| b == 0)
                    .map(|pos| String::from_utf8_lossy(&chunk_data[..pos]).to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                fields.push(format!("PNG:iTXt:{}", key));
            }
            b"zTXt" => {
                let key = chunk_data.iter()
                    .position(|&b| b == 0)
                    .map(|pos| String::from_utf8_lossy(&chunk_data[..pos]).to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                fields.push(format!("PNG:zTXt:{}", key));
            }
            // eXIf chunk (EXIF in PNG, spec added 2017)
            b"eXIf" => {
                fields.push("EXIF".to_string());
                if contains_bytes(chunk_data, b"GPS") {
                    fields.push("GPS".to_string());
                }
            }
            // All other chunks — keep
            _ => {
                output.extend_from_slice(&data[i..i + 12 + chunk_len]);
            }
        }

        i += 12 + chunk_len;

        // IEND
        if chunk_type == b"IEND" {
            break;
        }
    }

    // If we found text fields, log them via console
    if !fields.is_empty() {
        web_sys::console::log_1(&JsValue::from_str(
            &format!("[WASM] PNG metadata stripped: {:?}", fields)
        ));
    }

    Ok(output)
}

/// Analyze PNG metadata
#[wasm_bindgen]
pub fn analyze_png(data: &[u8]) -> Result<MetadataReport, JsValue> {
    const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];
    if data.len() < 24 || data[..8] != PNG_SIG {
        return Err(JsValue::from_str("Not a valid PNG file"));
    }

    let mut fields = Vec::new();
    let mut i: usize = 8;

    while i + 12 <= data.len() {
        let chunk_len = u32_from_be(&data[i..i + 4]) as usize;
        let chunk_type = &data[i + 4..i + 8];

        if i + 12 + chunk_len > data.len() {
            break;
        }

        let chunk_data = &data[i + 8..i + 8 + chunk_len];

        match chunk_type {
            b"tEXt" | b"iTXt" | b"zTXt" => {
                let key = chunk_data.iter()
                    .position(|&b| b == 0)
                    .map(|pos| String::from_utf8_lossy(&chunk_data[..pos]).to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                fields.push(key);
            }
            b"eXIf" => {
                fields.push("EXIF".to_string());
                if contains_bytes(chunk_data, b"GPS") {
                    fields.push("GPS".to_string());
                }
            }
            _ => {}
        }

        i += 12 + chunk_len;
        if chunk_type == b"IEND" {
            break;
        }
    }

    Ok(MetadataReport { fields })
}

// ── PDF Processing ──────────────────────────────────────────

/// Strip metadata from PDF — removes Author, Creator, Producer, etc.
/// Works at the binary level without re-rendering the document.
#[wasm_bindgen]
pub fn strip_pdf(data: &[u8]) -> Result<Vec<u8>, JsValue> {
    if data.len() < 8 || !(&data[..5] == b"%PDF-" || &data[..5] == b"%pdf-") {
        return Err(JsValue::from_str("Not a valid PDF file"));
    }

    let text = String::from_utf8_lossy(data);
    let mut output = data.to_vec();

    // Remove XMP metadata blocks
    while let Some(start) = find_str(&text, "<x:xmpmeta") {
        if let Some(end) = find_str_from(&text, "</x:xmpmeta>", start) {
            let end_pos = end + "</x:xmpmeta>".len();
            // Replace with spaces to preserve byte offsets (PDF uses offsets)
            for i in start..end_pos {
                if i < output.len() {
                    output[i] = b' ';
                }
            }
        } else {
            break;
        }
    }

    // Clear metadata fields (replace values with empty parens, preserve byte count)
    let replacements = [
        ("/Author", "/Author "),
        ("/Creator", "/Creator "),
        ("/Producer", "/Producer "),
        ("/Title", "/Title "),
        ("/Subject", "/Subject "),
        ("/Keywords", "/Keywords "),
        ("/CreationDate", "/CreationDate "),
        ("/ModDate", "/ModDate "),
    ];

    for (field, replacement) in &replacements {
        clear_pdf_field(&mut output, field, replacement);
    }

    Ok(output)
}

/// Analyze PDF metadata
#[wasm_bindgen]
pub fn analyze_pdf(data: &[u8]) -> Result<MetadataReport, JsValue> {
    if data.len() < 8 || !(&data[..5] == b"%PDF-" || &data[..5] == b"%pdf-") {
        return Err(JsValue::from_str("Not a valid PDF file"));
    }

    let text = String::from_utf8_lossy(data);
    let mut fields = Vec::new();

    let field_patterns = [
        ("Author", "/Author"),
        ("Creator", "/Creator"),
        ("Producer", "/Producer"),
        ("Title", "/Title"),
        ("Subject", "/Subject"),
        ("Keywords", "/Keywords"),
        ("CreationDate", "/CreationDate"),
        ("ModDate", "/ModDate"),
    ];

    for (name, pattern) in &field_patterns {
        if text.contains(pattern) {
            fields.push(name.to_string());
        }
    }

    if text.contains("<x:xmpmeta") {
        fields.push("XMP".to_string());
    }

    Ok(MetadataReport { fields })
}

// ── Unified API ─────────────────────────────────────────────

/// Detect file type and strip metadata accordingly
#[wasm_bindgen]
pub fn strip_metadata(data: &[u8], mime_type: &str) -> Result<Vec<u8>, JsValue> {
    match mime_type {
        "image/jpeg" => strip_jpeg(data),
        "image/png" => strip_png(data),
        "application/pdf" => strip_pdf(data),
        _ => Err(JsValue::from_str(&format!(
            "Unsupported file type: {}. Supported: JPEG, PNG, PDF",
            mime_type
        ))),
    }
}

/// Detect file type and analyze metadata
#[wasm_bindgen]
pub fn analyze_metadata(data: &[u8], mime_type: &str) -> Result<MetadataReport, JsValue> {
    match mime_type {
        "image/jpeg" => analyze_jpeg(data),
        "image/png" => analyze_png(data),
        "application/pdf" => analyze_pdf(data),
        _ => Err(JsValue::from_str(&format!(
            "Unsupported file type: {}. Supported: JPEG, PNG, PDF",
            mime_type
        ))),
    }
}

// ── Helpers ─────────────────────────────────────────────────

fn u32_from_be(bytes: &[u8]) -> u32 {
    (bytes[0] as u32) << 24 | (bytes[1] as u32) << 16 | (bytes[2] as u32) << 8 | bytes[3] as u32
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.len() > haystack.len() {
        return false;
    }
    for window in haystack.windows(needle.len()) {
        if window == needle {
            return true;
        }
    }
    false
}

fn find_str(text: &str, pattern: &str) -> Option<usize> {
    text.find(pattern)
}

fn find_str_from(text: &str, pattern: &str, from: usize) -> Option<usize> {
    text[from..].find(pattern).map(|pos| from + pos)
}

/// Clear a PDF metadata field by replacing its value with spaces
/// e.g. /Author (John Doe) → /Author (        )
/// Preserves byte count for offset integrity
fn clear_pdf_field(data: &mut [u8], field: &str, _replacement: &str) {
    // First pass: find all positions to clear (avoids borrow checker issues)
    let positions: Vec<(usize, usize)> = {
        let text = String::from_utf8_lossy(data);
        let mut found = Vec::new();
        let mut search_pos = 0;

        while let Some(field_start) = find_str_from(&text, field, search_pos) {
            let after_field = field_start + field.len();
            if after_field >= data.len() {
                break;
            }

            // Skip whitespace to find opening paren
            let mut paren_pos = after_field;
            while paren_pos < data.len() && matches!(data[paren_pos], b' ' | b'\n' | b'\r' | b'\t') {
                paren_pos += 1;
            }

            if paren_pos < data.len() && data[paren_pos] == b'(' {
                // Find matching closing paren (handle nested parens and escapes)
                let mut depth = 1;
                let mut end_pos = paren_pos + 1;
                while end_pos < data.len() && depth > 0 {
                    match data[end_pos] {
                        b'\\' => { end_pos += 2; continue; }
                        b'(' => depth += 1,
                        b')' => depth -= 1,
                        _ => {}
                    }
                    end_pos += 1;
                }
                // Record range to clear (content between parens)
                let clear_start = paren_pos + 1;
                let clear_end = end_pos.saturating_sub(1);
                if clear_start < clear_end {
                    found.push((clear_start, clear_end));
                }
            }

            search_pos = after_field;
        }
        found
    };

    // Second pass: clear the positions
    for (start, end) in positions {
        for i in start..end {
            if i < data.len() {
                data[i] = b' ';
            }
        }
    }
}
