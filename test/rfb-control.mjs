import assert from "node:assert/strict";
import { RfbClientFilter } from "../src/rfb-control.mjs";

let allowed = false;
const f = new RfbClientFilter(() => allowed);
const handshake = Buffer.concat([Buffer.from("RFB 003.008\n"), Buffer.from([1, 1])]);
assert.deepEqual(Buffer.concat(f.push(handshake)), handshake);

const update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]);
const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]);
const pointer = Buffer.from([5, 1, 0, 3, 0, 4]);
const clipboard = Buffer.concat([Buffer.from([6, 0, 0, 0, 0, 0, 0, 3]), Buffer.from("abc")]);
const fence = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 1, 65]);
const contUpdates = Buffer.from([150, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 65, 0, 0, 0, 30]);
assert.deepEqual(Buffer.concat(f.push(Buffer.concat([update, key, pointer, clipboard, fence, contUpdates, qemuKey]))), Buffer.concat([update, fence, contUpdates]), "view-only must drop all input (keys, mouse, clipboard, qemu keys) but preserve updates, fences, and continuous updates");
allowed = true;
assert.deepEqual(Buffer.concat(f.push(key)), key, "owner control allows keys");
assert.deepEqual(Buffer.concat(f.push(pointer)), pointer, "owner control allows mouse");
assert.deepEqual(Buffer.concat(f.push(qemuKey)), qemuKey, "owner control allows qemu keys");
allowed = false;
assert.deepEqual(f.push(key.subarray(0, 3)), [], "split packet held");
assert.deepEqual(f.push(key.subarray(3)), [], "split packet dropped");
assert.deepEqual(Buffer.concat(f.push(update)), update, "viewer continues receiving updates");

console.log("PASS RFB control lease input filter");

const extensions = new RfbClientFilter(() => false);
extensions.push(handshake);
const continuous = Buffer.from([150, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
const fence2 = Buffer.from([248, 0, 0, 0, 0, 0, 0, 0, 0]);
const resize = Buffer.from([251, 0, 5, 0, 4, 0, 0, 0]);
assert.deepEqual(Buffer.concat(extensions.push(Buffer.concat([continuous, fence2, resize, update]))),
  Buffer.concat([continuous, fence2, update]), "viewer extensions must not disconnect, resize stays blocked");
const signedClipboard = Buffer.from([6, 0, 0, 0, 255, 255, 255, 255, 99]);
assert.deepEqual(extensions.push(signedClipboard), [], "extended clipboard is not allowed in view-only mode");
assert.deepEqual(Buffer.concat(extensions.push(update)), update, "viewer still works after clipboard packet");
console.log("PASS noVNC extensions and clipboard isolation");
