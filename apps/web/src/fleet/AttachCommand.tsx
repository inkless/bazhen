import { useRef, useState } from "react";

/** The escape hatch: a command to attach a terminal emulator of the user's own (§4.5). */
export function AttachCommand({ command }: { command: string }) {
  const code = useRef<HTMLElement>(null);
  const [copied, setCopied] = useState<"no" | "yes" | "selected">("no");

  // A page served over plain http to another device, a phone say, has no clipboard API; the
  // older copy command still works there, on the text selected for it.
  const copySelected = () => {
    if (code.current !== null) getSelection()?.selectAllChildren(code.current);
    setCopied(document.execCommand("copy") ? "yes" : "selected");
  };
  const copy = () =>
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(command))
      .then(() => setCopied("yes"), copySelected);

  return (
    <details className="attach">
      <summary>Attach from a terminal</summary>
      <p>
        For when this page can&apos;t show the terminal. Paste it into a terminal window; close that
        window to detach.
      </p>
      <pre>
        <code ref={code}>{command}</code>
      </pre>
      <button type="button" onClick={() => void copy()}>
        Copy
      </button>{" "}
      {copied === "yes" && <span role="status">Copied</span>}
      {copied === "selected" && <span role="status">Selected; copy it from here</span>}
    </details>
  );
}
