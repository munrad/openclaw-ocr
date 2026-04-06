/**
 * lib/roundtable-templates.mjs — Preset templates for roundtable-create
 */

export const ROUNDTABLE_TEMPLATES = {
  architecture: {
    participants: ['planner', 'ai-researcher', 'coder', 'tester'],
    constraints: 'Конкретные решения, не абстрактные рекомендации',
  },
  incident: {
    participants: ['monitor', 'devops', 'coder', 'tester'],
    constraints: 'Root cause + fix + prevention',
  },
  feature: {
    participants: ['planner', 'coder', 'tester', 'reviewer'],
    constraints: 'Scope, risks, implementation plan',
  },
  documentation: {
    participants: ['writer', 'ai-researcher', 'fact-checker', 'reviewer'],
    constraints: 'Accuracy, completeness, readability',
  },
};
