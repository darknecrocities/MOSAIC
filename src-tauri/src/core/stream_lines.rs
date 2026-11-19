/// Byte-buffered NDJSON line reader that preserves multi-byte UTF-8 sequences
/// split across chunk boundaries and flushes trailing non-newline data at EOF.
#[derive(Default)]
pub struct LineByteBuffer {
    buf: Vec<u8>,
}

impl LineByteBuffer {
    pub fn push_chunk(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut lines = Vec::new();
        let mut start = 0;
        while let Some(rel_idx) = self.buf[start..].iter().position(|&b| b == b'\n') {
            let end = start + rel_idx;
            let line = String::from_utf8_lossy(&self.buf[start..end])
                .trim()
                .to_string();
            if !line.is_empty() {
                lines.push(line);
            }
            start = end + 1;
        }
        if start > 0 {
            self.buf.drain(..start);
        }
        lines
    }

    pub fn flush_remaining(&mut self) -> Option<String> {
        if self.buf.is_empty() {
            return None;
        }
        let line = String::from_utf8_lossy(&self.buf).trim().to_string();
        self.buf.clear();
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_split_utf8_and_flushes_trailing_without_newline() {
        let mut buf = LineByteBuffer::default();
        let rocket = "🚀".as_bytes();
        let mut c1 = b"{\"tok\":\"".to_vec();
        c1.extend_from_slice(&rocket[..2]);
        let mut c2 = rocket[2..].to_vec();
        c2.extend_from_slice(b"\"}\n{\"tail\":true}");

        assert!(buf.push_chunk(&c1).is_empty());
        assert_eq!(buf.push_chunk(&c2), vec!["{\"tok\":\"🚀\"}"]);
        assert_eq!(buf.flush_remaining().as_deref(), Some("{\"tail\":true}"));
        assert!(buf.flush_remaining().is_none());
    }
}
