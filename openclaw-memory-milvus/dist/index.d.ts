type SearchHit = {
    id: string;
    relPath: string;
    absPath?: string;
    sourceType?: string;
    startLine: number;
    endLine: number;
    text: string;
    vectorScore: number;
    textScore: number;
    score: number;
    backend: "postgres" | "hindsight" | "hybrid";
};
export declare function tokenizeQuery(query: string): string[];
export declare function extractSpanIdsFromHindsightResponse(payload: unknown): string[];
export declare function mergeHits(vectorHits: SearchHit[], looseTextHits: SearchHit[], strictTextHits: SearchHit[], query: string, limit: number): SearchHit[];
declare const _default: import("openclaw/plugin-sdk/tool-plugin").DefinedToolPluginEntry;
export default _default;
