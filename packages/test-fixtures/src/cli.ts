import { resolve } from 'node:path';
import { createFixture, fixtureKinds } from './index.js';
const root = resolve(process.argv[2] ?? '.test-fixtures');
for (const kind of fixtureKinds) console.log(createFixture(resolve(root, kind), kind));
console.log(createFixture(resolve(root, 'large'), 'linear', 2200));
