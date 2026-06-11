/**
 * @module json-schema
 * A small, dependency-free JSON Schema validator covering the draft-07 subset
 * needed to validate skill settings: type checks (including unions and
 * `integer`), `enum`/`const`, numeric ranges (`minimum`/`maximum`/
 * `exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`), string constraints
 * (`minLength`/`maxLength`/`pattern`/`format`), object constraints
 * (`properties`/`required`/`additionalProperties`), and array constraints
 * (`items`/`minItems`/`maxItems`/`uniqueItems`).
 *
 * It is intentionally not a complete JSON Schema implementation — no `$ref`,
 * `allOf`/`anyOf`/`oneOf`, or remote schema resolution — keeping the package
 * lightweight while still giving authors precise, path-qualified errors.
 */

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  enum?: unknown[];
  const?: unknown;

  // String
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;

  // Number
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // Object
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;

  // Array
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;

  /** Human-friendly label used to phrase errors; falls back to the JSON path. */
  title?: string;
}

export interface SchemaError {
  /** JSON path to the offending value, e.g. `settings.timeout`. */
  path: string;
  /** Human-readable description of what failed. */
  message: string;
}

const URI_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function jsonType(value: unknown): JsonSchemaType | 'undefined' {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (t === 'string') return 'string';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'object';
  return 'object';
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  const actual = jsonType(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ak = Object.keys(a as object);
    const bk = Object.keys(b as object);
    if (ak.length !== bk.length) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function label(schema: JsonSchema, path: string): string {
  return schema.title ? `"${schema.title}"` : `"${path}"`;
}

/**
 * Validate `value` against `schema`, collecting every error in a single pass.
 * `path` seeds the JSON path used in error messages (defaults to `value`).
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  path = 'value',
): SchemaError[] {
  const errors: SchemaError[] = [];
  validateNode(value, schema, path, errors);
  return errors;
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: SchemaError[]): void {
  // ── type ──────────────────────────────────────────────────────────────
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({
        path,
        message: `${label(schema, path)} must be of type ${types.join(' | ')}, but got ${jsonType(value)}.`,
      });
      // Type is wrong — further keyword checks would be noise.
      return;
    }
  }

  // ── const / enum ───────────────────────────────────────────────────────
  if ('const' in schema && schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({ path, message: `${label(schema, path)} must equal ${JSON.stringify(schema.const)}.` });
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(value, e))) {
    errors.push({
      path,
      message: `${label(schema, path)} must be one of: ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}.`,
    });
  }

  if (typeof value === 'string') validateString(value, schema, path, errors);
  if (typeof value === 'number') validateNumber(value, schema, path, errors);
  if (Array.isArray(value)) validateArray(value, schema, path, errors);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    validateObject(value as Record<string, unknown>, schema, path, errors);
  }
}

function validateString(value: string, schema: JsonSchema, path: string, errors: SchemaError[]): void {
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push({ path, message: `${label(schema, path)} must be at least ${schema.minLength} characters long.` });
  }
  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    errors.push({ path, message: `${label(schema, path)} must be at most ${schema.maxLength} characters long.` });
  }
  if (schema.pattern !== undefined) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(schema.pattern);
    } catch {
      errors.push({ path, message: `${label(schema, path)} has an invalid pattern in its schema: "${schema.pattern}".` });
    }
    if (re && !re.test(value)) {
      errors.push({ path, message: `${label(schema, path)} must match the pattern /${schema.pattern}/.` });
    }
  }
  if (schema.format === 'uri' && !URI_RE.test(value)) {
    errors.push({ path, message: `${label(schema, path)} must be a valid URI.` });
  }
  if (schema.format === 'email' && !EMAIL_RE.test(value)) {
    errors.push({ path, message: `${label(schema, path)} must be a valid email address.` });
  }
}

function validateNumber(value: number, schema: JsonSchema, path: string, errors: SchemaError[]): void {
  if (schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ path, message: `${label(schema, path)} must be >= ${schema.minimum}.` });
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    errors.push({ path, message: `${label(schema, path)} must be <= ${schema.maximum}.` });
  }
  if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
    errors.push({ path, message: `${label(schema, path)} must be > ${schema.exclusiveMinimum}.` });
  }
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
    errors.push({ path, message: `${label(schema, path)} must be < ${schema.exclusiveMaximum}.` });
  }
  if (schema.multipleOf !== undefined && schema.multipleOf > 0) {
    const ratio = value / schema.multipleOf;
    if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
      errors.push({ path, message: `${label(schema, path)} must be a multiple of ${schema.multipleOf}.` });
    }
  }
}

function validateArray(value: unknown[], schema: JsonSchema, path: string, errors: SchemaError[]): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    errors.push({ path, message: `${label(schema, path)} must contain at least ${schema.minItems} item(s).` });
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    errors.push({ path, message: `${label(schema, path)} must contain at most ${schema.maxItems} item(s).` });
  }
  if (schema.uniqueItems) {
    for (let i = 0; i < value.length; i++) {
      for (let j = i + 1; j < value.length; j++) {
        if (deepEqual(value[i], value[j])) {
          errors.push({ path, message: `${label(schema, path)} must not contain duplicate items.` });
          i = value.length;
          break;
        }
      }
    }
  }
  if (schema.items) {
    value.forEach((item, i) => validateNode(item, schema.items!, `${path}[${i}]`, errors));
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: JsonSchema,
  path: string,
  errors: SchemaError[],
): void {
  for (const key of schema.required ?? []) {
    const v = value[key];
    if (v === undefined || v === null || v === '') {
      errors.push({ path: `${path}.${key}`, message: `Required property "${key}" is missing or empty.` });
    }
  }

  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value && value[key] !== undefined) {
        validateNode(value[key], propSchema, `${path}.${key}`, errors);
      }
    }
  }

  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        errors.push({ path: `${path}.${key}`, message: `Unknown property "${key}" is not allowed.` });
      }
    }
  } else if (typeof schema.additionalProperties === 'object' && schema.additionalProperties && schema.properties) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
        validateNode(value[key], schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
}
