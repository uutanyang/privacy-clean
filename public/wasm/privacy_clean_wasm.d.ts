/* tslint:disable */
/* eslint-disable */

/**
 * Metadata found during stripping
 */
export class MetadataReport {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    count(): number;
    fields(): any[];
}

/**
 * Analyze JPEG metadata (report only, no stripping)
 */
export function analyze_jpeg(data: Uint8Array): MetadataReport;

/**
 * Detect file type and analyze metadata
 */
export function analyze_metadata(data: Uint8Array, mime_type: string): MetadataReport;

/**
 * Analyze PDF metadata
 */
export function analyze_pdf(data: Uint8Array): MetadataReport;

/**
 * Analyze PNG metadata
 */
export function analyze_png(data: Uint8Array): MetadataReport;

/**
 * Strip EXIF/metadata from a JPEG file — lossless (no re-encoding)
 *
 * Returns the cleaned JPEG bytes. Image data is preserved bit-for-bit.
 * Only metadata segments (APP1/EXIF, APP13/IPTC, XMP) are removed.
 */
export function strip_jpeg(data: Uint8Array): Uint8Array;

/**
 * Detect file type and strip metadata accordingly
 */
export function strip_metadata(data: Uint8Array, mime_type: string): Uint8Array;

/**
 * Strip metadata from PDF — removes Author, Creator, Producer, etc.
 * Works at the binary level without re-rendering the document.
 */
export function strip_pdf(data: Uint8Array): Uint8Array;

/**
 * Strip metadata from PNG — lossless
 *
 * Removes tEXt, iTXt, zTXt chunks (textual metadata).
 * Preserves IHDR, PLTE, IDAT, IEND, and all other critical chunks.
 */
export function strip_png(data: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_metadatareport_free: (a: number, b: number) => void;
    readonly analyze_jpeg: (a: number, b: number, c: number) => void;
    readonly analyze_metadata: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly analyze_pdf: (a: number, b: number, c: number) => void;
    readonly analyze_png: (a: number, b: number, c: number) => void;
    readonly metadatareport_count: (a: number) => number;
    readonly metadatareport_fields: (a: number, b: number) => void;
    readonly strip_jpeg: (a: number, b: number, c: number) => void;
    readonly strip_metadata: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly strip_pdf: (a: number, b: number, c: number) => void;
    readonly strip_png: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
