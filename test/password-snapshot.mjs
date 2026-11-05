import assert from "node:assert/strict";
import vm from "node:vm";
import { SNAPSHOT_JS } from "../src/browser.mjs";

const input = {
  id: "password", type: "password", tagName: "INPUT",
  value: "DO_NOT_DISCLOSE_PASSWORD_123", textContent: "",
  disabled: false, checked: false,
  getAttribute: () => null,
  checkVisibility: () => true,
};
const document = {
  querySelectorAll: (selector) => selector === "#password" ? [input] : [input],
  documentElement: {},
};
const result = vm.runInNewContext(`(${SNAPSHOT_JS})()`, { document });
assert.equal(result.length, 1);
assert.equal(result[0].isPassword, true);
assert.equal(JSON.stringify(result).includes(input.value), false, "password value must never appear in the accessibility snapshot");
console.log("PASS password value removed from agent snapshot");
