# Playbook: Security review

Use when the goal asks for a security audit, vulnerability check, or review of
risky code. This is READ-ONLY. Do not modify any files unless the goal
explicitly asks for fixes, and then only after the report is approved.

## 1. Define scope

State what you are reviewing: a file, a module, or a feature.
If the scope is "the whole repo", split it into units (one module or route
group at a time) and review each unit separately.

## 2. Run the deterministic tools first

Run whatever is available and record the output: `npm audit`, `semgrep`,
`gitleaks`, `eslint` with security rules. Treat tool findings as leads to
verify, not as final answers. Tools are the baseline; your reading adds to it.

## 3. Map the entry points and sensitive sinks

List, for the unit in scope:
- **Entry points:** HTTP handlers, CLI args, file reads, env vars, anything
  that accepts outside input.
- **Sinks:** shell/exec calls, SQL or other query building, file paths, `eval`
  or dynamic code, HTML output, outbound HTTP requests, deserialization.

Only the paths from an entry point to a sink matter. Follow each one.

## 4. Check each path against this list (one class at a time)

For each class, answer yes / no / not applicable. Do not skip a class.

- **Injection:** is untrusted input concatenated into a shell command, SQL
  query, or template? (`child_process.exec` with interpolation, string-built SQL)
- **Path traversal:** is untrusted input used in a file path without
  normalization and an allowed-directory check?
- **Authentication and authorization:** does every sensitive route verify who
  the caller is AND whether they may do this? Is any check missing or
  client-side only?
- **Secrets:** are keys, tokens, or passwords hard-coded, logged, or returned
  in responses or errors?
- **Input validation:** is input validated against a schema before use, or is
  it trusted as-is?
- **SSRF:** can the user control a URL the server fetches?
- **Unsafe deserialization / eval:** `JSON.parse` on trusted data only? Any
  `eval`, `new Function`, or dynamic `require` on input?
- **Cross-site scripting:** is untrusted data inserted into HTML without escaping?
- **Cryptography:** weak hashes for passwords (md5, sha1), `Math.random` for
  tokens, missing salts, hard-coded IVs.
- **Error handling:** do errors leak stack traces, paths, or internal details?
- **Dependencies:** does `npm audit` report known vulnerabilities in packages
  that are actually used?
- **Prototype pollution:** are objects merged from untrusted input without guards?

## 5. Prove every finding

A finding is only valid if you can give ALL of these:

- File path and line number
- The exact code, quoted
- The attack: how untrusted input reaches this code and what it does
- Why existing checks do not stop it

If you cannot supply all four, do not report it. Put it under
"Needs human review" instead and say what you could not confirm.

## 6. Check for false positives

Before reporting, ask for each finding:

- Is the input actually attacker-controlled, or only internal?
- Is there validation or escaping earlier in the path that you missed?
- Is this test code or a script that never runs in production?

Remove or downgrade anything that fails these checks.

## 7. Rate and report

Severity: `critical` / `high` / `medium` / `low`  
Confidence: `confirmed` / `likely` / `possible`

Be honest about confidence. "possible" is an acceptable answer.

Output exactly this format, one block per finding:

```
ID: SEC-001
Severity: <level>      Confidence: <level>
Class: <from the list above>
Location: <file>:<line>
Code: <quoted lines>
Attack: <how it is exploited>
Fix: <recommended change, not applied>
```

End with: **"Areas not reviewed"** (what was out of scope) and
**"Needs human review"** (unconfirmed leads).

## Stop conditions

- Scope is too large to review in one unit: split it, don't skim it
- You find a live secret: stop, report it immediately, do not print the full value
- You are asked to exploit the issue rather than describe it: decline
