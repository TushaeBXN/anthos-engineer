# Playbook: Bug fix

Use when the goal describes a defect: wrong output, a crash, a test failure,
or unexpected behavior. Follow this procedure in order. Do not skip steps to
go faster — the most common mistake is fixing the symptom rather than the cause.

## 1. Reproduce the bug before touching any code

Run the failing test or construct the smallest input that triggers the problem.
If you cannot reproduce it, stop and report: "Could not reproduce. Observed:
[what you saw]. Expected: [what the goal described]."

Do not guess at a fix for a bug you have not seen fail.

## 2. Locate the root cause

Read the stack trace or failure output carefully. Note:
- Which file and line the failure originates from (not just where it surfaces)
- What the value was vs. what it should have been
- Whether the bug is in the logic, the data, or the boundary between them

Use `forge query <name>` to find what calls the failing function and what it
depends on. The root cause is often one layer below the symptom.

## 3. Write or identify the regression test

Before fixing anything:
- If a test already fails: note it — that is your verification target.
- If no test exists: write one that fails now and will pass after a correct fix.
  A test that passes before the fix is not a regression test.

Commit the test separately if the codebase has a convention for it. Otherwise
include it in the fix commit.

## 4. Make the minimal fix

Change only what is needed to fix the root cause. Do not:
- Refactor surrounding code
- Add unrelated improvements
- Change test files except to add the regression test

If the fix requires changing more than 3 files, stop and confirm the scope with
the user before proceeding.

## 5. Run the verification chain

```
npx tsc --noEmit   # must pass
npm test           # all tests must pass, including the new regression test
```

If any stage fails, fix it before continuing. After 3 failed attempts to make
verification pass, stop and report what you tried and what still fails.

## 6. Review your own diff

Before committing, check:
- Does the diff contain only the files listed in your plan?
- Is there any debug logging, `console.log`, or commented-out code to remove?
- Does the regression test name clearly describe what it is testing?

## 7. Commit and report

Commit message format:
```
fix: <one-line description of what was wrong>

Root cause: <one sentence on why it happened>
```

Report: what the bug was, where the root cause lived, what the fix does, and
the name of the regression test that now covers it.

## Stop conditions

- Cannot reproduce the bug after reading the failure description carefully: stop and report
- Root cause spans more than 3 files: confirm scope before fixing
- Fix requires changing test assertions to make them pass (rather than fixing code): stop — you are probably masking the bug, not fixing it
- Verification fails after 3 attempts: stop and report
