export type ClientErrorReason = "Transport" | "UnexpectedStatus" | "UnsupportedContentType" | "MalformedResponse";
export declare class ClientError extends Error {
    readonly reason: ClientErrorReason;
    readonly name = "ClientError";
    constructor(reason: ClientErrorReason, options?: ErrorOptions);
}
