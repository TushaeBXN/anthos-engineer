// @ts-check
'use strict';

/** @param {{ github: import('@octokit/rest').Octokit, context: import('@actions/github').context, core: import('@actions/core') }} */
module.exports = async ({ github, context, core }) => {
  const body   = context.payload.pull_request.body || '';
  const prNum  = context.payload.pull_request.number;
  const MARKER = '<!-- pr-description-check-bot -->';
  const owner  = context.repo.owner;
  const repo   = context.repo.repo;

  function strip(text) {
    return (text ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  }

  function section(heading) {
    const m = body.match(new RegExp(`#+\\s+${heading}[\\s\\S]*?(?=\\n#+\\s+|$)`, 'i'));
    return strip(m?.[0].replace(new RegExp(`#+\\s+${heading}`, 'i'), '') ?? '');
  }

  const descriptionProblems = [];

  if (section('Summary').length < 20) {
    descriptionProblems.push('**Summary** is empty or too short — describe what changed and why.');
  }

  const linkedSection = section('Linked Issue');
  const hasIssueRef = /#\d+\b/.test(linkedSection) || /\/issues\/\d+/.test(linkedSection);

  if (!linkedSection) {
    descriptionProblems.push('**Linked Issue** — fill this section with an issue reference or `N/A` for maintainer work.');
  } else if (!hasIssueRef && !/^N\/A\b/i.test(linkedSection)) {
    descriptionProblems.push('**Linked Issue** — add a reference like `Fixes #NNN` or a bare `#NNN`.');
  }

  const typeBlock = body.match(/##\s+Type of Change[\s\S]*?(?=\n##\s|$)/i)?.[0] ?? '';
  if (!/- \[x\]/i.test(typeBlock)) {
    descriptionProblems.push('**Type of Change** — check at least one box.');
  }

  if (!/- \[x\] I searched/i.test(body)) {
    descriptionProblems.push('**Checklist** — check the duplicate-search box.');
  }

  const howTo = section('How to Test');
  if (howTo.length < 30) {
    descriptionProblems.push('**How to Test** — explain how a reviewer can verify this change.');
  }

  const changedFiles = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: prNum, per_page: 100,
  });
  const changedPaths = changedFiles.map(file => file.filename);

  function isRuntimeSensitivePath(filename) {
    const path = filename.toLowerCase();
    if (path.startsWith('tests/') || path.startsWith('.github/')) return false;
    return /^(?:cli\/|executor\/|policy\/|capability\/|llm\/|model\/|verify\/|diff\/)/.test(path)
      || /^(?:package\.json|package-lock\.json|tsconfig\.json|forge\.policy\.yaml)$/.test(path)
      || /\.(?:ts|js|mjs|cjs)$/.test(path);
  }

  function isDocsOnlyPath(filename) {
    const path = filename.toLowerCase();
    return /\.(?:md|mdx|rst|txt)$/.test(path) || path.startsWith('docs/');
  }

  let classification = 'tooling';
  if (changedPaths.some(isRuntimeSensitivePath)) {
    classification = 'runtime';
  } else if (changedPaths.length > 0 && changedPaths.every(isDocsOnlyPath)) {
    classification = 'docs-only';
  }

  const testsRan = /- \[x\]\s+I ran `npm test`/i.test(body);
  const typecheckRan = /- \[x\]\s+I ran `npx tsc --noEmit`/i.test(body);
  const evidenceGaps = [];

  if (classification === 'runtime') {
    if (!testsRan) {
      evidenceGaps.push('**Tests** — check the `npm test` box after running the test suite.');
    }
    if (!typecheckRan) {
      evidenceGaps.push('**Typecheck** — check the `npx tsc --noEmit` box after verifying no type errors.');
    }
  }

  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: prNum, per_page: 100,
  });
  const existing = comments.find(c => (c.body ?? '').includes(MARKER));

  if (descriptionProblems.length === 0 && evidenceGaps.length === 0) {
    if (existing) {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
    }
  } else {
    const commentLines = [MARKER];
    if (descriptionProblems.length > 0) {
      commentLines.push(
        '⚠️ **PR description — action needed**',
        '',
        'The following required sections are missing or incomplete:',
        '',
        descriptionProblems.map(p => `- ${p}`).join('\n'),
      );
    }
    if (evidenceGaps.length > 0) {
      commentLines.push(
        '',
        '**Validation evidence outstanding**',
        '',
        `Changed-file classification: **${classification}**.`,
        '',
        evidenceGaps.map(g => `- ${g}`).join('\n'),
      );
    }
    commentLines.push('', '---', '_This comment updates automatically._');
    const commentBody = commentLines.join('\n');

    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: commentBody });
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: prNum, body: commentBody });
    }
  }

  async function labelExists(name) {
    try { await github.rest.issues.getLabel({ owner, repo, name }); return true; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }

  async function setLabel(name, wanted) {
    if (wanted && await labelExists(name)) {
      await github.rest.issues.addLabels({ owner, repo, issue_number: prNum, labels: [name] }).catch(e => {
        if (e.status !== 403 && e.status !== 404) throw e;
      });
    } else if (!wanted) {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: prNum, name }).catch(e => {
        if (e.status !== 404 && e.status !== 410 && e.status !== 403) throw e;
      });
    }
  }

  const descriptionComplete = descriptionProblems.length === 0;
  const evidenceComplete = evidenceGaps.length === 0;
  const isDraft = Boolean(context.payload.pull_request.draft);
  await setLabel('ready for review', descriptionComplete && evidenceComplete && !isDraft);
  await setLabel('needs work', !descriptionComplete);

  if (!descriptionComplete) {
    core.setFailed(`PR description has ${descriptionProblems.length} issue(s) — see bot comment for details.`);
  }
};
