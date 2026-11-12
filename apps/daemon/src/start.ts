// `bazhen start`: starts the daemon in a session of its own. Kept apart from main.ts, so starting
// loads only the config and this, not the daemon itself.

import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { InvalidConfig, loadSettings } from "./config/config.ts";
import { currentInputs } from "./config/paths.ts";
import { ensurePrivateDir } from "./config/private-dir.ts";
import { detach } from "./detach.ts";

const inputs = currentInputs();
try {
  const { paths, config } = loadSettings(inputs);
  mkdirSync(paths.state, { recursive: true });
  ensurePrivateDir(paths.run, inputs.uid);
  process.exitCode = await detach({
    entry: fileURLToPath(new URL("main.ts", import.meta.url)),
    socket: paths.socket,
    stateDir: paths.state,
    url: `http://127.0.0.1:${config.port}`,
    env: process.env,
    envRules: config.envRules,
  });
} catch (err) {
  if (!(err instanceof InvalidConfig)) throw err;
  console.error(err.message);
  process.exitCode = 1;
}
