import { type ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import type { AgentInputSchema } from "../../agents/types.js";

type AddFormatsFn = (ajv: Ajv2020) => Ajv2020;
const addFormats = (addFormatsModule as unknown as { default: AddFormatsFn }).default;

// Every agent input schema declares `$schema: ".../draft/2020-12/schema"`.
// The default `Ajv` class only ships the draft-07 meta-schema, so compile
// fails with `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`.
// `Ajv2020` preloads draft 2019-09 + draft 2020-12 meta-schemas.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export function validateInput(
  schema: AgentInputSchema,
  input: unknown,
): ValidationResult {
  const validate = ajv.compile(schema);
  const valid = validate(input);
  if (valid) {
    return { valid: true };
  }
  const errors = (validate.errors ?? []).map(
    (e: ErrorObject) => `${e.instancePath || "/"}: ${e.message ?? "invalid"}`,
  );
  return { valid: false, errors };
}
