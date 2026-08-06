/**
 * Minimal typings for the parts of mupdf this project uses.
 *
 * mupdf ships as pure ESM ("type": "module") with no CommonJS build, while the
 * NestJS app compiles to CommonJS. It is therefore loaded through a runtime
 * dynamic import rather than a static one — see ocr.service.ts.
 */
declare module 'mupdf' {
  export class Pixmap {
    asPNG(): Uint8Array;
  }

  export class Page {
    toPixmap(matrix: number[], colorspace: ColorSpace, alpha?: boolean, showExtras?: boolean): Pixmap;
  }

  export class Document {
    static openDocument(data: Buffer | Uint8Array, magic: string): Document;
    loadPage(pageNumber: number): Page;
    countPages(): number;
    destroy?(): void;
  }

  export class ColorSpace {
    static readonly DeviceRGB: ColorSpace;
    static readonly DeviceGray: ColorSpace;
  }

  export const Matrix: {
    scale(sx: number, sy: number): number[];
    identity: number[];
  };
}
