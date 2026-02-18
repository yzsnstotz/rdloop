const { assertNoLlm } = require('./no_llm');
const { startBot } = require('./bot');
const { startNotifier } = require('./notifier');

// NO_LLM enforcement: must pass before anything else
assertNoLlm();

const bot = startBot();
startNotifier(bot);
