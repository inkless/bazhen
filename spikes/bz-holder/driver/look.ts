// Prints the text of a holder's screen, from its snapshot: `node driver/look.ts <socket>`.
import { Conn, K, bytesOf, frame, newTerm, write } from "./lib.ts";

const c = await Conn.connect(process.argv[2]!);
const hello = await c.hello();
const snap = c.next(K.R_SNAPSHOT);
c.send(frame(K.SNAPSHOT));
const term = newTerm(hello.cols, hello.rows);
await write(term, bytesOf(await snap));
const buf = term.buffer.active;
for (let y = 0; y < hello.rows; y++) console.log(buf.getLine(buf.baseY + y)?.translateToString(true) ?? "");
console.log(JSON.stringify({ exit: hello.exit, alternate: hello.alternate, offset: hello.offset }));
c.close();
