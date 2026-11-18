/** The latest time a Date holds, in Unix seconds. */
const LAST_DATE_SECONDS = 8.64e12;

/** A time a harness gives in whole Unix seconds, as an ISO timestamp; null for anything else. */
export const isoOfUnixSeconds = (seconds: unknown): string | null =>
  typeof seconds === "number" &&
  Number.isInteger(seconds) &&
  seconds > 0 &&
  seconds <= LAST_DATE_SECONDS
    ? new Date(seconds * 1000).toISOString()
    : null;
