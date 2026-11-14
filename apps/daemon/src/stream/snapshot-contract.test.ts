import { fakeContractHarness, snapshotContract } from "@bazhen/core/testing";
import { replay } from "../testing/browser-terminal.ts";

snapshotContract("FakeRuntime in snapshot mode", { ...fakeContractHarness("snapshot"), replay });
