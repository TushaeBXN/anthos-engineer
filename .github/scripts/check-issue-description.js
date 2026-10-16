// @ts-check
'use strict';

/** @param {{ github: import('@octokit/rest').Octokit, context: import('@actions/github').context, core: import('@actions/core') }} */
module.exports = async ({ github, context, core }) => {
  const issue  = context.payload.issue;
  const body   = (issue.body || '').trim();
  const labels = issue.labels.map(l => l.name);
  const owner  = context.repo.owner;
  const repo   = context.repo.repo;

  const isBug     = labels.includes('bug');
  const isFeature = labels.includes('enhancement');

  function section(heading) {
    const re = new RegExp(`#+\\s+${heading}\\s*([\\s\\S]*?)(?=\\n#+\\s+|$)`, 'i');
    const m  = body.match(re);
    return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';
  }

  const failures = [];

  if (body.length < 50) {
    failures.push('**Description** — body is empty or too short. Please use one of the provided templates.');
  }

  const type = isBug && isFeature ? 'conflict' : isBug ? 'bug' : isFeature ? 'feature' : 'untyped';

  switch (type) {
    case 'conflict':
      failures.push('**Labels** — an issue cannot be both `bug` and `enhancement`. Remove one.');
      break;

    case 'bug': {
      const revisionText = section('Forge Version');
      if (!revisionText || revisionText.length < 5) {
        failures.push('**Forge Version** — paste the output of `git show -s --abbrev=12 --format=\'%h (%cs)\' HEAD`.');
      }

      const stepsText = section('Steps to Reproduce');
      if (!stepsText || !/\d+\.|[-*]/.test(stepsText)) {
        failures.push('**Steps to Reproduce** — include at least one numbered or bulleted step.');
      }

      if (section('Expected Behaviour').length < 10) {
        failures.push('**Expected Behaviour** — section is empty or too short.');
      }

      if (section('Actual Behaviour').length < 10) {
        failures.push('**Actual Behaviour** — section is empty or too short.');
      }
      break;
    }

    case 'feature':
      if (section('Problem or Motivation').length < 20) {
        failures.push('**Problem or Motivation** — explain the concrete problem this solves.');
      }

      if (section('Proposed Solution').length < 20) {
        failures.push('**Proposed Solution** — describe the change you want to see.');
      }

      if (!section('Are you willing to implement this\\?')) {
        failures.push('**Are you willing to implement this?** — select an option.');
      }
      break;
  }

  const PLACEHOLDER = '-- Please Select --';
  const headingRe = /^#+\s+(.+?)\s*$/gm;
  const headings = [];
  let headingMatch;
  while ((headingMatch = headingRe.exec(body)) !== null) {
    headings.push({ name: headingMatch[1].trim(), headStart: headingMatch.index, contentStart: headingMatch.index + headingMatch[0].length });
  }
  const unfilled = [];
  for (let i = 0; i < headings.length; i++) {
    const end = i + 1 < headings.length ? headings[i + 1].headStart : body.length;
    if (body.slice(headings[i].contentStart, end).includes(PLACEHOLDER)) {
      unfilled.push(headings[i].name);
    }
  }
  if (unfilled.length > 0) {
    failures.push(`**Unfilled dropdowns** — choose a value; these still show the placeholder: ${unfilled.join(', ')}.`);
  }

  async function labelExists(name) {
    try { await github.rest.issues.getLabel({ owner, repo, name }); return true; }
    catch (e) { if (e.status === 404) return false; throw e; }
  }

  async function addLabel(name) {
    if (await labelExists(name)) {
      await github.rest.issues.addLabels({ owner, repo, issue_number: issue.number, labels: [name] });
    } else {
      core.warning(`Label "${name}" does not exist — skipping.`);
    }
  }

  async function dropLabel(name) {
    try { await github.rest.issues.removeLabel({ owner, repo, issue_number: issue.number, name }); }
    catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  }

  const LABEL_BAD  = 'needs more info';
  const LABEL_GOOD = 'ready for review';
  const MARKER = '<!-- issue-description-check -->';

  if (issue.state === 'closed') {
    await dropLabel(LABEL_GOOD);
    return;
  }

  const { data: comments } = await github.rest.issues.listComments({ owner, repo, issue_number: issue.number });
  const existing = comments.find(c => c.user.type === 'Bot' && c.body.includes(MARKER));

  if (failures.length === 0) {
    if (existing) {
      await github.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
    }
    await dropLabel(LABEL_BAD);
    await addLabel(LABEL_GOOD);
  } else {
    const commentBody = [
      MARKER,
      '⚠️ **Issue description is incomplete.** Please update the following sections:',
      '',
      failures.map(f => `- ${f}`).join('\n'),
      '',
      '_This comment is deleted automatically once all sections are complete._',
    ].join('\n');

    if (existing) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body: commentBody });
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: issue.number, body: commentBody });
    }

    await dropLabel(LABEL_GOOD);
    await addLabel(LABEL_BAD);
    core.setFailed(`Issue description has ${failures.length} issue(s) — see bot comment for details.`);
  }
};
