/** One shell word, whatever the string holds. */
const word = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The hook client as a shell command, which a harness runs through a shell with the event
 * appended, so its paths stay whole whatever they hold.
 */
export function hookCommand(node: string, client: string): string {
  return `${word(node)} --disable-warning=ExperimentalWarning ${word(client)}`;
}
