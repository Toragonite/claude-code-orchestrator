#!/usr/bin/env node
/*
 * Generate the README blocks that must not drift from the code, for the three README files:
 *
 *   settings  — from package.json `contributes.configuration.properties` (key, type, default,
 *               range / enum) with the description resolved from that language's package.nls;
 *   commands  — from package.json `contributes.commands` + `menus` (title resolved from nls,
 *               where each command appears);
 *   tools     — tool names and argument names read from the server's own tool definitions
 *               (TOOLS in src/mcp/server.ts, MESH_TOOLS in src/mesh/contract.ts) with the
 *               TypeScript parser; the one-line purpose per tool is the hand-written part and
 *               the script FAILS when a tool has no purpose text or a purpose names no tool;
 *   params    — the dispatch arguments (TASK_PROPERTIES keys), same rule.
 *
 * Blocks live between `<!-- BEGIN GENERATED:<name> … -->` and `<!-- END GENERATED:<name> -->`.
 *
 * Run from the repository root (or give the root as the first argument):
 *
 *   node .orchestrator/tools/docs/gen-readme-blocks.cjs --check      exit 1 when a README block is stale
 *   node .orchestrator/tools/docs/gen-readme-blocks.cjs --write      rewrite the blocks in place
 *   node .orchestrator/tools/docs/gen-readme-blocks.cjs --print en   print the blocks for one language
 *
 * Needs `npm install` to have been run (it reads the TypeScript parser from node_modules).
 * The hand-written parts (TOOL_PURPOSE, PARAM_MEANING, the table headers) live in this file, in
 * three languages; everything else is read from the code.
 */
const fs = require('fs');
const path = require('path');
const argv = process.argv.slice(2);
const printAt = argv.indexOf('--print');
const printLang = printAt >= 0 ? argv[printAt + 1] : undefined;
const positional = argv.filter((a, i) => !a.startsWith('--') && (printAt < 0 || i !== printAt + 1));
const repo = path.resolve(positional[0] || path.join(__dirname, '..', '..', '..'));
const tsPath = path.join(repo, 'node_modules', 'typescript', 'lib', 'typescript.js');
if (!fs.existsSync(tsPath)) {
  console.error(`ERROR cannot find the TypeScript parser at ${tsPath} — run \`npm install\` in ${repo} first`);
  process.exit(2);
}
const ts = require(tsPath);
const mode = argv.includes('--write') ? 'write' : argv.includes('--print') ? 'print' : 'check';

const LANGS = {
  en: { readme: 'README.md', nls: 'package.nls.json' },
  ko: { readme: 'README.ko.md', nls: 'package.nls.ko.json' },
  zh: { readme: 'README.zh-CN.md', nls: 'package.nls.zh-cn.json' },
};

const T = {
  en: {
    setting: 'Setting', type: 'Type', def: 'Default', allowed: 'Allowed', desc: 'Description',
    command: 'Command', id: 'Command id', where: 'Where it appears',
    palette: 'Command Palette', viewTitle: '{0} view toolbar', viewItem: '{0} view, on a row', internal: 'not shown — used by the dashboard and the views',
    tool: 'Tool', args: 'Arguments', purpose: 'Purpose', none: 'none', required: 'required', each: 'each task takes the dispatch arguments below',
    arg: 'Argument', argType: 'Type', meaning: 'Meaning', any: 'any',
    tString: 'string', tNumber: 'number', tInteger: 'integer', tBoolean: 'boolean', tArray: 'list of strings',
  },
  ko: {
    setting: '설정', type: '유형', def: '기본값', allowed: '허용 값', desc: '설명',
    command: '명령', id: '명령 ID', where: '표시 위치',
    palette: '명령 팔레트', viewTitle: '{0} 뷰 툴바', viewItem: '{0} 뷰의 행', internal: '표시되지 않음 — 대시보드와 뷰가 내부적으로 사용',
    tool: '도구', args: '인자', purpose: '용도', none: '없음', required: '필수', each: '각 작업은 아래의 디스패치 인자를 받습니다',
    arg: '인자', argType: '유형', meaning: '의미', any: '제한 없음',
    tString: '문자열', tNumber: '숫자', tInteger: '정수', tBoolean: '불리언', tArray: '문자열 목록',
  },
  zh: {
    setting: '设置', type: '类型', def: '默认值', allowed: '允许的值', desc: '说明',
    command: '命令', id: '命令 ID', where: '出现位置',
    palette: '命令面板', viewTitle: '“{0}”视图工具栏', viewItem: '“{0}”视图中的行', internal: '不显示 — 供仪表板和视图内部使用',
    tool: '工具', args: '参数', purpose: '用途', none: '无', required: '必填', each: '每个任务接受下面的分发参数',
    arg: '参数', argType: '类型', meaning: '含义', any: '不限',
    tString: '字符串', tNumber: '数字', tInteger: '整数', tBoolean: '布尔值', tArray: '字符串列表',
  },
};

// ---- hand-written text, checked against the code below -------------------------------------
const TOOL_PURPOSE = {
  dispatch_tasks: {
    en: '**Batch dispatch (preferred).** Hand over several independent tasks in one call (1–100). They run in parallel across worker accounts, up to the server\'s concurrency limit (8 by default); the rest wait their turn. One malformed task refuses the whole call and nothing runs. The call returns every result.',
    ko: '**일괄 디스패치(권장).** 독립적인 작업 여러 개(1–100개)를 한 번의 호출로 넘깁니다. 작업은 워커 계정들에서 병렬로 실행되지만 서버의 동시 실행 한도(기본 8)까지만 동시에 돌고, 나머지는 순서를 기다립니다. 형식이 잘못된 작업이 하나라도 있으면 호출 전체가 거부되고 아무것도 실행되지 않습니다. 호출은 모든 결과를 돌려줍니다.',
    zh: '**批量分发（推荐）。** 一次调用交出多个相互独立的任务（1–100 个）。它们在各 worker 账号上并行运行，但同时运行的数量以服务器的并发上限为限（默认 8），其余的按顺序等待。只要有一个任务格式不正确，整个调用就会被拒绝，任何任务都不会运行。调用会返回全部结果。',
  },
  dispatch_task: {
    en: 'Dispatch one self-contained task to one worker. On a quota error it fails over to another eligible worker.',
    ko: '독립적으로 완결된 작업 하나를 워커 하나에 디스패치합니다. 쿼터 오류가 나면 사용 가능한 다른 워커로 페일오버합니다.',
    zh: '把一个自包含的任务分发给一个 worker。遇到配额错误时会故障转移到另一个可用的 worker。',
  },
  dispatch_status: {
    en: 'Read-only: the latest status of a dispatched task by id (running, done or error) — one `id`, or up to 100 `ids` — and, once it has finished, its result (whole up to 1 MiB), including that of a `detach` task whose session was interrupted. An id with no record is `not_found`; if the task log cannot be read, the call fails and says the status is UNKNOWN.',
    ko: '읽기 전용: 디스패치된 작업의 최신 상태(running, done, error)를 ID로 조회하고(`id` 하나, 또는 최대 100개의 `ids`), 끝난 작업이면 결과(1 MiB까지는 전체)를 돌려줍니다 — 세션이 중단된 `detach` 작업도 포함됩니다. 기록이 없는 ID는 `not_found`이며, 작업 로그를 읽을 수 없으면 호출이 실패하고 상태를 알 수 없음(UNKNOWN)을 알립니다.',
    zh: '只读：按 ID 查询已分发任务的最新状态（running、done 或 error）— 可传一个 `id`，或最多 100 个 `ids` — 任务结束后还会返回其结果（不超过 1 MiB 时为完整结果），包括会话被中断的 `detach` 任务。没有记录的 ID 返回 `not_found`；如果无法读取任务日志，调用会失败，并说明状态未知（UNKNOWN）。',
  },
  orchestrator_briefing: {
    en: 'Called once per session by the main model, with its own model id. Records the orchestrator model for the workspace and returns the operating brief for its tier; with session workers on, or other-vendor workers registered, the brief carries those rules too.',
    ko: '메인 모델이 세션마다 한 번, 자신의 모델 ID와 함께 호출합니다. 워크스페이스의 오케스트레이터 모델을 기록하고 해당 등급에 맞는 운영 브리핑을 돌려줍니다. 세션 워커가 켜져 있거나 다른 벤더의 워커가 등록되어 있으면 그 규칙도 브리핑에 포함됩니다.',
    zh: '由主模型在每个会话中调用一次，并传入自己的模型 ID。它会记录此工作区的编排器模型，并返回与其层级相应的运行简报；开启会话 worker 或注册了其他厂商的 worker 时，简报还会包含相应规则。',
  },
  list_workers: {
    en: 'Every worker with its default model, cumulative dispatch usage, cooldown state and live plan usage (with reset times and overage-billing state), plus the frontier guard state and how many dispatches wait for a free slot. When a worker on another vendor\'s CLI is registered, each line also names the CLI it runs on, and such a worker shows its login state and suggested model ids. Registry entries this version cannot use are listed as such; a registry that cannot be read is reported instead of a list.',
    ko: '모든 워커의 기본 모델, 누적 디스패치 사용량, 쿨다운 상태, 실시간 플랜 사용량(재설정 시각과 초과 과금 상태 포함), 프런티어 가드 상태, 빈 슬롯을 기다리는 디스패치 수를 보여 줍니다. 다른 벤더의 CLI에서 실행되는 워커가 등록되어 있으면 각 줄에 실행되는 CLI가 표시되고, 그런 워커에는 로그인 상태와 권장 모델 ID도 표시됩니다. 이 버전이 쓸 수 없는 레지스트리 항목은 그렇게 표시되며, 레지스트리를 읽을 수 없으면 목록 대신 그 문제를 알립니다.',
    zh: '列出每个 worker 的默认模型、累计分发用量、冷却状态和实时套餐用量（含重置时间与超额计费状态），以及前沿防护的状态和正在等待空闲名额的分发数量。注册了其他厂商 CLI 上的 worker 时，每一行还会标明所用的 CLI，这类 worker 还会显示登录状态和建议的模型 ID。本版本无法使用的注册表条目会如实列出；如果无法读取注册表，则报告该问题，而不是给出列表。',
  },
  mesh_status: {
    en: 'Session workers only. How many dispatches are in flight against the cap, how many workers are parked, and per worker: task, account, model, permission mode, state, job id, the name to message it by, its worktree, and an attach command. Also reports workers whose owning session is gone.',
    ko: '세션 워커 전용. 상한 대비 진행 중인 디스패치 수와 파킹된 워커 수, 그리고 워커별 작업, 계정, 모델, 권한 모드, 상태, job ID, 메시지를 보낼 때 쓰는 이름, worktree, 연결 명령을 보여 줍니다. 소유 세션이 사라진 워커도 보고합니다.',
    zh: '仅用于会话 worker。显示进行中的分发数量与上限、已停驻的 worker 数量，以及每个 worker 的任务、账号、模型、权限模式、状态、作业 ID、发消息时使用的名称、worktree 和连接命令。还会报告所属会话已消失的 worker。',
  },
  mesh_stop_worker: {
    en: 'Stop one session worker, by `job_id` (preferred) or by name. Its worktree is removed only when it is clean; one that still holds uncommitted or unpushed work is kept.',
    ko: '세션 워커 하나를 `job_id`(권장) 또는 이름으로 중지합니다. worktree는 깨끗할 때만 제거되며, 커밋하지 않았거나 푸시하지 않은 작업이 남아 있으면 유지됩니다.',
    zh: '按 `job_id`（推荐）或名称停止一个会话 worker。只有干净的 worktree 才会被移除；仍含有未提交或未推送工作的 worktree 会保留。',
  },
};

const PARAM_MEANING = {
  title: {
    en: 'Short label shown in the task lists. One line; cut at 200 characters.',
    ko: '작업 목록에 표시되는 짧은 제목입니다. 한 줄이며 200자에서 잘립니다.',
    zh: '显示在任务列表中的简短标题。单行，超过 200 个字符会被截断。',
  },
  prompt: {
    en: 'The complete, self-contained task. The worker sees nothing else of your conversation. Not empty, no NUL character, at most 1 MiB.',
    ko: '독립적으로 완결된 전체 작업 내용입니다. 워커는 대화의 다른 내용을 보지 못합니다. 비어 있으면 안 되고, NUL 문자를 포함할 수 없으며, 1 MiB를 넘을 수 없습니다.',
    zh: '完整且自包含的任务说明。worker 看不到你对话中的其他内容。不能为空，不能含 NUL 字符，最大 1 MiB。',
  },
  model: {
    en: 'A tier alias — `opus`, `sonnet`, `fable`, `haiku` — or a full model id. Omit it for the worker\'s default. A value that is neither is rejected, not replaced. For a worker on another vendor\'s CLI, pass that vendor\'s own model id.',
    ko: '등급 별칭(`opus`, `sonnet`, `fable`, `haiku`) 또는 전체 모델 ID입니다. 생략하면 워커의 기본 모델을 씁니다. 어느 쪽도 아닌 값은 다른 모델로 바뀌지 않고 거부됩니다. 다른 벤더의 CLI에서 실행되는 워커에는 그 벤더의 모델 ID를 넘기세요.',
    zh: '层级别名（`opus`、`sonnet`、`fable`、`haiku`）或完整的模型 ID。省略时使用 worker 的默认模型。两者都不是的值会被拒绝，而不会被替换。对于其他厂商 CLI 上的 worker，请传入该厂商自己的模型 ID。',
  },
  worker: {
    en: 'A specific worker account. Omit it for automatic, quota-aware assignment among Claude Code workers.',
    ko: '특정 워커 계정입니다. 생략하면 Claude Code 워커들 사이에서 쿼터를 고려해 자동으로 배정합니다.',
    zh: '指定某个 worker 账号。省略时在 Claude Code worker 之间按配额情况自动分配。',
  },
  provider: {
    en: 'Opt in to another vendor\'s CLI: `codex`, `cursor` or `gemini` (Antigravity). Omitted, a task only ever runs on a Claude Code worker.',
    ko: '다른 벤더의 CLI를 쓰도록 명시합니다: `codex`, `cursor`, `gemini`(Antigravity). 생략하면 작업은 Claude Code 워커에서만 실행됩니다.',
    zh: '明确选择其他厂商的 CLI：`codex`、`cursor` 或 `gemini`（Antigravity）。省略时任务只会在 Claude Code worker 上运行。',
  },
  system_prompt: {
    en: 'A task-specific system prompt (role, quality bar, output format), layered on the built-in worker base prompt. No NUL character, at most 256 KiB.',
    ko: '작업별 시스템 프롬프트(역할, 품질 기준, 출력 형식)이며, 내장된 워커 기본 프롬프트 위에 덧붙여집니다. NUL 문자를 포함할 수 없고 256 KiB를 넘을 수 없습니다.',
    zh: '针对该任务的系统提示（角色、质量标准、输出格式），叠加在内置的 worker 基础提示之上。不能含 NUL 字符，最大 256 KiB。',
  },
  ultrathink: {
    en: 'Escalate that worker to maximum reasoning depth. For contract-critical implementation, subtle debugging and adversarial reviews. `true` or `false` only; any other value is refused.',
    ko: '해당 워커를 최대 추론 깊이로 올립니다. 계약의 핵심이 되는 구현, 까다로운 디버깅, 적대적 리뷰에 사용합니다. `true` 또는 `false`만 받으며 다른 값은 거부됩니다.',
    zh: '把该 worker 提升到最大推理深度。用于契约关键的实现、棘手的调试和对抗式评审。只接受 `true` 或 `false`，其他值会被拒绝。',
  },
  timeout_minutes: {
    en: 'Wall-clock limit for this one dispatch, 1–480 minutes; a value outside that range is clamped to it. Overrides the `workerTimeoutMinutes` setting.',
    ko: '이 디스패치 하나에 적용되는 실행 시간 제한으로, 1–480분입니다. 범위를 벗어난 값은 이 범위로 조정됩니다. `workerTimeoutMinutes` 설정보다 우선합니다.',
    zh: '仅针对这一次分发的运行时长上限，1–480 分钟；超出范围的值会被调整到该范围内。优先于 `workerTimeoutMinutes` 设置。',
  },
  detach: {
    en: 'A background supervisor owns the task, so it keeps running and records its result even if your session ends. Always a one-shot worker. `true` or `false` only; any other value is refused.',
    ko: '백그라운드 수퍼바이저가 작업을 맡아, 세션이 끝나도 계속 실행되고 결과를 기록합니다. 항상 일회성 워커로 실행됩니다. `true` 또는 `false`만 받으며 다른 값은 거부됩니다.',
    zh: '由后台监督进程接管任务，即使你的会话结束，它也会继续运行并记录结果。始终以一次性 worker 运行。只接受 `true` 或 `false`，其他值会被拒绝。',
  },
};

// ---- read the code --------------------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const errors = [];

function parse(rel) {
  const text = fs.readFileSync(path.join(repo, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function findConst(sf, name) {
  let found;
  (function visit(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) found = n.initializer;
    if (!found) ts.forEachChild(n, visit);
  })(sf);
  if (!found) errors.push(`const ${name} not found in ${sf.fileName}`);
  return found;
}
const unwrap = (n) => (n && (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isParenthesizedExpression(n)) ? unwrap(n.expression) : n);
const propName = (p) => (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : p.name.getText());
function prop(obj, name) {
  const o = unwrap(obj);
  if (!o || !ts.isObjectLiteralExpression(o)) return undefined;
  const p = o.properties.find((q) => ts.isPropertyAssignment(q) && propName(q) === name);
  return p ? unwrap(p.initializer) : undefined;
}
const str = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined);

const serverSf = parse('src/mcp/server.ts');
const contractSf = parse('src/mesh/contract.ts');
const taskProps = unwrap(findConst(serverSf, 'TASK_PROPERTIES'));
const consts = { TASK_PROPERTIES: taskProps };
/** [{name, type, required}] for a schema `properties` node (identifier → the named const). */
function schemaProps(propertiesNode, requiredNode) {
  let node = unwrap(propertiesNode);
  if (node && ts.isIdentifier(node)) node = consts[node.text];
  if (!node || !ts.isObjectLiteralExpression(node)) return [];
  const required = new Set(
    requiredNode && ts.isArrayLiteralExpression(unwrap(requiredNode)) ? unwrap(requiredNode).elements.map((e) => str(e)) : [],
  );
  return node.properties.filter(ts.isPropertyAssignment).map((p) => {
    const def = unwrap(p.initializer);
    const type = str(prop(def, 'type'));
    const items = prop(def, 'items');
    return {
      name: propName(p),
      type,
      itemsProps: type === 'array' && items ? schemaProps(prop(items, 'properties'), prop(items, 'required')) : [],
      itemsType: items ? str(prop(items, 'type')) : undefined,
      itemsRef: items && prop(items, 'properties') && ts.isIdentifier(unwrap(prop(items, 'properties'))) ? unwrap(prop(items, 'properties')).text : undefined,
      required: required.has(propName(p)),
    };
  });
}
function toolsOf(arrayNode) {
  const out = [];
  const arr = unwrap(arrayNode);
  if (!arr || !ts.isArrayLiteralExpression(arr)) return out;
  for (const el of arr.elements) {
    if (ts.isSpreadElement(el)) {
      const ref = el.expression.getText();
      if (ref !== 'MESH_TOOLS') errors.push(`unexpected spread ${ref} in TOOLS`);
      out.push(...toolsOf(findConst(contractSf, 'MESH_TOOLS')));
      continue;
    }
    const name = str(prop(el, 'name'));
    const schema = prop(el, 'inputSchema');
    if (!name) {
      errors.push('a tool definition without a literal name');
      continue;
    }
    out.push({ name, args: schemaProps(prop(schema, 'properties'), prop(schema, 'required')) });
  }
  return out;
}
const tools = toolsOf(findConst(serverSf, 'TOOLS'));
const taskArgs = schemaProps(taskProps, undefined);
// `required` for a task comes from the dispatch_task schema.
const single = tools.find((t) => t.name === 'dispatch_task');
const requiredTaskArgs = new Set((single ? single.args : []).filter((a) => a.required).map((a) => a.name));

for (const t of tools) if (!TOOL_PURPOSE[t.name]) errors.push(`tool ${t.name} has no purpose text`);
for (const n of Object.keys(TOOL_PURPOSE)) if (!tools.some((t) => t.name === n)) errors.push(`purpose text for a tool the server does not define: ${n}`);
for (const a of taskArgs) if (!PARAM_MEANING[a.name]) errors.push(`dispatch argument ${a.name} has no meaning text`);
for (const n of Object.keys(PARAM_MEANING)) if (!taskArgs.some((a) => a.name === n)) errors.push(`meaning text for an argument the server does not define: ${n}`);

// The range of every setting is the manifest's (`minimum` / `maximum`). For a setting whose
// range the code also enforces by clamping, the clamp is read from its constants and must agree
// with the manifest: a disagreement, or a manifest that declares no range for it, fails the run.
const workerManagerText = fs.readFileSync(path.join(repo, 'src/workerManager.ts'), 'utf8');
const constNumber = (name) => {
  const m = new RegExp(`const ${name}\\s*=\\s*(\\d+)`).exec(workerManagerText);
  if (!m) errors.push(`constant ${name} not found in src/workerManager.ts`);
  return m ? Number(m[1]) : undefined;
};
const SOURCE_RANGES = {
  'claudeCodeOrchestrator.quotaCooldownMinutes': [constNumber('COOLDOWN_MINUTES_MIN'), constNumber('COOLDOWN_MINUTES_MAX')],
};

// ---- render -----------------------------------------------------------------------------------
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const code = (s) => '`' + s + '`';
const fmt = (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[Number(i)]);

function render(lang) {
  const t = T[lang];
  const nls = JSON.parse(fs.readFileSync(path.join(repo, LANGS[lang].nls), 'utf8'));
  const res = (v) => {
    const m = typeof v === 'string' && /^%([^%]+)%$/.exec(v);
    if (!m) return v;
    if (!(m[1] in nls)) errors.push(`${LANGS[lang].nls} lacks ${m[1]}`);
    return nls[m[1]];
  };
  const typeName = (ty) => ({ string: t.tString, number: t.tNumber, integer: t.tInteger, boolean: t.tBoolean, array: t.tArray })[ty] || ty;

  // settings
  const props = pkg.contributes.configuration.properties;
  const settings = [`| ${t.setting} | ${t.type} | ${t.def} | ${t.allowed} | ${t.desc} |`, '|---|---|---|---|---|'];
  for (const [key, p] of Object.entries(props)) {
    const fromCode = SOURCE_RANGES[key];
    if (fromCode && (p.minimum !== fromCode[0] || p.maximum !== fromCode[1])) {
      errors.push(`${key}: package.json declares ${p.minimum}–${p.maximum} but the code enforces ${fromCode[0]}–${fromCode[1]}`);
    }
    const lo = p.minimum;
    const hi = p.maximum;
    const allowed = p.enum
      ? p.enum.map(code).join(', ')
      : lo !== undefined || hi !== undefined
        ? `${lo !== undefined ? code(String(lo)) : '…'}–${hi !== undefined ? code(String(hi)) : '…'}`
        : '—';
    settings.push(`| ${code(key)} | ${typeName(p.type)} | ${code(JSON.stringify(p.default))} | ${allowed} | ${cell(res(p.description))} |`);
  }

  // commands
  const menus = pkg.contributes.menus || {};
  const hidden = new Set((menus.commandPalette || []).filter((m) => m.when === 'false').map((m) => m.command));
  const viewName = {};
  for (const list of Object.values(pkg.contributes.views || {})) for (const v of list) viewName[v.id] = res(v.name);
  const viewOf = (when) => {
    const m = /view == ([\w.]+)/.exec(when || '');
    return m ? viewName[m[1]] || m[1] : undefined;
  };
  const commands = [`| ${t.command} | ${t.id} | ${t.where} |`, '|---|---|---|'];
  for (const c of pkg.contributes.commands) {
    const where = [];
    if (!hidden.has(c.command)) where.push(t.palette);
    const add = (list, tpl) => {
      for (const m of list || []) {
        if (m.command !== c.command) continue;
        const v = viewOf(m.when);
        const text = v ? fmt(tpl, v) : undefined;
        if (text && !where.includes(text)) where.push(text);
      }
    };
    add(menus['view/title'], t.viewTitle);
    add(menus['view/item/context'], t.viewItem);
    commands.push(`| ${cell(res(c.title))} | ${code(c.command)} | ${where.length ? where.join(' · ') : t.internal} |`);
  }

  // tools
  const argList = (args) =>
    args.length === 0
      ? t.none
      : args
          .map((a) => {
            const label = code(a.name + (a.type === 'array' ? '[]' : '')) + (a.required ? ` (${t.required})` : '');
            return a.itemsRef === 'TASK_PROPERTIES' ? `${label} — ${t.each}` : label;
          })
          .join(', ');
  const toolRows = [`| ${t.tool} | ${t.args} | ${t.purpose} |`, '|---|---|---|'];
  for (const tool of tools) toolRows.push(`| ${code(tool.name)} | ${argList(tool.args)} | ${cell((TOOL_PURPOSE[tool.name] || {})[lang] || '')} |`);

  // dispatch params
  const params = [`| ${t.arg} | ${t.argType} | ${t.meaning} |`, '|---|---|---|'];
  for (const a of taskArgs) {
    params.push(`| ${code(a.name)}${requiredTaskArgs.has(a.name) ? ` (${t.required})` : ''} | ${typeName(a.type)} | ${cell((PARAM_MEANING[a.name] || {})[lang] || '')} |`);
  }
  return { settings: settings.join('\n'), commands: commands.join('\n'), tools: toolRows.join('\n'), params: params.join('\n') };
}

const SOURCE_NOTE = {
  settings: 'from package.json + package.nls',
  commands: 'from package.json + package.nls',
  tools: 'tool and argument names from src/mcp/server.ts + src/mesh/contract.ts',
  params: 'argument names from TASK_PROPERTIES in src/mcp/server.ts',
};
const begin = (name) => `<!-- BEGIN GENERATED:${name} (${SOURCE_NOTE[name]} — do not edit by hand) -->`;
const end = (name) => `<!-- END GENERATED:${name} -->`;
const blockRe = (name) => new RegExp(`<!-- BEGIN GENERATED:${name}[^>]*-->[\\s\\S]*?<!-- END GENERATED:${name} -->`);

let stale = 0;
for (const lang of Object.keys(LANGS)) {
  const blocks = render(lang);
  if (mode === 'print') {
    if (printLang === lang) for (const [n, b] of Object.entries(blocks)) console.log(`${begin(n)}\n${b}\n${end(n)}\n`);
    continue;
  }
  const file = path.join(repo, LANGS[lang].readme);
  let text = fs.readFileSync(file, 'utf8');
  for (const [name, body] of Object.entries(blocks)) {
    const want = `${begin(name)}\n${body}\n${end(name)}`;
    const m = blockRe(name).exec(text);
    if (!m) {
      errors.push(`${LANGS[lang].readme}: no GENERATED:${name} block`);
      continue;
    }
    if (m[0] !== want) {
      stale++;
      if (mode === 'write') text = text.replace(blockRe(name), () => want);
      else console.log(`STALE ${LANGS[lang].readme}: ${name}`);
    }
  }
  if (mode === 'write') fs.writeFileSync(file, text);
}
console.log(
  `tools: ${tools.map((t) => t.name).join(', ')}\ndispatch arguments: ${taskArgs.map((a) => a.name).join(', ')}\n` +
    `settings: ${Object.keys(pkg.contributes.configuration.properties).length}, commands: ${pkg.contributes.commands.length}`,
);
for (const e of [...new Set(errors)]) console.log('ERROR ' + e);
if (mode === 'write') console.log(`blocks rewritten: ${stale}`);
if (mode === 'check') console.log(stale ? `${stale} stale block(s)` : 'all generated blocks are current');
process.exit(errors.length || (mode === 'check' && stale) ? 1 : 0);
