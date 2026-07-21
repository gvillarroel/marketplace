export type OpenCodeHarborInvocation = "agent" | "contract";
export interface OpenCodeHarborTitleClaim {
    readonly invocation: OpenCodeHarborInvocation;
    readonly agent: string;
}
export type OpenCodeHarborTitleSigner = (sessionID: string) => string;
export type OpenCodeHarborTitleVerifier = (title: string, sessionID: string) => OpenCodeHarborTitleClaim | undefined;
/** Prepares an ID-bound signer before any child is created. */
export declare function prepareSignedOpenCodeHarborTitle(home: string, project: string, invocation: OpenCodeHarborInvocation, agent: string): Promise<OpenCodeHarborTitleSigner>;
/** Verifies a title using an existing user key; read-only callers never create trust material. */
export declare function verifySignedOpenCodeHarborTitle(home: string, project: string, title: string, sessionID: string): Promise<OpenCodeHarborTitleClaim | undefined>;
/** Verifies a bounded batch with one key read, preserving input order. */
export declare function verifySignedOpenCodeHarborTitles(home: string, project: string, sessions: readonly {
    readonly title: string;
    readonly sessionID: string;
}[]): Promise<readonly (OpenCodeHarborTitleClaim | undefined)[]>;
/** Loads one read-only verifier for immediate bounded stop rechecks. */
export declare function loadOpenCodeHarborTitleVerifier(home: string, project: string): Promise<OpenCodeHarborTitleVerifier | undefined>;
/** Cheap detection used only for diagnostics; it never grants ownership. */
export declare function looksLikeOpenCodeHarborTitle(title: string): boolean;
