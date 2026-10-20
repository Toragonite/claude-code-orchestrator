// Required first by every suite. It refuses to run a suite anywhere but in the copy that run.sh
// stages in its run directory, with HOME pointing at the scratch home run.sh made for it.
//
// Why: the suites write fixtures beside themselves and into HOME, and several of them start
// processes by name. Run straight from the repository they would write into it; run with the
// account's own HOME they would read and write real account directories. Neither may happen,
// so neither is left to the caller's care.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const refuse = (why) => {
  console.error(`refusing to run: ${why}\nRun the suite through .orchestrator/suites/run.sh --only <name>.`);
  process.exit(2);
};
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

if (!process.env.CCO_SUITES_RUN) refuse('CCO_SUITES_RUN is not set (no run directory)');
const RUN = real(process.env.CCO_SUITES_RUN);
const entry = real(require.main ? require.main.filename : process.argv[1]);
if (!inside(entry, path.join(RUN, 'stage'))) refuse(`${entry} is not the staged copy under ${path.join(RUN, 'stage')}`);

const HOME = os.homedir();
let accountHome;
try {
  accountHome = os.userInfo().homedir; // from the password database, whatever $HOME says
} catch {
  accountHome = undefined;
}
if (accountHome !== undefined && real(HOME) === real(accountHome)) refuse('HOME is the account\'s real home directory');
if (!inside(real(HOME), RUN)) refuse(`HOME (${HOME}) is not inside the run directory`);
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AGY_HOME']) {
  if (process.env[k] && !inside(real(process.env[k]), RUN)) refuse(`${k} points outside the run directory`);
}

module.exports = { RUN, HOME, REPO: process.env.CCO_SUITES_REPO };
