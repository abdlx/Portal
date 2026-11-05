// RFB client-input filtering. The VNC WebSocket is a raw RFB tunnel;
// never trust noVNC's viewOnly flag as an authorization boundary.
export class RfbClientFilter {
  constructor(canInput) {
    this.canInput = canInput;
    this.phase = 0; // protocol version, security choice, ClientInit, normal traffic
    this.pending = Buffer.alloc(0);
  }
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    this.pending = Buffer.concat([this.pending, chunk]);
    const outgoing = [];
    while (this.pending.length) {
      if (this.phase < 3) {
        const length = this.phase === 0 ? 12 : 1;
        if (this.pending.length < length) break;
        outgoing.push(this.pending.subarray(0, length));
        this.pending = this.pending.subarray(length);
        this.phase++;
        continue;
      }
      const b = this.pending;
      const type = b[0];
      let length = 0;
      if (type === 0) length = 20; // SetPixelFormat
      else if (type === 2) {
        if (b.length < 4) break;
        length = 4 + b.readUInt16BE(2) * 4; // SetEncodings
      } else if (type === 3) length = 10; // FramebufferUpdateRequest
      else if (type === 4) length = 8; // KeyEvent
      else if (type === 5) length = 6; // PointerEvent
      else if (type === 6) {
        if (b.length < 8) break;
        length = 8 + Math.abs(b.readInt32BE(4)); // ClientCutText / extended clipboard
      } else if (type === 150) {
        // Extended clipboard and vendor extensions cannot bypass input filtering.
        throw new Error("Unsupported RFB client extension");
      } else throw new Error(`Unsupported RFB client message ${type}`);
      if (length > 1024 * 1024) throw new Error("RFB message too large");
      if (b.length < length) break;
      if (![4, 5, 6].includes(type) || this.canInput()) {
        outgoing.push(b.subarray(0, length));
      }
      this.pending = this.pending.subarray(length);
    }
    return outgoing;
  }
}
