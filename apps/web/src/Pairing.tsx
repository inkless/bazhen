import { useState } from "react";
import { pairDevice, Refused } from "./api.ts";
import { Button } from "./ui/Button.tsx";

const MESSAGES: Partial<Record<NonNullable<Refused["code"]>, string>> = {
  pairing_failed: "That code is wrong or has expired. Run bazhen pair again for a new one.",
  rate_limited: "Too many tries; wait a minute.",
};

/** What an unpaired browser sees instead of the dashboard (foundation-design §9.1). */
export function Pairing({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);

  const submit = () => {
    if (pairing) return;
    setPairing(true);
    setError(null);
    pairDevice(code, name).then(onPaired, (err: unknown) => {
      setPairing(false);
      const known = err instanceof Refused && err.code !== null ? MESSAGES[err.code] : undefined;
      setError(known ?? String(err));
    });
  };

  return (
    <form
      className="pairing"
      aria-labelledby="pairing-title"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h2 id="pairing-title">Pair this browser</h2>
      <p>
        Run <code>bazhen pair</code> in a terminal and enter the code
      </p>
      <label>
        Code{" "}
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="ABCD-EFGH"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
      </label>
      <label>
        Device name{" "}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Browser" />
      </label>
      <Button type="submit" variant="primary" isDisabled={pairing}>
        Pair
      </Button>
      {error !== null && <p role="alert">{error}</p>}
    </form>
  );
}
