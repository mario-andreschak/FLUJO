'use strict';

const { TestEnvironment } = require('jest-environment-node');

module.exports = class GoalEnduranceEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    if (process.env.PERSONA_GOAL_ENDURANCE_MODE === 'live') {
      this.global.__personaGoalEnduranceNativeCodex = (await import('@openai/codex-sdk')).Codex;
    }
  }
};
