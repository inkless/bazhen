// Vitest setupFiles: seeds fast-check before each test file runs.

import * as fc from "fast-check";

import { fastCheckSeed } from "./fast-check-seed.ts";

fc.configureGlobal({ seed: fastCheckSeed(process.env) });
