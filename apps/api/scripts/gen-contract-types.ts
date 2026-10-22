/**
 * Generates TypeScript types from the frozen v1 contracts in docs/contracts.
 * The contracts are the source of truth; never edit the generated files by hand.
 *   pnpm contracts:gen
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';
import { compile } from 'json-schema-to-typescript';

const contractsDir = resolve(__dirname, '../../../docs/contracts');
const outDir = resolve(__dirname, '../src/contracts/generated');
const banner = '/* eslint-disable */\n// GENERATED from docs/contracts by scripts/gen-contract-types.ts. Do not edit.\n\n';

async function main(): Promise<void> {
  const ast = await openapiTS(new URL(`file://${contractsDir}/internal-api.openapi.yaml`));
  writeFileSync(resolve(outDir, 'internal-api.ts'), banner + astToString(ast));

  const events: Array<[string, string]> = [
    ['events/envelope.schema.json', 'EventEnvelope'],
    ['events/appointment.booked.v1.schema.json', 'AppointmentBookedV1'],
  ];
  let out = banner;
  for (const [file, name] of events) {
    const schema = JSON.parse(readFileSync(resolve(contractsDir, file), 'utf8'));
    out += await compile({ ...schema, title: name }, name, { bannerComment: '', additionalProperties: false });
    out += '\n';
  }
  writeFileSync(resolve(outDir, 'events.ts'), out);

  // Runtime copies of the event schemas: emitted events are validated against them.
  for (const [file] of events) {
    copyFileSync(resolve(contractsDir, file), resolve(outDir, file.replace('events/', '')));
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
