import { useRef, useState } from "react";

/**
 * One request at a time from one control: a second tap while the first is in flight does
 * nothing, since each request carries a fresh idempotency key and would act twice. `pending`
 * disables the control meanwhile.
 */
export function useAction(failed: (e: unknown) => void) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const act = <T>(request: () => Promise<T>, done: (result: T) => void = () => {}) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    const settle = () => {
      inFlight.current = false;
      setPending(false);
    };
    request().then(
      (result) => {
        settle();
        done(result);
      },
      (e: unknown) => {
        settle();
        failed(e);
      },
    );
  };
  return { pending, act };
}
