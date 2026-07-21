/** Canonical project profile layout shared by rendering and active discovery. */
import type { HarnessName } from "./types.js";
export interface HarnessProfileLayout {
    readonly activeDir: string;
    readonly extension: string;
}
/** Returns the canonical active-profile directory and extension for a harness. */
export declare function harnessProfileLayout(harness: HarnessName): HarnessProfileLayout;
