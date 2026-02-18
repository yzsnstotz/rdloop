const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Import the class directly to test independently
const { TokenBucket } = require('../../openclaw/rate_limiter');

describe('TokenBucket', () => {
  it('allows requests up to rate limit', () => {
    const bucket = new TokenBucket(3);
    assert.equal(bucket.consume(), true);
    assert.equal(bucket.consume(), true);
    assert.equal(bucket.consume(), true);
    assert.equal(bucket.consume(), false); // exhausted
  });

  it('refills tokens over time', () => {
    const bucket = new TokenBucket(2);
    bucket.consume();
    bucket.consume();
    assert.equal(bucket.consume(), false);

    // Simulate time passing (1 minute)
    bucket.lastRefill = Date.now() - 60000;
    assert.equal(bucket.consume(), true); // should have refilled
  });

  it('does not exceed max tokens', () => {
    const bucket = new TokenBucket(3);
    // Simulate lots of time passing
    bucket.lastRefill = Date.now() - 600000;
    bucket._refill();
    // Should cap at 3
    assert.ok(bucket.tokens <= 3);
  });

  it('fractional refill works', () => {
    const bucket = new TokenBucket(6); // 6/min = 0.1/sec
    bucket.tokens = 0;
    // Simulate 30 seconds = 3 tokens
    bucket.lastRefill = Date.now() - 30000;
    bucket._refill();
    assert.ok(bucket.tokens >= 2.9 && bucket.tokens <= 3.1);
  });
});
