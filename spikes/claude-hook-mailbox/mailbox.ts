// The probe's side of the waiter socket: tracks connected waiters, keeps one per session by
// releasing the older one, and hands mail to the newest waiter for a session.
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";

export type Waiter = {
  pid: number;
  event: string;
  session_id: string | null;
  prompt_id: string | null;
  connectedAt: number;
  sock: Socket;
};

export class Mailbox {
  readonly path: string;
  readonly waiters: Waiter[] = [];
  readonly log: Record<string, unknown>[] = [];
  /** When false, a new waiter does not release the old one (to observe races). */
  oneWaiterPerSession = true;
  private server?: Server;

  constructor(path: string) {
    this.path = path;
  }

  start(): Promise<void> {
    rmSync(this.path, { force: true });
    this.server = createServer((sock) => {
      let buf = "";
      let me: Waiter | undefined;
      sock.on("data", (d) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const msg = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
          buf = buf.slice(nl + 1);
          if (msg.hello) {
            me = {
              pid: Number(msg.pid),
              event: String(msg.event),
              session_id: (msg.session_id as string) ?? null,
              prompt_id: (msg.prompt_id as string) ?? null,
              connectedAt: Date.now(),
              sock,
            };
            if (this.oneWaiterPerSession) {
              for (const old of this.live().filter((w) => w.session_id === me!.session_id)) {
                this.note("release-old", old);
                old.sock.write(JSON.stringify({ release: true }) + "\n");
              }
            }
            this.waiters.push(me);
            this.note("hello", me);
          } else if (msg.emitted) {
            this.log.push({ at: Date.now(), what: "emitted", pid: msg.pid });
          }
        }
      });
      sock.on("close", () => {
        if (me) this.note("gone", me);
      });
      sock.on("error", () => {});
    });
    return new Promise((r) => this.server!.listen(this.path, () => r()));
  }

  private note(what: string, w: Waiter) {
    this.log.push({ at: Date.now(), what, pid: w.pid, event: w.event, session_id: w.session_id, prompt_id: w.prompt_id });
  }

  live(): Waiter[] {
    return this.waiters.filter((w) => !w.sock.destroyed && w.sock.writable);
  }

  /** Send mail to the newest live waiter (for a session, if given). */
  send(text: string, sessionId?: string): Waiter | undefined {
    const w = this.live()
      .filter((x) => sessionId === undefined || x.session_id === sessionId)
      .at(-1);
    if (!w) return undefined;
    w.sock.write(JSON.stringify({ mail: text }) + "\n");
    return w;
  }

  /** Send mail to every live waiter at once (race probe). */
  sendAll(text: string): Waiter[] {
    const all = this.live();
    for (const w of all) w.sock.write(JSON.stringify({ mail: text }) + "\n");
    return all;
  }

  close() {
    for (const w of this.live()) w.sock.destroy();
    this.server?.close();
    rmSync(this.path, { force: true });
  }
}
