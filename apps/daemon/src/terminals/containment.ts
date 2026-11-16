import { type Containment, MIN_SYSTEMD, TERMINALS_SLICE } from "@bazhen/host-guard";
import { type DoctorResponse, memoryCapText } from "@bazhen/protocol";

/** What doctor says of containment. */
export function containmentDoctor(
  containment: Containment,
): NonNullable<DoctorResponse["containment"]> {
  if (containment.kind === "uncontained") return { state: "uncontained", why: containment.why };
  const { systemd, oomPolicy, caps, terminalBytes, totalBytes } = containment;
  return {
    state: "scoped",
    systemd,
    oomPolicy,
    terminal: { asked: caps.terminal, bytes: terminalBytes },
    total: { asked: caps.total, bytes: totalBytes },
  };
}

/** What the daemon says of containment as it starts, and whether it is a warning. */
export function containmentLog(containment: Containment): {
  readonly warn: boolean;
  readonly message: string;
} {
  const doctor = containmentDoctor(containment);
  if (doctor.state === "uncontained") {
    return { warn: true, message: `holder terminals are not contained: ${doctor.why}` };
  }
  const oom = doctor.oomPolicy
    ? ""
    : `; systemd ${doctor.systemd} predates OOMPolicy for scopes (${MIN_SYSTEMD}), so the kernel alone decides what dies past a cap`;
  return {
    warn: !doctor.oomPolicy,
    message:
      `holder terminals each start in a scope of their own in ${TERMINALS_SLICE}, at most ` +
      `${memoryCapText(doctor.terminal)} each and ${memoryCapText(doctor.total)} together${oom}`,
  };
}
