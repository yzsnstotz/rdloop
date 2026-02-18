const config = require('./config');

class TokenBucket {
  constructor(tokensPerMinute) {
    this.rate = tokensPerMinute;
    this.tokens = tokensPerMinute;
    this.lastRefill = Date.now();
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 60000; // minutes
    this.tokens = Math.min(this.rate, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  consume() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

const notifyBucket = new TokenBucket(config.RDLOOP_NOTIFY_RATE_LIMIT);
const writeBucket = new TokenBucket(config.RDLOOP_WRITE_RATE_LIMIT);

module.exports = {
  TokenBucket,
  canNotify() { return notifyBucket.consume(); },
  canWrite() { return writeBucket.consume(); }
};
