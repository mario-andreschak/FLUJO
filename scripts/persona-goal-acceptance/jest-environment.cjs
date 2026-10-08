'use strict';

const { TestEnvironment } = require('jest-environment-node');

/** Jest transforms dynamic import to require, but the Codex SDK is import-only.
 * Load the genuine SDK through Node's native ESM loader outside the Jest VM.
 * The application adapter receives this exact constructor; provider execution,
 * tool bridging, CLI startup and authentication are never substituted. */
module.exports = class GoalAcceptanceEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    if (process.env.PERSONA_GOAL_ACCEPTANCE_MODE === 'live') {
      this.global.__personaGoalAcceptanceNativeCodex = (await import('@openai/codex-sdk')).Codex;
    }
  }
};
