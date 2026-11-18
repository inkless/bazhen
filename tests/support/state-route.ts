/** The part of a Playwright route that answers a read with the daemon's own response, changed. */
export interface PatchableRoute<R> {
  fetch(): Promise<R & { json(): Promise<unknown> }>;
  fulfill(options: { response: R; json: object }): Promise<void>;
  continue(): Promise<void>;
}

/** Playwright's errors for a read a reload left behind, as it raises them. */
const ABANDONED = /has been disposed|Route is already handled/;

/**
 * Answers the page's read of the daemon's state with `patch` applied to it. A reload while the
 * read is in flight disposes the response the route holds, and the page no longer waits for an
 * answer, so that read goes on unpatched; any other failure is the test's to see, a page closed
 * under the test among them.
 */
export async function answerPatched<R>(
  route: PatchableRoute<R>,
  patch: (state: object) => object,
): Promise<void> {
  try {
    const response = await route.fetch();
    const state: unknown = await response.json();
    await route.fulfill({ response, json: patch(Object(state)) });
  } catch (error) {
    if (!(error instanceof Error && ABANDONED.test(error.message))) throw error;
    await route.continue().catch(() => undefined);
  }
}
