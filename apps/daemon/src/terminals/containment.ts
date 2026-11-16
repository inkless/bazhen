import { type Containment, MIN_SYSTEMD, TERMINALS_SLICE } from "@bazhen/host-guard";
import { type DoctorResponse, memoryCapText } from "@bazhen/protocol";

/**
 * Whether holder terminals can be contained, decided once, by the first caller that needs it: a
 * daemon that never starts a holder never reaches the user manager, or waits on its bus.
 */
export class ContainmentCheck {
  private readonly probe: () => Promise<Containment>;
  private readonly onDecided: (containment: Containment) => void;
  private pending: Promise<Containment> | undefined;
  private result: Containment | undefined;

  constructor(probe: () => Promise<Containment>, onDecided: (containment: Containment) => void) {
    this.probe = probe;
    this.onDecided = onDecided;
  }

  /** The decision, probing for it the first time it is asked for. */
  decide(): Promise<Containment> {
    this.pending ??= this.probe().then((containment) => {
      this.result = containment;
      this.onDecided(containment);
      return containment;
    });
    return this.pending;
  }

  /** The decision, if one has been made; undefined before. */
  get decided(): Containment | undefined {
    return this.result;
  }
}

/** What doctor says of containment: unchecked until a holder terminal has needed it. */
export function containmentDoctor(
  containment: Containment | undefined,
): NonNullable<DoctorResponse["containment"]> {
  if (containment === undefined) return { state: "unchecked" };
  if (containment.kind === "uncontained") return { state: "uncontained", why: containment.why };
  const { systemd, oomPolicy, caps, enforced } = containment;
  return {
    state: "scoped",
    systemd,
    oomPolicy,
    terminal: { asked: caps.terminal, bytes: enforced.terminal },
    total: { asked: caps.total, bytes: enforced.total },
    swap: { asked: caps.swap, bytes: enforced.swap },
  };
}

/** What the daemon says of containment once it is decided, and whether it is a warning. */
export function containmentLog(containment: Containment): {
  readonly warn: boolean;
  readonly message: string;
} {
  if (containment.kind === "uncontained") {
    return { warn: true, message: `holder terminals are not contained: ${containment.why}` };
  }
  const { systemd, oomPolicy, caps, enforced } = containment;
  const cap = (name: keyof typeof caps) =>
    memoryCapText({ asked: caps[name], bytes: enforced[name] });
  const oom = oomPolicy
    ? ""
    : `; systemd ${systemd} predates OOMPolicy for scopes (${MIN_SYSTEMD}), so the kernel alone decides what dies past a cap`;
  return {
    warn: !oomPolicy,
    message:
      `holder terminals each start in a scope of their own in ${TERMINALS_SLICE}, at most ` +
      `${cap("terminal")} each with ${cap("swap")} of swap, and ${cap("total")} together${oom}`,
  };
}
