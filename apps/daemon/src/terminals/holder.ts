import { fileURLToPath } from "node:url";
import type { DoctorResponse } from "@bazhen/protocol";
import type { HolderInstall, HolderRuntime } from "@bazhen/runtime-holder";

/** What `pnpm build` makes: the holder, in the profile that unwinds on a panic. */
export const HOLDER_SOURCE = fileURLToPath(
  new URL("../../../../target/release-holder/bazhen-holder", import.meta.url),
);

/** What doctor says of holders: the installed build, and the build each answering holder runs. */
export async function holderDoctor(
  install: HolderInstall,
  runtime: Pick<HolderRuntime, "builds"> | null,
): Promise<NonNullable<DoctorResponse["holder"]>> {
  const holders = runtime === null ? [] : await runtime.builds();
  const { installed } = install;
  return {
    binary: installed?.binary ?? null,
    build: installed?.build ?? null,
    reason: installed === null ? install.reason : null,
    holders: holders.map((h) => ({ ...h, protocol: [...h.protocol] })),
  };
}
