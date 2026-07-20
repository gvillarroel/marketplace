import type { HarnessSpec, PlayerDefinition } from "./types.js";
export declare function isOwnedProfile(content: string | undefined, id: string, expectedRoster?: "personal" | "sdlc"): boolean;
export declare function validatePlayer(value: unknown, allowReserved?: boolean): PlayerDefinition;
export declare class Roster {
    private readonly spec;
    constructor(spec: HarnessSpec);
    private rootFor;
    private withMutationLock;
    protected applyChange(change: {
        path: string;
        content?: string;
    }, _index: number): Promise<void>;
    private transaction;
    private paths;
    join(input: unknown): Promise<string>;
    bench(args: string, bundled: ReadonlyMap<string, PlayerDefinition>): Promise<string>;
    retire(id: string): Promise<string>;
}
