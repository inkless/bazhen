//! A time on the wire: an ISO 8601 UTC timestamp, as `z.iso.datetime()` takes one and
//! `Date.parse` reads it.

/// The milliseconds since the epoch `text` names, if it is a timestamp the protocol takes:
/// `YYYY-MM-DDTHH:MM:SS`, any fraction of a second, and `Z`, on a day the calendar has. A fraction
/// finer than a millisecond is cut, as `Date.parse` cuts it.
pub fn timestamp_ms(text: &str) -> Option<i64> {
    let (date, time) = text.strip_suffix('Z')?.split_once('T')?;
    let mut date = date.split('-');
    let year = digits(date.next()?, 4)?;
    let month = digits(date.next()?, 2)?;
    let day = digits(date.next()?, 2)?;
    if date.next().is_some() || !(1..=12).contains(&month) || day < 1 || day > days_in(year, month)
    {
        return None;
    }
    let (clock, fraction) = time
        .split_once('.')
        .map_or((time, None), |(c, f)| (c, Some(f)));
    let mut clock = clock.split(':');
    let hour = digits(clock.next()?, 2)?;
    let minute = digits(clock.next()?, 2)?;
    let second = digits(clock.next()?, 2)?;
    if clock.next().is_some() || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let millis = match fraction {
        None => 0,
        Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
            let cut = f.get(..f.len().min(3)).unwrap_or_default();
            let padded = format!("{cut:0<3}");
            padded.parse::<i64>().ok()?
        }
        Some(_) => return None,
    };
    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second;
    Some(seconds * 1000 + millis)
}

/// `text` as a number, if it is exactly `width` ASCII digits.
fn digits(text: &str, width: usize) -> Option<i64> {
    (text.len() == width && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

fn days_in(year: i64, month: i64) -> i64 {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    match month {
        2 if leap => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days from 1970-01-01 to the date, by Howard Hinnant's `days_from_civil`.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
