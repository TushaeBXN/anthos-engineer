import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import type { ForgePolicy, PolicyRule } from "./schema.js";

const POLICY_FILE = "forge.policy.yaml";

export function loadPolicy(policyPath?: string): ForgePolicy {
  const filePath = policyPath ?? path.join(process.cwd(), POLICY_FILE);

  if (!fs.existsSync(filePath)) {
    // Default: deny everything
    return { version: 1, default: "deny", rules: [] };
  }

  const raw = yaml.load(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;

  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid policy file: ${filePath}`);
  }

  const version = (raw["version"] as number) ?? 1;
  const defaultEffect = (raw["default"] as string) === "allow" ? "allow" : "deny";
  const rawRules = (raw["rules"] as unknown[]) ?? [];

  const rules: PolicyRule[] = rawRules.map((r, i) => {
    const rule = r as Record<string, unknown>;
    if (!rule["resource"] || !rule["operation"] || !rule["target"] || !rule["effect"]) {
      throw new Error(`Rule at index ${i} is missing required fields (resource, operation, target, effect)`);
    }
    return {
      id: (rule["id"] as string) ?? `rule-${i}`,
      resource: rule["resource"] as PolicyRule["resource"],
      operation: rule["operation"] as string,
      target: rule["target"] as string,
      effect: rule["effect"] as "allow" | "deny",
      requiresApproval: Boolean(rule["requires_approval"]),
    };
  });

  return { version, default: defaultEffect, rules };
}
