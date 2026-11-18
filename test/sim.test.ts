/* Headless checks of the shared simulation: run with `npm test`. */
import { createHarness } from './harness';
import { runAiTests } from './suite/ai.test';
import { runCombatTests } from './suite/combat.test';
import { runMovementTests } from './suite/movement.test';
import { runNetTests } from './suite/net.test';
import { runWorldTests } from './suite/world.test';

const h = await createHarness();

runMovementTests(h);
runCombatTests(h);
runWorldTests(h);
runAiTests(h);
runNetTests(h);

const failed = h.failedCount();
console.log(failed ? `\n${failed} check(s) failed` : '\nall good');
process.exit(failed ? 1 : 0);
