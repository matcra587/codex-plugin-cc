declare const Bun: any;
declare const process: any;

declare function setTimeout(callback: (...args: any[]) => void, delay?: number, ...args: any[]): any;
declare function clearTimeout(timeout: any): void;

declare module "bun:ffi" {
  export const CString: any;
  export const FFIType: any;
  export const dlopen: any;
  export const ptr: any;
}

declare module "bun:test" {
  export const afterEach: any;
  export const expect: any;
  export const test: any;
}
