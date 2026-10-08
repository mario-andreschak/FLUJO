'use strict';

const { TestEnvironment } = require('jest-environment-node');
const { resolveEnduranceDataRoot } = require('./endurance-data-root.cjs');

module.exports = class GoalEnduranceEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    this.global.__personaGoalEnduranceDataRoot = resolveEnduranceDataRoot(process.env);
    if (process.env.PERSONA_GOAL_ENDURANCE_MODE === 'live') {
      this.global.__personaGoalEnduranceNativeCodex = (await import('@openai/codex-sdk')).Codex;
    }
  }
};
