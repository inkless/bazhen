import { EVENT_FRAME_MAX_BYTES } from "./events.ts";
import { HISTORY_LINES, STREAM_FRAME_MAX_BYTES } from "./stream.ts";

/**
 * What the protocol means beyond what its JSON Schema can say. `constants` are the values a client
 * and the daemon must agree on that no schema shows, so changing one changes the protocol id by
 * itself. For anything else a schema can't say, such as a refinement, a route, or what the daemon
 * does with a message, bump `revision` and say why in `reason`, in the change that alters it in a
 * way a client of the build before would misread. `moon run :schema` writes this to
 * `schema/semantics.json`, so it counts toward the id.
 */
export const PROTOCOL_SEMANTICS = {
  revision: 2,
  reason:
    "A holder view gets no screen frame: its own bytes carry the switch, and a page that read the frame alone would route the wheel as if on the main screen.",
  constants: { HISTORY_LINES, STREAM_FRAME_MAX_BYTES, EVENT_FRAME_MAX_BYTES },
} as const;
