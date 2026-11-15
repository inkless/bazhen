import type { DoctorResponse } from "@bazhen/protocol";

type Lan = NonNullable<NonNullable<DoctorResponse["web"]>["lan"]>;

/**
 * What `bazhen doctor` says about the LAN listener: where it serves, to whom, and the certificate
 * a browser must trust. A listener that stopped says so first, though its certificate is loaded.
 */
export function lanLines(lan: Lan): string[] {
  const lines = [`LAN: ${lan.url}, to ${lan.allow.join(", ")}`];
  if (lan.error !== null) lines.push(`  not serving: ${lan.error}`);
  if (lan.certificate !== null) {
    lines.push(`  certificate SHA-256: ${lan.certificate.fingerprint}`);
    lines.push(`  certificate: ${lan.certificate.path}, expires ${lan.certificate.expiresAt}`);
  }
  const subnets = lan.subnets.map((s) => `${s.cidr} (${s.interface})`).join(", ");
  lines.push(`  this host's subnets: ${subnets || "none"}`);
  return lines;
}
