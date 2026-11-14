import type { ReactNode } from "react";
import { Toolbar as AriaToolbar } from "react-aria-components";

/** A row of controls that is one tab stop, with arrow keys moving between them. */
export function Toolbar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <AriaToolbar aria-label={label} className="toolbar">
      {children}
    </AriaToolbar>
  );
}
