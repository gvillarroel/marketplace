/**
 * Resolves an existing path through symlinks/junctions. A deliberately
 * synthetic path is keyed below its nearest physical directory ancestor.
 * Permission and other I/O failures remain fatal instead of splitting scope.
 */
export declare function canonicalPathIdentity(value: string): string;
/** Canonical directory identity used for admission, views, and stop scope. */
export declare function canonicalProjectIdentity(project: string): string;
export declare function sameCanonicalProject(left: string, right: string): boolean;
export declare function samePhysicalPath(left: string, right: string): boolean;
