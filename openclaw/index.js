const { assertNoLlm } = require('./no_llm');
const { startBot } = require('./bot');
const { startNotifier } = require('./notifier');
const { registerHandlers, startBridgePoller } = require('./claude_bridge');

// NO_LLM enforcement: must pass before anything else
assertNoLlm();

const bot = startBot();
startNotifier(bot);

if (bot) {
  registerHandlers(bot);
  startBridgePoller(bot);
}
