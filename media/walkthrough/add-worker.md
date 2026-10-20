# Add a worker account

A worker is another account that implements what your main session designs and
verifies. **Add Worker Account** starts by asking which CLI the account runs on.

## Claude Code — the usual choice

1. Pick a name (for example `w1`) and a default model: `opus`, `sonnet` or
   `fable`.
2. A separate config directory, `~/.claude-<name>`, is created for the account.
   Open the login terminal the extension offers and sign in **once** with the
   Claude account you want this worker to use.
3. Repeat for as many accounts as you have.

Already have `~/.claude-*` directories? **Import Existing Claude Config
Directories** registers them without a new login. It offers only a real
directory (never a symbolic link) that looks like a Claude Code config
directory, and asks for a name when the directory's own name does not fit the
name rule: letters, digits, `_` and `-`, at most 64 characters, and not
`main`.

## Codex, Cursor or Antigravity — opt-in workers

- The vendor's CLI (`codex`, `cursor-agent` or `agy`) must be installed and
  signed in.
- A task reaches such a worker only when a dispatch asks for it — with
  `provider`, or by naming the worker. It runs one-shot, edits the working tree
  in place, and cannot be attached to or steered.
- Codex can use the login already on this machine or a separate one. Cursor
  has one login per machine, so one worker. For Antigravity a separate login is
  not verified.
- For a separate Codex login in a new or empty folder, the extension asks where
  Codex keeps the sign-in: a token file in that folder (Codex's default; a
  plan-usage reading is available) or the system keychain (no plan-usage
  reading). The keychain option is designed to keep login detection and
  dispatch working, but a complete keychain login was not verified. For a
  folder that already holds anything, the question is not asked and nothing in
  it is changed.

## Later

- **Rename Worker Account** changes the label only; the directory and the
  login stay as they are.
- **Set Default Model** changes the model a dispatch gets when it names none.
- **Re-login Account** signs an account in again when its login has expired.
