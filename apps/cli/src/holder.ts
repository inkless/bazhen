import type { DoctorResponse } from "@bazhen/protocol";

type Holder = NonNullable<DoctorResponse["holder"]>;

/** What `bazhen doctor` says of holder builds: the one new terminals run, and what runs now. */
export function holderLines({ binary, build, reason, holders }: Holder): string[] {
  const lines = [
    build === null
      ? `holder: none installed (${reason ?? "no reason given"})`
      : `holder: build ${build} (${binary ?? "no path"})`,
  ];
  const groups = new Map<string, number>();
  for (const holder of holders) {
    const named =
      holder.build === null
        ? "an unknown build"
        : holder.build === build
          ? holder.build
          : `${holder.build} (older build; restart to upgrade)`;
    const key = `on ${named}, protocol ${holder.protocol.join(", ")}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  for (const [key, count] of groups) {
    lines.push(`  ${count} ${count === 1 ? "terminal" : "terminals"} ${key}`);
  }
  return lines;
}
