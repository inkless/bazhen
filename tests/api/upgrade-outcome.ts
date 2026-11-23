import { WebSocket } from "ws";

/** How an upgrade to `url` went: "open", or the status and message it was refused with. */
export const outcome = (url: string, headers: Record<string, string> = {}) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      resolve("open");
      ws.close();
    });
    ws.once("unexpected-response", (_q, res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      res.on("end", () => resolve([res.statusCode, body === "" ? null : JSON.parse(body).message]));
    });
    ws.once("error", reject);
  });
