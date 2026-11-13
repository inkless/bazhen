/** Where a view stands, as its status line says. */
export type Status =
  | { kind: "connecting" }
  | { kind: "viewing" }
  | { kind: "taken"; device: string | undefined }
  | { kind: "driving" }
  | { kind: "checking" }
  | { kind: "reconnecting" }
  | { kind: "ended"; message: string };

const STATUS_TEXT = {
  connecting: "Connecting…",
  viewing: "Viewing — click to type",
  driving: "Driving",
  checking: "Checking the connection…",
  reconnecting: "Reconnecting…",
} as const;

export function statusText(status: Exclude<Status, { kind: "ended" }>): string {
  if (status.kind !== "taken") return STATUS_TEXT[status.kind];
  const who = status.device ?? "another view";
  return `Viewing — ${who} is driving; click or type to take over`;
}
