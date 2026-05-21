import { Ajv, type ErrorObject } from "ajv";
import * as addFormatsModule from "ajv-formats";
import type { AgentInputSchema } from "../../agents/types.js";

type AddFormatsFn = (ajv: Ajv) => Ajv;
const addFormats = (addFormatsModule as unknown as { default: AddFormatsFn }).default;

const ajv = new Ajv({ allErrors: true, strict: false });
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
