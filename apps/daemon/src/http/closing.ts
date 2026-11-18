/** What the budget needs of a socket it closes: a ws `WebSocket`. */
export interface Closable {
  readonly bufferedAmount: number;
  readonly readyState: number;
  readonly CLOSED: number;
  close(): void;
  terminate(): void;
  once(event: "close", listener: () => void): unknown;
}

/**
 * A ceiling on the bytes queued on sockets the daemon has closed, across all of them. A closed
 * socket is held until its peer reads what was queued before the close, which ends with the frame
 * saying why, so it holds that queue for as long as the heartbeat keeps a silent peer. Nothing else
 * bounds how many such sockets there are: a view that is ended no longer counts against its
 * terminal's views, and loopback takes any number of connections.
 *
 * Over the ceiling, the sockets closed longest ago are destroyed, with their queues, until the
 * rest fit; the one closed last never is, so a view whose queue alone is over the ceiling still
 * gets the usual hold. Checking only when a socket closes is enough: ws (8.22) writes nothing
 * sent after `close()`, so a closed socket's queue only shrinks, and the sum grows only when a
 * socket joins it. ws still adds what is sent after `close()` to `bufferedAmount` (an answer to
 * the peer's ping, output for a view the hub hasn't ended yet), so a socket counts as the least
 * of its `bufferedAmount` now and at its close: never less than its queue, and nothing its peer
 * can raise.
 */
export class ClosingBudget {
  private readonly maxBytes: number;
  /** Oldest first, each with its `bufferedAmount` at its close. */
  private readonly held = new Map<Closable, number>();

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  close(ws: Closable): void {
    ws.close();
    if (ws.readyState === ws.CLOSED || this.held.has(ws)) return;
    this.held.set(ws, ws.bufferedAmount);
    ws.once("close", () => this.held.delete(ws));
    const queued = (socket: Closable, atClose: number) => Math.min(socket.bufferedAmount, atClose);
    let bytes = 0;
    for (const [socket, atClose] of this.held) bytes += queued(socket, atClose);
    for (const [socket, atClose] of this.held) {
      if (bytes <= this.maxBytes || socket === ws) break;
      bytes -= queued(socket, atClose);
      this.held.delete(socket);
      socket.terminate();
    }
  }
}
