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
assert.deepEqual(Buffer.concat(f.push(Buffer.concat([update, key, pointer, clipboard]))), update, "view-only must drop all input but preserve update requests");
allowed = true;
assert.deepEqual(Buffer.concat(f.push(key)), key, "owner control allows keys");
assert.deepEqual(Buffer.concat(f.push(pointer)), pointer, "owner control allows mouse");
allowed = false;
assert.deepEqual(f.push(key.subarray(0, 3)), [], "split packet held");
assert.deepEqual(f.push(key.subarray(3)), [], "split packet dropped");
assert.deepEqual(Buffer.concat(f.push(update)), update, "viewer continues receiving updates");

console.log("PASS RFB control lease input filter");
