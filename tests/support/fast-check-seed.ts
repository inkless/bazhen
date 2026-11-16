// Every fast-check property draws its cases from one seed, so that a run tests the change and not
// the draw. The scheduled job in .github/workflows/fuzz.yml gives a random one in FC_SEED.
// Changing the constant changes every property's cases.

export const FAST_CHECK_SEED = 1;

export function fastCheckSeed(env: NodeJS.ProcessEnv): number {
  const given = env.FC_SEED;
  if (given === undefined || given === "") return FAST_CHECK_SEED;
  const seed = Number(given);
  if (!/^-?\d+$/.test(given) || !Number.isSafeInteger(seed)) {
    throw new Error(`FC_SEED is not an integer: ${given}`);
  }
  return seed;
}
