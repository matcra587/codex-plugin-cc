// Modified from openai/codex-plugin-cc by Matt Craven in 2026.
// See NOTICE for attribution and plugins/codex/CHANGELOG.md for changes.

// Node's net.Socket buffers whatever the kernel will not take, so upstream
// could write a message of any size and rely on it arriving. Bun's socket
// instead returns the byte count it accepted and discards the rest, so an
// oversized line has to be held and re-offered on drain.
//
// Chunks are kept in a list rather than concatenated: appending to a single
// buffer copies the whole backlog every time, which is quadratic in the number
// of queued messages exactly when a peer has stopped reading. `offset` tracks
// how much of the head chunk the socket has already accepted.
export class SocketWriter {
  private readonly chunks: Uint8Array[] = [];
  private offset = 0;
  private queuedBytes = 0;

  get pendingBytes(): number {
    return this.queuedBytes - this.offset;
  }

  get isIdle(): boolean {
    return this.chunks.length === 0;
  }

  // Appends behind whatever is already queued, so ordering survives a stall.
  write(socket: { write(data: Uint8Array): number }, payload: Uint8Array): void {
    if (payload.length === 0) {
      return;
    }
    this.chunks.push(payload);
    this.queuedBytes += payload.length;
    // A short write is what armed Bun's writable poll. Writing again before
    // drain would disarm it, so only push when nothing is already waiting.
    if (this.chunks.length === 1) {
      this.flush(socket);
    }
  }

  // Safe to call from a drain handler: one drain can still only take part of
  // the head chunk, in which case the next drain continues from the offset.
  flush(socket: { write(data: Uint8Array): number }): void {
    while (this.chunks.length > 0) {
      const head = this.chunks[0] as Uint8Array;
      const remainder = this.offset === 0 ? head : head.subarray(this.offset);
      const written = socket.write(remainder);
      if (written <= 0) {
        return;
      }
      if (written < remainder.length) {
        this.offset += written;
        return;
      }
      this.chunks.shift();
      this.queuedBytes -= head.length;
      this.offset = 0;
    }
  }
}
