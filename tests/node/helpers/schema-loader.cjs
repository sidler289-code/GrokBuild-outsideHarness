'use strict';

/**
 * Minimal JSON Schema loader and validator for the 0.2.0 contract tests.
 *
 * Contract tests must validate the three normative plan examples against the
 * canonical schemas, and must reject the non-contract fields called out in
 * the PR-1 acceptance criteria (selectedHarnesses, preferences, lastVerified,
 * unknown schemaVersion).
 *
 * 0.2.0 ships no runtime third-party dependencies (see plan section 4.3), and
 * tests must use `node:test`. We therefore ship a hand-rolled subset of JSON
 * Schema draft 2020-12 that covers the contract surface: object, integer,
 * string, boolean, array, enum, const, required, additionalProperties,
 * minItems, minimum, maximum, minLength, maxLength, pattern, format date-time,
 * and $ref to #/$defs/<name>.
 *
 * This is intentionally NOT a general-purpose validator. It exists only to
 * lock the published schemas so that downstream PRs cannot drift them.
 */

const fs = require('fs');
const path = require('path');

function loadSchema(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  return JSON.parse(raw);
}

class ValidationError extends Error {
  constructor(message, path) {
    super(message + (path && path.length ? ` (at /${path.join('/')})` : ''));
    this.name = 'ValidationError';
    this.path = path || [];
  }
}

function resolveRef(schema, root) {
  if (!schema || typeof schema !== 'object') return schema;
  if (schema.$ref) {
    const ref = schema.$ref;
    if (!ref.startsWith('#/')) {
      throw new ValidationError(`unsupported $ref: ${ref}`, []);
    }
    const parts = ref.slice(2).split('/');
    let target = root;
    for (const part of parts) {
      if (!Object.prototype.hasOwnProperty.call(target, part)) {
        throw new ValidationError(`unresolvable $ref: ${ref}`, []);
      }
      target = target[part];
    }
    return target;
  }
  return schema;
}

const ISO_8601_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|([+-]\d{2}:\d{2}))$/;

function validateString(value, schema, trail) {
  if (typeof value !== 'string') {
    throw new ValidationError(`expected string, got ${typeof value}`, trail);
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    throw new ValidationError(
      `string shorter than minLength ${schema.minLength}`,
      trail
    );
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    throw new ValidationError(
      `string longer than maxLength ${schema.maxLength}`,
      trail
    );
  }
  if (schema.pattern !== undefined) {
    const re = new RegExp(schema.pattern);
    if (!re.test(value)) {
      throw new ValidationError(
        `string does not match pattern ${schema.pattern}`,
        trail
      );
    }
  }
  if (schema.format === 'date-time' && !ISO_8601_UTC_RE.test(value)) {
    throw new ValidationError(
      `string is not an ISO 8601 date-time: ${value}`,
      trail
    );
  }
}

function validateInteger(value, schema, trail) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(
      `expected integer, got ${value === null ? 'null' : typeof value}`,
      trail
    );
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new ValidationError(
      `integer below minimum ${schema.minimum}: ${value}`,
      trail
    );
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new ValidationError(
      `integer above maximum ${schema.maximum}: ${value}`,
      trail
    );
  }
}

function validateNumber(value, schema, trail) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new ValidationError(`expected number, got ${typeof value}`, trail);
  }
  if (schema.minimum !== undefined && value < schema.minimum) {
    throw new ValidationError(
      `number below minimum ${schema.minimum}: ${value}`,
      trail
    );
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    throw new ValidationError(
      `number above maximum ${schema.maximum}: ${value}`,
      trail
    );
  }
}

function validateEnum(value, schema, trail) {
  if (!schema.enum.includes(value)) {
    throw new ValidationError(
      `value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`,
      trail
    );
  }
}

function validateConst(value, schema, trail) {
  if (value !== schema.const) {
    throw new ValidationError(
      `value ${JSON.stringify(value)} !== const ${JSON.stringify(schema.const)}`,
      trail
    );
  }
}

function validateArray(value, schema, root, trail) {
  if (!Array.isArray(value)) {
    throw new ValidationError(`expected array, got ${typeof value}`, trail);
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new ValidationError(
      `array shorter than minItems ${schema.minItems}`,
      trail
    );
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new ValidationError(
      `array longer than maxItems ${schema.maxItems}`,
      trail
    );
  }
  if (schema.items !== undefined) {
    const itemSchema = resolveRef(schema.items, root);
    for (let i = 0; i < value.length; i++) {
      validateNode(value[i], itemSchema, root, trail.concat([i]));
    }
  }
}

function validateObject(value, schema, root, trail) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(
      `expected object, got ${value === null ? 'null' : typeof value}`,
      trail
    );
  }
  if (schema.additionalProperties === false && schema.properties !== undefined) {
    const allowed = new Set(Object.keys(schema.properties));
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        throw new ValidationError(
          `additional property not allowed: ${key}`,
          trail.concat([key])
        );
      }
    }
  }
  if (schema.required !== undefined) {
    for (const req of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) {
        throw new ValidationError(`missing required property: ${req}`, trail);
      }
    }
  }
  if (schema.properties !== undefined) {
    for (const [key, childSchemaRaw] of Object.entries(schema.properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const childSchema = resolveRef(childSchemaRaw, root);
      validateNode(value[key], childSchema, root, trail.concat([key]));
    }
  }
}

function validateNode(value, schema, root, trail) {
  const resolved = resolveRef(schema, root);
  // Union types: type: ["string", "null"], ["integer", "null"], etc.
  // Must be checked before the single-type switch below.
  if (Array.isArray(resolved.type)) {
    if (value === null && resolved.type.includes('null')) {
      // null is allowed; nothing else to check for the null branch
    } else {
      const primary = resolved.type.find((t) => t !== 'null');
      const adjusted = Object.assign({}, resolved, { type: primary });
      validateNode(value, adjusted, root, trail);
    }
    if (resolved.enum !== undefined) {
      validateEnum(value, resolved, trail);
    }
    if (resolved.const !== undefined) {
      validateConst(value, resolved, trail);
    }
    return;
  }
  if (resolved.type !== undefined) {
    switch (resolved.type) {
      case 'string':
        validateString(value, resolved, trail);
        break;
      case 'integer':
        validateInteger(value, resolved, trail);
        break;
      case 'number':
        validateNumber(value, resolved, trail);
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new ValidationError(`expected boolean, got ${typeof value}`, trail);
        }
        break;
      case 'array':
        validateArray(value, resolved, root, trail);
        break;
      case 'object':
        validateObject(value, resolved, root, trail);
        break;
      default:
        throw new ValidationError(
          `unsupported schema type: ${resolved.type}`,
          trail
        );
    }
  }
  if (resolved.enum !== undefined) {
    validateEnum(value, resolved, trail);
  }
  if (resolved.const !== undefined) {
    validateConst(value, resolved, trail);
  }
}

function validate(value, schema) {
  validateNode(value, schema, schema, []);
  return true;
}

module.exports = {
  loadSchema,
  validate,
  ValidationError,
};
