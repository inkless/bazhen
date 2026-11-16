import { type DoctorResponse, memoryCapText } from "@bazhen/protocol";

type Containment = NonNullable<DoctorResponse["containment"]>;

/** The first line, and any note under it, for the daemon's decision. */
function decisionLines(containment: Containment): string[] {
  if (containment.state === "unchecked") {
    return ["containment: not checked yet (no holder terminal has started since the daemon did)"];
  }
  if (containment.state === "uncontained") {
    return [
      `containment: none (${containment.why})`,
      "  warning: one terminal's runaway memory can end every other terminal",
    ];
  }
  return [
    `containment: each holder terminal in a systemd scope of its own, at most ` +
      `${memoryCapText(containment.terminal)} each with ${memoryCapText(containment.swap)} ` +
      `of swap, and ${memoryCapText(containment.total)} together`,
    ...(containment.oomPolicy
      ? []
      : [
          `  note: systemd ${containment.systemd} predates OOMPolicy for scopes (253), ` +
            "so the kernel alone decides what dies past a cap",
        ]),
  ];
}

/**
 * What `bazhen doctor` says of containment: whether new holder terminals start in a scope of their
 * own, with what caps, and which terminals run outside one.
 */
export function containmentLines(
  containment: Containment,
  holders: NonNullable<DoctorResponse["holder"]>["holders"],
  runtimeKinds: readonly string[],
): string[] {
  const lines = decisionLines(containment);
  const outside = holders.filter((holder) => holder.contained === false).length;
  if (outside > 0) {
    const which = outside === 1 ? "1 holder terminal runs" : `${outside} holder terminals run`;
    const fix = outside === 1 ? "restart it to contain it" : "restart them to contain them";
    lines.push(`  ${which} outside a scope${containment.state === "scoped" ? `; ${fix}` : ""}`);
  }
  if (runtimeKinds.includes("tmux")) lines.push("  tmux terminals are not contained");
  return lines;
}
