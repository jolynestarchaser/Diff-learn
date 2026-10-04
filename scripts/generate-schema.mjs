import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { outputSchema } from '../dist/evidence/schema.js';
import { syntaxOutputSchema } from '../dist/evidence/syntax.js';
import { candidateOutputSchema } from '../dist/evidence/candidates.js';
import { reviewStateSchema, reviewOutputSchema } from '../dist/review/schema.js';

const schema = z.toJSONSchema(outputSchema, { target: 'draft-2020-12', io: 'input' });
await writeFile(new URL('../docs/evidence.schema.json', import.meta.url), `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
await writeFile(new URL('../docs/syntax-evidence.schema.json', import.meta.url), `${JSON.stringify(z.toJSONSchema(syntaxOutputSchema, { target: 'draft-2020-12', io: 'input' }), null, 2)}\n`, 'utf8');
await writeFile(new URL('../docs/candidate-evidence.schema.json', import.meta.url), `${JSON.stringify(z.toJSONSchema(candidateOutputSchema, { target: 'draft-2020-12', io: 'input' }), null, 2)}\n`, 'utf8');
await writeFile(new URL('../docs/review-state.schema.json', import.meta.url), `${JSON.stringify(z.toJSONSchema(reviewStateSchema, { target: 'draft-2020-12', io: 'input' }), null, 2)}\n`, 'utf8');
await writeFile(new URL('../docs/review-output.schema.json', import.meta.url), `${JSON.stringify(z.toJSONSchema(reviewOutputSchema, { target: 'draft-2020-12', io: 'input' }), null, 2)}\n`, 'utf8');
