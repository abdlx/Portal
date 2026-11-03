// Argument validation mirroring Agent Computer's validateToolArguments:
// unknown keys rejected (additionalProperties: false), required keys
// enforced, types checked. Tool errors are returned as isError results,
// never as thrown 500s, by the caller.
export function validateArgs(schema, value, depth = 0) {
  if (depth > 12) throw new Error("arguments are too deeply nested");
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("arguments must be an object");
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) throw new Error(`missing argument: ${key}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties ?? {}, key)) {
        if (schema.additionalProperties === false) {
          throw new Error(`unknown argument: ${key}`);
        }
      } else {
        validateArgs(schema.properties[key], item, depth + 1);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error("argument must be an array");
    if (schema.items) {
      for (const item of value) validateArgs(schema.items, item, depth + 1);
    }
  } else if (schema.type === "number" || schema.type === "integer") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value))
    ) {
      throw new Error("argument must be a finite number");
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") throw new Error("argument must be a boolean");
  } else if (schema.type === "string") {
    if (typeof value !== "string") throw new Error("argument must be a string");
  }
}

export function obj(props, required = []) {
  return { type: "object", properties: props, required, additionalProperties: false };
}
