import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import type { CapabilityProfile, Commander, Goal, RuntimePolicy, WorkflowProfile } from '@jev/core';
import { assert, PROFILES, defaultStyles, validateCommanders, validateGoals } from '@jev/core';
export interface Configuration {
  workflow?: WorkflowProfile;
  version: 1;
  commanders: Commander[];
  goals?: Goal[];
  policy?: Partial<RuntimePolicy>;
  profiles?: Record<string, CapabilityProfile>;
}
export async function readConfiguration(path: string, schemaPath: string): Promise<Configuration> {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object;
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile<Configuration>(schema);
  const data: unknown = JSON.parse(await readFile(path, 'utf8'));
  assert(validate(data), `invalid config: ${ajv.errorsText(validate.errors)}`);
  validateCommanders(data.commanders, defaultStyles(), { ...PROFILES, ...data.profiles });
  validateGoals(data.goals ?? []);
  return data;
}
