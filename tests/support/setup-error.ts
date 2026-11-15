// Vitest's source-map lookup crashes on errors thrown from globalSetup and hides their message,
// so print it before throwing.
export function failSetup(message: string): never {
  console.error(`\n${message}\n`);
  throw new Error(message);
}
