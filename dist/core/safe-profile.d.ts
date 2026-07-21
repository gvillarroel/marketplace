/** Reads one contained regular file without following links or allocating past its byte cap. */
export declare function readSafeBoundedProfile(root: string, path: string, maximumBytes?: number): Promise<string | undefined>;
