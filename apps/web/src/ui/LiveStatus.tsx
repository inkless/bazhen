import { useEffect, useState } from "react";

/** How long a status must hold before it is read out. */
const SETTLE_MS = 1000;

/**
 * Reads `text` out to a screen reader once it has held for a second. A status that flips back and
 * forth, as the driver does while two devices race to take over, is read out once it settles,
 * not at every flip. Shown nowhere: the visible status sits beside it.
 */
export function LiveStatus({ text }: { text: string }) {
  const [spoken, setSpoken] = useState(text);
  useEffect(() => {
    const settled = setTimeout(() => setSpoken(text), SETTLE_MS);
    return () => clearTimeout(settled);
  }, [text]);
  return (
    <p className="visually-hidden" aria-live="polite">
      {spoken}
    </p>
  );
}
