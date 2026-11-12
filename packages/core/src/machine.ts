/** For each state, the events it accepts and the state each one leads to. */
export type Transitions<S extends string, E extends string> = Readonly<
  Record<S, Readonly<Partial<Record<E, S>>>>
>;

export class InvalidTransition extends Error {
  readonly machine: string;
  readonly from: string;
  readonly event: string;

  constructor(name: string, from: string, event: string) {
    super(`${name} cannot handle ${event} while ${from}`);
    this.machine = name;
    this.from = from;
    this.event = event;
  }
}

export interface Machine<S extends string, E extends string> {
  /** The state `event` leads to; throws InvalidTransition when `from` does not accept it. */
  next(from: S, event: E): S;
  /** Whether `from` accepts `event`, for a caller deciding before it records anything. */
  accepts(from: S, event: E): boolean;
  /** A state that accepts no event is final. */
  isFinal(state: S): boolean;
}

export function machine<S extends string, E extends string>(
  name: string,
  table: Transitions<S, E>,
): Machine<S, E> {
  return {
    next(from, event) {
      const to = table[from][event];
      if (to === undefined) throw new InvalidTransition(name, from, event);
      return to;
    },
    accepts: (from, event) => table[from][event] !== undefined,
    isFinal: (state) => Object.keys(table[state]).length === 0,
  };
}
