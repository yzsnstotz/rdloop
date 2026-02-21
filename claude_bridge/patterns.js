const PERMISSION_PATTERNS = [
  {
    name: 'allow_tool',
    trigger: /(?:Allow|allow)\s+(?:this\s+)?(?:tool|action|command)?\s*\?\s*[\[(]/,
    choiceExtract: /[\[(]([^)\]]+)[\])]\s*$/
  },
  {
    name: 'want_to_allow',
    trigger: /Do you want to allow/i,
    choiceExtract: /[\[(]([^)\]]+)[\])]\s*$/
  },
  {
    name: 'permission_requested',
    trigger: /Permission requested/i,
    choiceExtract: /[\[(]([^)\]]+)[\])]\s*$/
  },
  {
    name: 'wants_to_run',
    trigger: /wants?\s+to\s+(?:run|execute|edit|write|read|delete|create)/i,
    choiceExtract: /[\[(]([^)\]]+)[\])]\s*$/
  },
  {
    name: 'approve_deny',
    trigger: /(?:approve|deny|allow|reject)\s*[\[(]|[\[(]\s*(?:approve|deny|allow|reject)/i,
    choiceExtract: /[\[(]([^)\]]+)[\])]\s*$/
  },
  {
    name: 'needs_approval',
    trigger: /(?:needs?\s+(?:your\s+)?approval|waiting\s+for\s+(?:your\s+)?(?:approval|confirmation|consent))/i,
    choiceExtract: /[\[(]([^)\]]+)[\])]\s*$/
  }
];

const USAGE_LIMIT_PATTERNS = [
  {
    name: 'usage_limit',
    trigger: /(?:usage|rate)\s+limit/i,
    timeExtract: /(?:try again|resets?|available)\s+(?:at|after|in)\s+(.+?)(?:\.|$)/i
  },
  {
    name: 'try_again',
    trigger: /try again (?:at|after|in)/i,
    timeExtract: /try again (?:at|after|in)\s+(.+?)(?:\.|$)/i
  },
  {
    name: 'resets_at',
    trigger: /resets?\s+at/i,
    timeExtract: /resets?\s+at\s+(.+?)(?:\.|$)/i
  },
  {
    name: 'too_many_requests',
    trigger: /too many requests/i,
    timeExtract: /(?:retry|wait|after)\s+(.+?)(?:\.|$)/i
  },
  {
    name: 'quota_exceeded',
    trigger: /(?:quota|credits?)\s+(?:exceeded|exhausted|depleted)/i,
    timeExtract: /(?:try again|resets?|available|renew)\s+(?:at|after|in|on)\s+(.+?)(?:\.|$)/i
  },
  {
    name: 'wait_minutes',
    trigger: /(?:wait|retry)\s+(?:\d+\s+)?(?:minutes?|seconds?|hours?)/i,
    timeExtract: /(?:wait|retry)\s+((?:\d+\s+)?(?:minutes?|seconds?|hours?))/i
  }
];

const DEFAULT_CHOICES = ['y', 'n'];
const DEFAULT_CHOICE_LABELS = ['Approve', 'Reject'];

function parseChoices(raw) {
  if (!raw) return { choices: DEFAULT_CHOICES, labels: DEFAULT_CHOICE_LABELS };
  const parts = raw.split('/').map(s => s.trim().toLowerCase());
  const labels = parts.map(p => {
    if (p === 'y' || p === 'yes') return 'Approve';
    if (p === 'n' || p === 'no') return 'Reject';
    if (p === 'a' || p === 'always' || p.includes('always')) return 'Always Allow';
    return p;
  });
  return { choices: parts, labels };
}

function detectPermissionPrompt(lineBuffer) {
  const text = lineBuffer.join('\n');
  for (const pat of PERMISSION_PATTERNS) {
    if (pat.trigger.test(text)) {
      const lastLine = lineBuffer[lineBuffer.length - 1] || '';
      const choiceMatch = pat.choiceExtract.exec(lastLine);
      const { choices, labels } = parseChoices(choiceMatch ? choiceMatch[1] : null);
      const promptLines = lineBuffer.slice(-5).filter(l => l.trim());
      return {
        matched: true,
        pattern: pat.name,
        prompt: promptLines.join('\n'),
        choices,
        choiceLabels: labels
      };
    }
  }
  return { matched: false };
}

function detectUsageLimit(lineBuffer) {
  const text = lineBuffer.join('\n');
  for (const pat of USAGE_LIMIT_PATTERNS) {
    if (pat.trigger.test(text)) {
      const timeMatch = pat.timeExtract ? pat.timeExtract.exec(text) : null;
      return {
        matched: true,
        pattern: pat.name,
        message: lineBuffer.slice(-5).filter(l => l.trim()).join('\n'),
        nextAvailable: timeMatch ? timeMatch[1].trim() : null
      };
    }
  }
  return { matched: false };
}

module.exports = {
  PERMISSION_PATTERNS,
  USAGE_LIMIT_PATTERNS,
  detectPermissionPrompt,
  detectUsageLimit,
  parseChoices
};
