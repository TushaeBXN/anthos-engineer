/**
 * Ready-made policies, written to forge.policy.yaml by `forge policy use <name>`.
 *
 * How rules work (see evaluator.ts and check.ts):
 *   - Rules are tried in order; the first that matches decides. So deny rules come first.
 *   - A rule with requires_approval asks the person. No matching rule: ask when
 *     default is deny, allow when default is allow.
 *   - File targets are relative inside the project ("src/a.ts", "." for the folder itself)
 *     and absolute outside it ("/Users/you/.ssh/id_ed25519"). "**" matches both, so
 *     "outside the project" rules ("/**") must come before "**".
 *   - Shell rules name a command prefix: a rule for "npm test" also covers "npm test -- --watch".
 *     A shell rule with operation "*" matches every command, so it can't be combined with
 *     allowed commands; use git rules for git.
 *   - Forge never writes forge.policy.yaml, .forge/ or .git/, whatever the policy says.
 */

export interface Preset {
  name: string;
  summary: string;
  yaml: string;
}

const HEADER = (name: string, about: string) => `# Forge policy: ${name}
# Made by \`forge policy use ${name}\`. Edit it freely; rules are tried in order and the first match decides.
# ${about}
# Rule reference: https://github.com/TushaeBXN/anthos-engineer#permissions
version: 1
`;

/** Credentials Forge should never touch, in any preset. Reading them would send them to the model. */
const SECRETS = `  # Never read or write credentials: reading them would send them to the model.
  - id: deny-ssh
    resource: filesystem
    operation: "*"
    target: "~/.ssh/**"
    effect: deny

  - id: deny-aws
    resource: filesystem
    operation: "*"
    target: "~/.aws/**"
    effect: deny

  - id: deny-gnupg
    resource: filesystem
    operation: "*"
    target: "~/.gnupg/**"
    effect: deny
`;

/** .env files in the project usually hold keys: ask before reading one. */
const ENV_FILES = `  # .env files usually hold keys: ask before reading one.
  - id: ask-env-files
    resource: filesystem
    operation: read
    target: "**/.env"
    effect: allow
    requires_approval: true

  - id: ask-env-variants
    resource: filesystem
    operation: read
    target: "**/.env.*"
    effect: allow
    requires_approval: true
`;

const GIT_READS = ["status", "diff", "log", "show", "rev-parse"]
  .map((op) => `  - id: allow-git-${op}\n    resource: git\n    operation: ${op}\n    target: "**"\n    effect: allow\n`)
  .join("\n");

const NO_FORCE_PUSH = `  # Never rewrite shared history.
  - id: deny-force-push
    resource: git
    operation: force-push
    target: "**"
    effect: deny
`;

export const PRESETS: Preset[] = [
  {
    name: "read-only",
    summary: "Reads the project; never writes files, runs commands or changes git. For exploring and reviewing code.",
    yaml: `${HEADER("read-only", "Forge reads this project's files. It can't write files, run shell commands or change git; anything else asks.")}default: deny

rules:
${SECRETS}
${ENV_FILES}
  # Files outside this project: ask.
  - id: ask-outside-project
    resource: filesystem
    operation: read
    target: "/**"
    effect: allow
    requires_approval: true

  - id: allow-project-reads
    resource: filesystem
    operation: read
    target: "**"
    effect: allow

  - id: deny-writes
    resource: filesystem
    operation: write
    target: "**"
    effect: deny

  # Git: look, don't touch.
${GIT_READS}
  - id: deny-other-git
    resource: git
    operation: "*"
    target: "**"
    effect: deny

  - id: deny-shell
    resource: shell
    operation: "*"
    target: "*"
    effect: deny

  # Web search, web fetch and MCP tools have no rule, so Forge asks.
`,
  },
  {
    name: "workspace-write",
    summary: "Reads and edits files in the project; asks before shell commands, commits, pushes, the web and anything outside the project. The everyday choice.",
    yaml: `${HEADER("workspace-write", "Forge reads and edits files in this project. It asks before shell commands, commits, pushes, web access, MCP tools and files outside the project.")}default: deny

rules:
${SECRETS}
${ENV_FILES}
  # Files outside this project: ask, for reading and writing.
  - id: ask-outside-project
    resource: filesystem
    operation: "*"
    target: "/**"
    effect: allow
    requires_approval: true

  - id: allow-project-reads
    resource: filesystem
    operation: read
    target: "**"
    effect: allow

  - id: allow-project-writes
    resource: filesystem
    operation: write
    target: "**"
    effect: allow

  # Git: look and stage freely; commit and push ask (no rule); never force-push or push to main.
${NO_FORCE_PUSH}
  - id: deny-push-main
    resource: git
    operation: push
    target: "main"
    effect: deny

  - id: deny-push-master
    resource: git
    operation: push
    target: "master"
    effect: deny

${GIT_READS}
  - id: allow-git-add
    resource: git
    operation: add
    target: "**"
    effect: allow

  # Shell commands have no rule, so each one asks. To stop asking for one, allow it, e.g.:
  #
  #   - id: allow-tests
  #     resource: shell
  #     operation: npm test
  #     target: "*"
  #     effect: allow
  #
  # Forge can edit package.json, so allowing "npm test" or "npm run" lets it run any script it writes.

  # Web search, web fetch and MCP tools have no rule, so Forge asks. To allow web search:
  #
  #   - id: allow-web-search
  #     resource: network
  #     operation: search
  #     target: duckduckgo.com
  #     effect: allow
`,
  },
  {
    name: "full-access",
    summary: "Does anything without asking, except touch credentials or force-push. Only for a throwaway machine or container.",
    yaml: `${HEADER("full-access", "Forge does anything without asking: edits, shell commands, git, web, MCP. Use it only where nothing can be lost.")}default: allow

rules:
${SECRETS}
${NO_FORCE_PUSH}
  # Everything else has no rule, and default: allow means it runs without asking.
`,
  },
];

export function preset(name: string): Preset | undefined {
  return PRESETS.find((p) => p.name === name);
}
