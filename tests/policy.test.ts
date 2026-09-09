import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { evaluate, normalize } from "../policy/evaluator.js";
import type { ActionRequest, ForgePolicy } from "../policy/schema.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DENY_ALL: ForgePolicy = { version: 1, default: "deny", rules: [] };

const STANDARD_POLICY: ForgePolicy = {
  version: 1,
  default: "deny",
  rules: [
    // Hard deny SSH
    {
      id: "deny-ssh",
      resource: "filesystem",
      operation: "write",
      target: `${os.homedir()}/.ssh/**`,
      effect: "deny",
    },
    // Allow src/** writes
    {
      id: "allow-src",
      resource: "filesystem",
      operation: "write",
      target: "src/**",
      effect: "allow",
    },
    // git push requires approval
    {
      id: "approve-git-push",
      resource: "git",
      operation: "push",
      target: "**",
      effect: "allow",
      requiresApproval: true,
    },
  ],
};

function req(overrides: Partial<ActionRequest>): ActionRequest {
  return {
    resource: "filesystem",
    operation: "write",
    target: "src/index.ts",
    agentId: "test-agent",
    sessionId: "test-session",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("deny-by-default", () => {
  test("no rules → deny", () => {
    const result = evaluate(req({ target: "anything.ts" }), DENY_ALL);
    assert.equal(result.decision, "deny");
    assert.equal(result.matchedRuleId, null);
  });

  test("unmatched target → deny", () => {
    const result = evaluate(req({ target: "lib/utils.ts" }), STANDARD_POLICY);
    assert.equal(result.decision, "deny");
  });
});

describe("glob rule — allow src/**", () => {
  test("src/index.ts → allow", () => {
    const result = evaluate(req({ target: "src/index.ts" }), STANDARD_POLICY);
    assert.equal(result.decision, "allow");
    assert.equal(result.matchedRuleId, "allow-src");
  });

  test("src/deep/nested/file.ts → allow", () => {
    const result = evaluate(
      req({ target: "src/deep/nested/file.ts" }),
      STANDARD_POLICY,
    );
    assert.equal(result.decision, "allow");
  });

  test("lib/utils.ts → deny (not in src/)", () => {
    const result = evaluate(req({ target: "lib/utils.ts" }), STANDARD_POLICY);
    assert.equal(result.decision, "deny");
  });
});

describe("hard deny — ~/.ssh/**", () => {
  test("~/.ssh/id_rsa → deny even if a broader allow rule exists", () => {
    const policyWithBroadAllow: ForgePolicy = {
      version: 1,
      default: "deny",
      rules: [
        // SSH deny comes first — must win
        {
          id: "deny-ssh",
          resource: "filesystem",
          operation: "write",
          target: `${os.homedir()}/.ssh/**`,
          effect: "deny",
        },
        {
          id: "allow-all",
          resource: "filesystem",
          operation: "write",
          target: "**",
          effect: "allow",
        },
      ],
    };

    const result = evaluate(
      req({ target: `${os.homedir()}/.ssh/id_rsa` }),
      policyWithBroadAllow,
    );
    assert.equal(result.decision, "deny");
    assert.equal(result.matchedRuleId, "deny-ssh");
  });

  test("~/.ssh/config → deny", () => {
    const result = evaluate(
      req({ target: `${os.homedir()}/.ssh/config` }),
      STANDARD_POLICY,
    );
    assert.equal(result.decision, "deny");
  });
});

describe("requires_approval — git push", () => {
  test("git push → requires_approval", () => {
    const result = evaluate(
      req({ resource: "git", operation: "push", target: "origin main" }),
      STANDARD_POLICY,
    );
    assert.equal(result.decision, "requires_approval");
    assert.equal(result.matchedRuleId, "approve-git-push");
  });

  test("shell: git push → same decision path as git push (normalization)", () => {
    const shellPush = evaluate(
      req({
        resource: "shell",
        operation: "git push origin main",
        target: "",
      }),
      STANDARD_POLICY,
    );
    const gitPush = evaluate(
      req({ resource: "git", operation: "push", target: "origin main" }),
      STANDARD_POLICY,
    );
    // Both must reach the same decision
    assert.equal(shellPush.decision, gitPush.decision);
    assert.equal(shellPush.matchedRuleId, gitPush.matchedRuleId);
  });
});

describe("normalize", () => {
  test("shell: git push → resource=git, operation=push", () => {
    const normalized = normalize(
      req({ resource: "shell", operation: "git push origin main", target: "" }),
    );
    assert.equal(normalized.resource, "git");
    assert.equal(normalized.operation, "push");
    assert.equal(normalized.target, "origin main");
  });

  test("shell: git status → resource=git, operation=status", () => {
    const normalized = normalize(
      req({ resource: "shell", operation: "git status", target: "" }),
    );
    assert.equal(normalized.resource, "git");
    assert.equal(normalized.operation, "status");
  });

  test("non-git shell command passes through unchanged", () => {
    const normalized = normalize(
      req({ resource: "shell", operation: "npm test", target: "" }),
    );
    assert.equal(normalized.resource, "shell");
    assert.equal(normalized.operation, "npm test");
  });

  test("non-shell resource passes through unchanged", () => {
    const normalized = normalize(
      req({ resource: "filesystem", operation: "write", target: "src/a.ts" }),
    );
    assert.equal(normalized.resource, "filesystem");
  });
});
