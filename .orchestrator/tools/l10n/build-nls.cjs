#!/usr/bin/env node
/*
 * Update package.nls{,.ko,.zh-cn}.json VALUES only. Reads the files as they are in the repo now
 * (so a key another task added meanwhile survives), applies the overrides below by key, and
 * refuses to write if that would add or remove a key. Key order is kept.
 *
 * 2.0.0 overrides:
 *  - command.loginWorker.title: it was "Re-login Worker Account …" next to "Re-login Account …"
 *    (command.reloginWorker.title) in the same context menu. The two do different things:
 *      loginWorker   → opens the account's own CLI in a terminal (a Claude Code worker: an
 *                      interactive `claude`, which itself asks for a login when it has none);
 *      reloginWorker → runs the CLI's login command in a terminal (`claude auth login --email …`).
 *    The second title is quoted all over the runtime strings as "Re-login Account" and stays as is.
 *  - config.claudePath.description: the setting takes a command name or an absolute path only, and
 *    is read from the User settings only.
 *
 * usage: node build-nls.cjs [repo] [--write]
 */
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const repo = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', '..', '..'));
const write = args.includes('--write');

const overrides = {
  en: {
    'command.loginWorker.title': 'Sign In Worker Account (opens its CLI in a terminal; it asks you to sign in)',
    'config.claudePath.description':
      "The Claude Code CLI to run: a command name such as `claude` (looked up on PATH) or an absolute path. A relative path or one starting with '~' is not used: the default `claude` is used instead and you are told. Read from your User settings only — a workspace value is ignored.",
  },
  ko: {
    'command.loginWorker.title': '워커 계정 로그인 (터미널에서 해당 CLI를 열면 로그인을 요청함)',
    'config.claudePath.description':
      "실행할 Claude Code CLI입니다. PATH에서 찾는 `claude` 같은 명령 이름이거나 절대 경로여야 합니다. 상대 경로나 '~'로 시작하는 경로는 사용하지 않으며, 대신 기본값 `claude`를 사용하고 그 사실을 알려 줍니다. 사용자 설정에서만 읽으며, 워크스페이스에 지정한 값은 무시됩니다.",
  },
  zh: {
    'command.loginWorker.title': '登录 Worker 账号（在终端中打开其 CLI，由 CLI 提示登录）',
    'config.claudePath.description':
      "要运行的 Claude Code CLI：可以是 `claude` 这样在 PATH 中查找的命令名，也可以是绝对路径。相对路径或以 '~' 开头的路径不会被使用：将改用默认值 `claude`，并向你提示。仅从你的用户设置读取 — 工作区中的值会被忽略。",
  },
};
const files = { en: 'package.nls.json', ko: 'package.nls.ko.json', zh: 'package.nls.zh-cn.json' };

let bad = 0;
for (const lang of ['en', 'ko', 'zh']) {
  const file = path.join(repo, files[lang]);
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = { ...current };
  let changed = 0;
  for (const [key, value] of Object.entries(overrides[lang])) {
    if (!(key in current)) {
      console.log(`PROBLEM ${files[lang]}: override for a key that does not exist: ${key}`);
      bad++;
      continue;
    }
    if (current[key] !== value) {
      next[key] = value;
      changed++;
    }
  }
  if (JSON.stringify(Object.keys(next)) !== JSON.stringify(Object.keys(current))) {
    console.log(`PROBLEM ${files[lang]}: key set or order would change`);
    bad++;
  }
  console.log(`${files[lang]}: ${changed} value(s) to change`);
  if (write && !bad) fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}
if (write && !bad) console.log('written');
else if (write) console.log('NOT WRITTEN: fix the problems above first.');
process.exit(bad ? 1 : 0);
