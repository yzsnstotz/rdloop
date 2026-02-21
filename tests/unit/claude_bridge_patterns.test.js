const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectPermissionPrompt, detectUsageLimit, parseChoices } = require('../../claude_bridge/patterns');

describe('parseChoices', () => {
  it('parses y/n', () => {
    const result = parseChoices('y/n');
    assert.deepStrictEqual(result.choices, ['y', 'n']);
    assert.deepStrictEqual(result.labels, ['Approve', 'Reject']);
  });

  it('parses y/n/a', () => {
    const result = parseChoices('y/n/a');
    assert.deepStrictEqual(result.choices, ['y', 'n', 'a']);
    assert.deepStrictEqual(result.labels, ['Approve', 'Reject', 'Always Allow']);
  });

  it('returns defaults for null input', () => {
    const result = parseChoices(null);
    assert.deepStrictEqual(result.choices, ['y', 'n']);
  });
});

describe('detectPermissionPrompt', () => {
  it('detects "Allow this tool? [y/n]"', () => {
    const lines = [
      '  Claude wants to run a bash command:',
      '    ls -la /etc/passwd',
      '  Allow this tool? [y/n]'
    ];
    const result = detectPermissionPrompt(lines);
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, 'allow_tool');
    assert.ok(result.choices.includes('y'));
    assert.ok(result.choices.includes('n'));
  });

  it('detects "Allow this action? [y/n/a]"', () => {
    const lines = [
      '  Edit file src/main.js',
      '  Allow this action? [y/n/a]'
    ];
    const result = detectPermissionPrompt(lines);
    assert.strictEqual(result.matched, true);
    assert.ok(result.choices.includes('a'));
  });

  it('detects "Do you want to allow"', () => {
    const lines = [
      '  Do you want to allow Claude to edit src/main.js? (y/n)'
    ];
    const result = detectPermissionPrompt(lines);
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, 'want_to_allow');
  });

  it('detects "wants to run"', () => {
    const lines = [
      '  Claude wants to run: bash(rm -rf /tmp/test)',
      '  (y/n)'
    ];
    const result = detectPermissionPrompt(lines);
    assert.strictEqual(result.matched, true);
  });

  it('detects "needs your approval"', () => {
    const lines = [
      '  Claude needs your approval to proceed.',
      '  [y/n]'
    ];
    const result = detectPermissionPrompt(lines);
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, 'needs_approval');
  });

  it('returns matched=false for normal output', () => {
    const lines = [
      'Building project...',
      'Compiling src/main.js',
      'Done.'
    ];
    const result = detectPermissionPrompt(lines);
    assert.strictEqual(result.matched, false);
  });
});

describe('detectUsageLimit', () => {
  it('detects "usage limit" with time', () => {
    const lines = [
      "You've reached your usage limit.",
      'Please try again after 2:00 PM PST.'
    ];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, true);
    assert.ok(result.nextAvailable);
    assert.ok(result.nextAvailable.includes('2:00 PM PST'));
  });

  it('detects "rate limit"', () => {
    const lines = ['Rate limit reached. Resets at 14:00 UTC.'];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, true);
    assert.ok(result.nextAvailable);
  });

  it('detects "try again at"', () => {
    const lines = ['Please try again at 3:00 PM.'];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, true);
  });

  it('detects "too many requests"', () => {
    const lines = ['Error: too many requests, please retry after 60 seconds.'];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, true);
  });

  it('detects "quota exceeded"', () => {
    const lines = ['Your API quota exceeded. Credits renew on March 1.'];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, 'quota_exceeded');
  });

  it('detects "wait 5 minutes"', () => {
    const lines = ['Please wait 5 minutes before retrying.'];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.pattern, 'wait_minutes');
    assert.ok(result.nextAvailable.includes('5 minutes'));
  });

  it('returns matched=false for normal output', () => {
    const lines = [
      'Running tests...',
      'All tests passed.',
      'Coverage: 95%'
    ];
    const result = detectUsageLimit(lines);
    assert.strictEqual(result.matched, false);
  });
});
