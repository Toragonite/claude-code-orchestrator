// The `vscode` stand-in of shell-a-stub.cjs (required as it is, not edited), with the few more
// things the SHELL-B checks need to observe:
//   - `vscode.open`, `vscode.diff` and `revealFileInOS` are recorded instead of refused;
//   - `showTextDocument` records the options it was given (the view column);
//   - `l10n.t` leaves a placeholder that has no argument in place, as the editor does;
//   - the registry file can be made unreadable AT THE MOMENT A WRITE STARTS (`corruptAtNextWrite`):
//     the first attempt to take the registry's lock swaps a damaged file in by rename, so the
//     read under the lock sees it while every read before it saw a good file. That is the
//     situation "the registry was damaged after this command looked the worker up".
//
// Usage:  const { install } = require('./shell-b-stub.cjs');
//         const h = install({ out, repo, home, ... });      // same options as shell-a-stub
'use strict';
const fs = require('fs');
const path = require('path');
const { install: installBase, AGENT_CLIS } = require('./shell-a-stub.cjs');

function install(opts = {}) {
  const h = installBase(opts);
  const vscode = h.vscode;

  // As the editor does it: a placeholder with no argument behind it stays a placeholder. The
  // pages are handed string tables whose `{0}` they fill in themselves.
  vscode.l10n.t = (msg, ...args) =>
    String(msg).replace(/\{(\d+)\}/g, (whole, i) => (Number(i) < args.length ? String(args[Number(i)]) : whole));

  h.log.vscodeOpen = [];
  h.log.shown = [];
  const baseExecute = vscode.commands.executeCommand;
  vscode.commands.executeCommand = async function (id, ...args) {
    if (id === 'vscode.open') {
      h.log.commandsExecuted.push({ id, args });
      h.log.vscodeOpen.push(args[0] && args[0].fsPath !== undefined ? args[0].fsPath : String(args[0]));
      return undefined;
    }
    return baseExecute.call(this, id, ...args);
  };
  const baseShow = vscode.window.showTextDocument;
  vscode.window.showTextDocument = async function (doc, options) {
    h.log.shown.push({ file: doc && doc.uri ? (doc.uri.fsPath ?? String(doc.uri)) : String(doc), options });
    return baseShow.call(this, doc, options);
  };

  const registryFile = path.join(h.root, 'registry.json');
  const lockPath = `${registryFile}.lock`;
  let armed = null;
  for (const name of ['symlinkSync', 'openSync', 'mkdirSync', 'linkSync']) {
    const real = fs[name];
    fs[name] = function (...args) {
      // symlinkSync(target, path) / linkSync(existing, new): the lock's own name is the last path.
      const named = name === 'symlinkSync' || name === 'linkSync' ? args[1] : args[0];
      if (armed !== null && named === lockPath) {
        const text = armed;
        armed = null;
        const tmp = `${registryFile}.swap-${process.pid}`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, registryFile);
        h.log.corruptedAtWrite = (h.log.corruptedAtWrite ?? 0) + 1;
      }
      return real.apply(this, args);
    };
  }
  /** Replace the registry file with `text` when the next registry write begins. */
  h.corruptAtNextWrite = (text) => {
    armed = text;
  };
  h.registryFile = registryFile;
  h.registryLock = lockPath;
  return h;
}

module.exports = { install, AGENT_CLIS };
