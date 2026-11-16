// Run inside a terminal: asks the daemon's socket at argv[2] for the stream at argv[3], presenting
// no credential, and writes what it has received so far to argv[4] as each chunk arrives: a
// refusal in full, or an upgrade's status line, which leaves the connection open. What the daemon
// makes of the caller then rests on its read of this process alone.

import { writeFileSync } from "node:fs";
import { connect } from "node:net";

const [socket = "", path = "", out = ""] = process.argv.slice(2);
const conn = connect(socket);
let response = "";
conn.on("data", (chunk: Buffer) => {
  response += chunk.toString("utf8");
  writeFileSync(out, response);
});
conn.write(
  `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
);
