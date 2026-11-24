//! What a view says in a text frame, as the stream route reads it: `StreamClientFrame` in
//! `packages/protocol/src/stream.ts`, a size held to the bounds a view may ask for.

use bazhen_holder_proto::body::{Cols, Rows, Size};
use bazhen_protocol::stream::{AttachmentMode, Resumes, StreamClientFrame};

/// The longest resume token a view may send, in UTF-16 code units, as `z.string().max(64)`
/// counts them.
pub const MAX_TOKEN: usize = 64;

/// A frame a view sent, as the route reads it.
#[derive(Debug, PartialEq, Eq)]
pub enum Said {
    Hello {
        protocol_id: Option<String>,
        mode: AttachmentMode,
        size: Size,
        resumes: Option<Resumes>,
    },
    Resize(Size),
    Engage,
    Epoch(u64),
    Ping,
}

/// A view's size, as a frame may give one: 2 to 1000 columns and rows.
fn size(cols: u16, rows: u16) -> Option<Size> {
    let fits = |n: u16| (2..=1000).contains(&n);
    if !fits(cols) || !fits(rows) {
        return None;
    }
    Some(Size {
        cols: Cols::new(u64::from(cols)).ok()?,
        rows: Rows::new(u64::from(rows)).ok()?,
    })
}

/// A text frame, or `None` for one that isn't a frame a view sends: one a view couldn't send
/// either, with a size out of bounds or a resume token over [`MAX_TOKEN`].
#[must_use]
pub fn read(text: &str) -> Option<Said> {
    Some(match serde_json::from_str(text).ok()? {
        StreamClientFrame::Hello {
            protocol_id,
            mode,
            cols,
            rows,
            resumes,
        } => {
            if resumes
                .as_ref()
                .is_some_and(|r| r.token.encode_utf16().count() > MAX_TOKEN)
            {
                return None;
            }
            Said::Hello {
                protocol_id,
                mode,
                size: size(cols, rows)?,
                resumes,
            }
        }
        StreamClientFrame::Resize { cols, rows } => Said::Resize(size(cols, rows)?),
        StreamClientFrame::Engage => Said::Engage,
        StreamClientFrame::Epoch { epoch } => Said::Epoch(epoch),
        StreamClientFrame::Ping => Said::Ping,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello_resuming(token: &str) -> String {
        let attachment = bazhen_protocol::ids::AttachmentId::mint(1, [1; 16]);
        format!(
            r#"{{"type":"hello","protocolId":"b","mode":"observe","cols":80,"rows":24,"resumes":{{"attachmentId":"{attachment}","token":"{token}"}}}}"#
        )
    }

    fn token_read(token: &str) -> Option<String> {
        match read(&hello_resuming(token)) {
            Some(Said::Hello { resumes, .. }) => resumes.map(|r| r.token),
            _ => None,
        }
    }

    #[test]
    fn reads_a_resume_token_of_up_to_64_utf16_code_units_and_no_longer() {
        let long = |unit: &str, n: usize| unit.repeat(n);
        assert_eq!(
            [
                token_read(&long("r", 64)),
                token_read(&long("r", 65)),
                token_read(&long("é", 64)),
                token_read(&long("😀", 32)),
                token_read(&long("😀", 33)),
            ],
            [
                Some(long("r", 64)),
                None,
                Some(long("é", 64)),
                Some(long("😀", 32)),
                None,
            ]
        );
    }
}
