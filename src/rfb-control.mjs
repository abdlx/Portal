// Server-side VNC input gate. RFB handshake messages must flow even when
// the viewer is read-only; the noVNC client also sends optional extensions
// during connection that must not tear down the entire WebSocket.
export class RfbClientFilter {
  constructor(canInput) {
    this.canInput = canInput;
    this.phase = 0; // client version (12), security selection (1), ClientInit (1)
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length > 1024 * 1024 || this.pending.length + chunk.length > 2 * 1024 * 1024)
      throw new Error("RFB client message too large");
    this.pending = Buffer.concat([this.pending, chunk]);
    const outgoing = [];
    while (this.pending.length) {
      if (this.phase < 3) {
        const length = this.phase === 0 ? 12 : 1;
        if (this.pending.length < length) break;
        if (this.phase === 0 && !this.pending.subarray(0, 4).equals(Buffer.from("RFB ")))
          throw new Error("Invalid RFB protocol handshake");
        outgoing.push(this.pending.subarray(0, length));
        this.pending = this.pending.subarray(length);
        this.phase++;
        continue;
      }
      const b = this.pending;
      const type = b[0];
      let length;
      let control = false;
      switch (type) {
        case 0: length = 20; break; // SetPixelFormat
        case 2: // SetEncodings
          if (b.length < 4) return outgoing;
          length = 4 + b.readUInt16BE(2) * 4;
          break;
        case 3: length = 10; break; // FramebufferUpdateRequest
        case 4: length = 8; control = true; break; // KeyEvent
        case 5: length = 6; control = true; break; // PointerEvent
        case 6: // ClientCutText, also used for extended clipboard
          if (b.length < 8) return outgoing;
          length = 8 + (b.readUInt32BE(4) >>> 0);
          control = true;
          break;
        case 150: length = 10; break; // EnableContinuousUpdates
        case 248: // ClientFence: flags (4), length (1), payload
          if (b.length < 9) return outgoing;
          length = 9 + b[8];
          break;
        case 250: length = 4; control = true; break; // XVP
        case 251: // SetDesktopSize: header 8 bytes, screens (16 bytes each)
          if (b.length < 8) return outgoing;
          length = 8 + b[6] * 16;
          control = true;
          break;
        default:
          // Unknown extensions cannot be safely framed. Fail closed with
          // diagnostics instead of forwarding potentially privileged input.
          throw new Error(`Unsupported RFB client message ${type}`);
      }
      if (length > 1024 * 1024) throw new Error("RFB message too large");
      if (b.length < length) break;
      if (!control || this.canInput()) outgoing.push(b.subarray(0, length));
      this.pending = this.pending.subarray(length);
    }
    return outgoing;
  }
}
