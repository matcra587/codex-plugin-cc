import { CString, dlopen, FFIType, ptr } from "bun:ffi";

type PathLike = string | URL | number;
type FileData = string | ArrayBuffer | Uint8Array;
type WriteFileOptions = string | { encoding?: string; mode?: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isDarwin = process.platform === "darwin";
if (!isDarwin && process.platform !== "linux") {
  throw new Error(`codex-plugin-cc requires Linux or macOS; received ${process.platform}.`);
}
const OPEN_CREATE = isDarwin ? 0x200 : 0x40;
const OPEN_TRUNCATE = isDarwin ? 0x400 : 0x200;
const OPEN_APPEND = isDarwin ? 0x8 : 0x400;
const libc = dlopen(isDarwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  access: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  chmod: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  free: { args: [FFIType.ptr], returns: FFIType.void },
  mkdir: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  mkdtemp: { args: [FFIType.ptr], returns: FFIType.ptr },
  open: { args: [FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  opendir: { args: [FFIType.ptr], returns: FFIType.ptr },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  realpath: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  rmdir: { args: [FFIType.ptr], returns: FFIType.i32 },
  symlink: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  unlink: { args: [FFIType.ptr], returns: FFIType.i32 },
  write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 }
});

function asPath(value: PathLike): string {
  return value instanceof URL ? Bun.fileURLToPath(value) : String(value);
}

function cString(value: PathLike): Uint8Array {
  return encoder.encode(`${asPath(value)}\0`);
}

function callPath<Args extends unknown[], Result>(
  symbol: (path: ReturnType<typeof ptr>, ...args: Args) => Result,
  value: PathLike,
  ...args: Args
): Result {
  const bytes = cString(value);
  return symbol(ptr(bytes), ...args);
}

function openFile(file: PathLike, flags: number): number {
  const filePath = resolve(asPath(file));
  const descriptor = callPath(libc.symbols.open, filePath, flags, 0o666);
  if (descriptor < 0) {
    throw new Error(`Unable to open ${asPath(file)}`);
  }
  return descriptor;
}

function bytesFrom(data: FileData): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return encoder.encode(String(data));
}

function writeAll(descriptor: number, data: FileData): void {
  const bytes = bytesFrom(data);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = Number(libc.symbols.write(descriptor, ptr(bytes, offset), bytes.byteLength - offset));
    if (written <= 0) {
      throw new Error("Unable to write file");
    }
    offset += written;
  }
}

function normalize(value: unknown): string {
  const source = String(value);
  const absolute = source.startsWith("/");
  const parts: string[] = [];
  for (const part of source.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length && parts.at(-1) !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  const result = `${absolute ? "/" : ""}${parts.join("/")}`;
  return result || (absolute ? "/" : ".");
}

function resolve(...values: unknown[]): string {
  let result = "";
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = String(values[index] ?? "");
    if (!value) {
      continue;
    }
    result = result ? `${value}/${result}` : value;
    if (value.startsWith("/")) {
      return normalize(result);
    }
  }
  return normalize(`${process.cwd()}/${result}`);
}

function join(...values: unknown[]): string {
  return normalize(values.filter((value) => String(value).length > 0).join("/"));
}

function dirname(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === "/") {
    return "/";
  }
  const index = normalized.lastIndexOf("/");
  if (index < 0) {
    return ".";
  }
  return index === 0 ? "/" : normalized.slice(0, index);
}

function basename(value: unknown, suffix = ""): string {
  const normalized = normalize(value);
  const base = normalized === "/" ? "" : normalized.slice(normalized.lastIndexOf("/") + 1);
  return suffix && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

function extname(value: unknown): string {
  const base = basename(value);
  const index = base.lastIndexOf(".");
  return index <= 0 ? "" : base.slice(index);
}

function relative(from: unknown, to: unknown): string {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
    shared += 1;
  }
  return [...Array(fromParts.length - shared).fill(".."), ...toParts.slice(shared)].join("/");
}

export const path = {
  sep: "/",
  basename,
  dirname,
  extname,
  isAbsolute: (value: unknown) => String(value).startsWith("/"),
  join,
  normalize,
  relative,
  resolve
};

export const os = {
  homedir: () => process.env.HOME || "/",
  tmpdir: () => process.env.TMPDIR || "/tmp"
};

function readFileSync(file: PathLike, encoding: string): string;
function readFileSync(file: PathLike): Uint8Array;
function readFileSync(file: PathLike, encoding?: string): string | Uint8Array {
  const descriptor = file === 0 ? 0 : openFile(file, 0);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = new Uint8Array(64 * 1024);
      const bytesRead = Number(libc.symbols.read(descriptor, ptr(chunk), chunk.byteLength));
      if (bytesRead < 0) {
        throw new Error(`Unable to read ${asPath(file)}`);
      }
      if (bytesRead === 0) {
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
  } finally {
    if (descriptor !== 0) {
      libc.symbols.close(descriptor);
    }
  }
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoding ? decoder.decode(output) : output;
}

function writeFileSync(file: PathLike, data: FileData, options: WriteFileOptions = {}) {
  const descriptor = openFile(file, 1 | OPEN_CREATE | OPEN_TRUNCATE);
  try {
    writeAll(descriptor, data);
  } finally {
    libc.symbols.close(descriptor);
  }
  const mode = typeof options === "object" ? options.mode : null;
  if (mode != null && callPath(libc.symbols.chmod, resolve(asPath(file)), mode) !== 0) {
    throw new Error(`Unable to change mode for ${asPath(file)}`);
  }
}

function appendFileSync(file: PathLike, data: FileData, _encoding?: string) {
  const descriptor = openFile(file, 1 | OPEN_CREATE | OPEN_APPEND);
  try {
    writeAll(descriptor, data);
  } finally {
    libc.symbols.close(descriptor);
  }
}

function existsSync(file: PathLike): boolean {
  return callPath(libc.symbols.access, resolve(asPath(file)), 0) === 0;
}

function mkdirSync(directory: PathLike, options: { recursive?: boolean } = {}) {
  const directoryPath = resolve(asPath(directory));
  const targets = options.recursive
    ? directoryPath
        .split("/")
        .filter(Boolean)
        .map((_, index, parts) => `/${parts.slice(0, index + 1).join("/")}`)
    : [directoryPath];

  for (const target of targets) {
    if (callPath(libc.symbols.mkdir, target, 0o777) !== 0 && !isDirectory(target)) {
      throw new Error(`Unable to create directory ${target}`);
    }
  }
}

function mkdtempSync(prefix: PathLike): string {
  const template = cString(`${asPath(prefix)}XXXXXX`);
  const result = libc.symbols.mkdtemp(ptr(template));
  if (!result) {
    throw new Error(`Unable to create temporary directory from ${asPath(prefix)}`);
  }
  return new CString(result).toString();
}

function realpathSync(file: PathLike): string {
  const result = callPath(libc.symbols.realpath, resolve(asPath(file)), null);
  if (!result) {
    throw new Error(`Unable to resolve ${asPath(file)}`);
  }
  try {
    return new CString(result).toString();
  } finally {
    libc.symbols.free(result);
  }
}
realpathSync.native = realpathSync;

function readdirSync(directory: PathLike): string[] {
  return [...new Bun.Glob("*").scanSync({ cwd: asPath(directory), dot: true, onlyFiles: false })];
}

function statSync(file: PathLike) {
  if (!existsSync(file)) {
    throw new Error(`Unable to stat ${asPath(file)}`);
  }
  return {
    isDirectory: () => isDirectory(file)
  };
}

function isDirectory(file: PathLike): boolean {
  const directory = callPath(libc.symbols.opendir, resolve(asPath(file)));
  if (!directory) {
    return false;
  }
  libc.symbols.closedir(directory);
  return true;
}

function removeDirectory(directory: PathLike) {
  if (callPath(libc.symbols.rmdir, resolve(asPath(directory))) !== 0) {
    throw new Error(`Unable to remove directory ${asPath(directory)}`);
  }
}

function createSymlink(target: PathLike, linkPath: PathLike) {
  const targetBytes = cString(target);
  const linkBytes = cString(resolve(asPath(linkPath)));
  if (libc.symbols.symlink(ptr(targetBytes), ptr(linkBytes)) !== 0) {
    throw new Error(`Unable to create symbolic link ${asPath(linkPath)}`);
  }
}

function removeFile(file: PathLike) {
  if (callPath(libc.symbols.unlink, resolve(asPath(file))) !== 0) {
    throw new Error(`Unable to remove ${asPath(file)}`);
  }
}

export const fs = {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync: removeDirectory,
  statSync,
  symlinkSync: createSymlink,
  unlinkSync: removeFile,
  writeFileSync
};
