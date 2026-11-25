//! A message the agent sent another through its harness's own channel (`observed.ts`): recorded
//! as Bazhen saw it sent. Bazhen can't follow it to delivery, so it queues nothing and wakes
//! nobody.

use bazhen_harness::SentMessage;
use bazhen_protocol::ids::AgentId;
use bazhen_protocol::text::trim;
use bazhen_store::ObservedSend;
use unicode_segmentation::UnicodeSegmentation as _;

use super::write;
use crate::mail::MAIL_LIMIT;
use crate::routes::Shared;

/// The most grapheme clusters of a message a client is shown; the rest stays in the event log.
const SUMMARY_MAX: usize = 120;

/// The most UTF-16 units a summary keeps, as the mail limit counts them: a cluster can carry any
/// number of combining marks, so a count of clusters alone bounds no size.
const SUMMARY_UNITS: usize = 4 * SUMMARY_MAX;

/// The longest tool call id a send is recorded by. A harness's ids are tens of bytes; one longer
/// is refused rather than cut, since two cut alike would read as one send and drop the second.
pub(super) const USE_ID_MAX: usize = 128;

/// Records `from`'s send by the tool call `use_id`, where it names exactly one other agent.
pub(super) async fn observe(
    shared: &Shared,
    from: &AgentId,
    use_id: &str,
    sent: &SentMessage,
) -> Result<(), String> {
    if use_id.len() > USE_ID_MAX {
        tracing::warn!(
            "bazhen: recorded no send by agent {from}: its tool call id is {} bytes",
            use_id.len()
        );
        return Ok(());
    }
    let summary = summary_of(sent);
    let text = within_units(&without_controls(&sent.text), MAIL_LIMIT).to_owned();
    let (from, to, use_id, accepted) = (
        from.clone(),
        sent.to.clone(),
        use_id.to_owned(),
        sent.accepted,
    );
    write(&shared.store, move |w| {
        let sent = ObservedSend {
            summary: &summary,
            text: &text,
            accepted,
            tool_use_id: &use_id,
        };
        w.observe_send(&from, &to, sent)
    })
    .await?;
    Ok(())
}

/// The agent's own label, else the text's first line: one line either way.
fn summary_of(sent: &SentMessage) -> String {
    let line = first_line(sent.summary.as_deref().unwrap_or_default());
    let line = if line.is_empty() {
        first_line(&sent.text)
    } else {
        line
    };
    let line: String = line.graphemes(true).take(SUMMARY_MAX).collect();
    within_units(&line, SUMMARY_UNITS).to_owned()
}

/// The first line with anything on it, without its controls or the space around it. A line ends
/// at a line feed, or at a line or paragraph separator.
fn first_line(text: &str) -> String {
    let text = without_controls(text);
    let line = trim(&text)
        .split(['\n', '\u{2028}', '\u{2029}'])
        .next()
        .unwrap_or_default();
    trim(line).to_owned()
}

/// The longest run of `text`'s whole grapheme clusters that is at most `max` UTF-16 units, as
/// the mail limit counts them.
fn within_units(text: &str, max: usize) -> &str {
    let mut units = 0;
    let mut end = 0;
    for (at, cluster) in text.grapheme_indices(true) {
        units += cluster.encode_utf16().count();
        if units > max {
            break;
        }
        end = at + cluster.len();
    }
    text.get(..end).unwrap_or_default()
}

/// Text an agent wrote, safe to store and show, with its lines and tabs kept: no other control
/// character, which can drive a terminal, and no bidirectional control, which can make text read
/// as something else. Other format characters stay, since emoji sequences are joined by them.
fn without_controls(text: &str) -> String {
    text.chars()
        .filter(|&c| {
            let control = c.is_control() && c != '\n' && c != '\t';
            let bidi = matches!(
                c,
                '\u{61c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            );
            !control && !bidi
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use bazhen_harness::SentMessage;

    use super::{SUMMARY_MAX, SUMMARY_UNITS, summary_of, within_units, without_controls};

    fn sent(summary: Option<&str>, text: &str) -> SentMessage {
        SentMessage {
            to: "bob".to_owned(),
            text: text.to_owned(),
            summary: summary.map(str::to_owned),
            accepted: true,
        }
    }

    #[test]
    fn sums_a_send_up_by_its_own_label_else_its_texts_first_line_cut_by_whole_clusters() {
        let long = "e\u{301}".repeat(SUMMARY_MAX + 1);
        assert_eq!(
            [
                summary_of(&sent(Some(" \u{202e}lunch?\r\n later"), "text")),
                summary_of(&sent(Some(" \u{7}\n "), "\n\t hi\u{1b}[31m there \nmore")),
                summary_of(&sent(None, &long)),
            ],
            [
                "lunch?".to_owned(),
                "hi[31m there".to_owned(),
                "e\u{301}".repeat(SUMMARY_MAX),
            ]
        );
    }

    #[test]
    fn cuts_a_summary_of_clusters_heavy_with_marks_by_its_units_too() {
        // Each cluster is a letter and 200 combining marks: 201 UTF-16 units.
        let heavy = format!("a{}", "\u{301}".repeat(200));
        let summary = summary_of(&sent(None, &heavy.repeat(3)));
        assert_eq!(
            (summary.encode_utf16().count() <= SUMMARY_UNITS, summary),
            (true, heavy.repeat(2))
        );
    }

    #[test]
    fn ends_a_summarys_line_at_a_line_or_paragraph_separator() {
        assert_eq!(
            [
                summary_of(&sent(Some("lunch?\u{2028}at noon"), "text")),
                summary_of(&sent(None, "\u{2029} \u{2029}lunch?\u{2029}at noon")),
            ],
            ["lunch?".to_owned(), "lunch?".to_owned()]
        );
    }

    #[test]
    fn keeps_a_texts_lines_tabs_and_joiners_and_cuts_it_by_whole_clusters_within_its_units() {
        let family = "\u{1f468}\u{200d}\u{1f469}";
        assert_eq!(
            (
                without_controls("a\tb\nc\u{0}\u{7f}\u{85}\u{61c}\u{200e}\u{2067}d"),
                without_controls(family),
                within_units(&format!("ab{family}"), 6),
                within_units(&format!("ab{family}"), 7),
            ),
            (
                "a\tb\ncd".to_owned(),
                family.to_owned(),
                "ab",
                &*format!("ab{family}"),
            )
        );
    }
}
