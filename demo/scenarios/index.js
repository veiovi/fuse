// Demo scenarios, in the order the explorer offers them. Each is
// { id, title, summary, run(ctx) } with
// ctx = { registryUrl, logUrl, sites: { forum, api }, print(line), tmpDir, signal? }.
import banSticks from './ban-sticks.js';
import cheater from './cheater.js';
import honestAgent from './honest-agent.js';
import scanner from './scanner.js';

export const scenarios = [honestAgent, scanner, cheater, banSticks];
export default scenarios;
