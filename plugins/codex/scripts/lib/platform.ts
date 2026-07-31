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
// Private by default: this plugin writes state, job records and logs, none of
// which any other user needs to read.
const DEFAULT_FILE_MODE = 0o600;
// Linux's PATH_MAX is 4096, macOS's is 1024; the larger is safe for both.
const PATH_MAX = 4096;
const LOCK_EXCLUSIVE_NON_BLOCKING = 2 | 4;
const LOCK_UN = 8;
const libc = dlopen(isDarwin ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  access: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  chmod: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  close: { args: [FFIType.i32], returns: FFIType.i32 },
  closedir: { args: [FFIType.ptr], returns: FFIType.i32 },
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  free: { args: [FFIType.ptr], returns: FFIType.void },
  mkdir: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  mkdtemp: { args: [FFIType.ptr], returns: FFIType.ptr },
  open: { args: [FFIType.ptr, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  opendir: { args: [FFIType.ptr], returns: FFIType.ptr },
  read: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  realpath: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  rename: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
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

// open(2) is variadic — `int open(const char *, int, ...)` — and its mode is a
// variadic argument. bun:ffi can only declare fixed arguments, which happens to
// work on x86-64 because the first arguments go in registers either way. Apple
// silicon passes variadic arguments on the stack instead, so open reads its
// mode from uninitialised stack rather than from the register the declaration
// filled. The result is an arbitrary mode, frequently 000, which locks the
// owner out of files this plugin has just written.
//
// The mode is therefore set explicitly after the fact, on files this call
// actually created. Files that already existed keep the mode they had.
function openFile(file: PathLike, flags: number, mode = DEFAULT_FILE_MODE): number {
  const filePath = resolve(asPath(file));
  const creating = (flags & OPEN_CREATE) !== 0;
  const existedBefore = creating ? existsSync(filePath) : true;
  const descriptor = callPath(libc.symbols.open, filePath, flags, mode);
  if (descriptor < 0) {
    throw new Error(`Unable to open ${asPath(file)}`);
  }
  if (creating && !existedBefore && callPath(libc.symbols.chmod, filePath, mode) !== 0) {
    libc.symbols.close(descriptor);
    throw new Error(`Unable to change mode for ${asPath(file)}`);
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

function acquireFileLockSync(file: PathLike, mode = 0o600): (() => void) | null {
  const filePath = resolve(asPath(file));
  const descriptor = openFile(filePath, 1 | OPEN_CREATE, mode);
  // Re-assert on an existing lock file: a lock left world readable by an older
  // version should not stay that way.
  if (callPath(libc.symbols.chmod, filePath, mode) !== 0) {
    libc.symbols.close(descriptor);
    throw new Error(`Unable to change mode for ${asPath(file)}`);
  }
  if (libc.symbols.flock(descriptor, LOCK_EXCLUSIVE_NON_BLOCKING) !== 0) {
    libc.symbols.close(descriptor);
    return null;
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    libc.symbols.flock(descriptor, LOCK_UN);
    libc.symbols.close(descriptor);
  };
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

function mkdirSync(directory: PathLike, options: { recursive?: boolean; mode?: number } = {}): void {
  const directoryPath = resolve(asPath(directory));
  const targets = options.recursive
    ? directoryPath
        .split("/")
        .filter(Boolean)
        .map((_, index, parts) => `/${parts.slice(0, index + 1).join("/")}`)
    : [directoryPath];

  for (const target of targets) {
    // Node applies the requested mode to every directory it creates, not just
    // the leaf. Creating the parents 0o777 left the state root world-readable,
    // and group or world writable under a lax umask, while the leaf asking for
    // 0o700 looked private. That root holds broker.json.
    const created = callPath(libc.symbols.mkdir, target, options.mode ?? 0o777) === 0;
    if (!created && !isDirectory(target)) {
      throw new Error(`Unable to create directory ${target}`);
    }
    // mkdir's mode is masked by the umask, so set it explicitly. Only on
    // directories this call created: pre-existing ones belong to the user.
    if (created && options.mode !== undefined && callPath(libc.symbols.chmod, target, options.mode) !== 0) {
      throw new Error(`Unable to change mode for ${target}`);
    }
  }

  // The leaf is re-asserted even when it already existed, so a state directory
  // left with the wrong mode by an older version repairs itself.
  if (options.mode !== undefined && callPath(libc.symbols.chmod, directoryPath, options.mode) !== 0) {
    throw new Error(`Unable to change mode for ${directoryPath}`);
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

// realpath(path, NULL) allocates the result, but that behaviour belongs to
// macOS's realpath$DARWIN_EXTSN, which the system headers alias in at compile
// time. dlopen resolves the plain symbol instead, and the variant that answers
// to that name has historically required a caller-supplied PATH_MAX buffer —
// handing it NULL writes through a null pointer. Supplying the buffer is
// correct for either variant and removes the question.
function realpathSync(file: PathLike): string {
  const buffer = new Uint8Array(PATH_MAX);
  const result = callPath(libc.symbols.realpath, resolve(asPath(file)), ptr(buffer));
  if (!result) {
    throw new Error(`Unable to resolve ${asPath(file)}`);
  }
  // The buffer is ours, so there is nothing to free.
  return new CString(ptr(buffer)).toString();
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

function renameSync(source: PathLike, destination: PathLike): void {
  const sourceBytes = cString(resolve(asPath(source)));
  const destinationBytes = cString(resolve(asPath(destination)));
  if (libc.symbols.rename(ptr(sourceBytes), ptr(destinationBytes)) !== 0) {
    throw new Error(`Unable to rename ${asPath(source)} to ${asPath(destination)}`);
  }
}

export const fs = {
  acquireFileLockSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync: removeDirectory,
  statSync,
  symlinkSync: createSymlink,
  unlinkSync: removeFile,
  writeFileSync
};
