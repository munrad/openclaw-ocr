/**
 * lib/schema.mjs — Key schema, groups, ID generators, time helpers
 */
import { randomBytes } from 'node:crypto';

export const KEYS = {
  tasksStream:          'openclaw:tasks:stream',
  tasksPriority:        'openclaw:tasks:priority',
  taskResult:   (id)  => `openclaw:tasks:result:${id}`,
  agentStatus:  (id)  => `openclaw:agents:status:${id}`,
  heartbeat:    (id)  => `openclaw:heartbeat:${id}`,
  lockTask:     (id)  => `openclaw:locks:task:${id}`,
  lockRes:      (res) => `openclaw:locks:res:${res}`,
  eventsStream:         'openclaw:events:stream',
  circuitFile:          '/tmp/ocr-circuit.json',
  restartMessages:      'openclaw:restart:messages',
  INSIGHTS:             'openclaw:insights',
  INSIGHTS_PROMOTED:    'openclaw:insights:promoted',
  roundtable:   (id)  => `openclaw:roundtable:${id}`,
  roundtableRounds: (id) => `openclaw:roundtable:${id}:rounds`,
  lockBranch:   (branch) => `openclaw:locks:res:branch:${branch}`,
  feedbackLoop: (id)     => `openclaw:feedback-loop:${id}`,
  feedbackLoopsActive:    'openclaw:feedback-loops:active',
  pipeline:      (id)    => `openclaw:pipeline:${id}`,
  pipelinesActive:        'openclaw:pipelines:active',
  pipelineByTask: (taskId) => `openclaw:pipeline:by-task:${taskId}`,
  taskStatus:     (id)     => `openclaw:task-status:${id}`,
  taskStatusActive:         'openclaw:task-status:active',
  daemonHeartbeat: (name)  => `openclaw:daemon:heartbeat:${name}`,
  agentChildren:   (id)    => `openclaw:agent:${id}:children`,
  agentParent:     (id)    => `openclaw:agent:${id}:parent`,
  lifecycleRun:    (agentId, runId) => `openclaw:lifecycle:run:${agentId}:${runId}`,
  lifecycleRunsByAgent: (agentId)   => `openclaw:lifecycle:agent:${agentId}:runs`,
  lifecycleStopRequest: (agentId, runId) => `openclaw:lifecycle:stop:${agentId}:${runId}`,
};

export const GROUPS = {
  workers:  'openclaw-workers',
  watchers: 'openclaw-watchers',
};

export const KNOWN_AGENTS = [
  // Core agents (from openclaw.json)
  'nerey', 'coder', 'devops', 'tester', 'ai-researcher', 'flash',
  'health', 'fact-checker', 'writer', 'monitor', 'reviewer', 'teamlead',
  // Niche agents
  'database-optimizer', 'prompter', 'travel',
  // Proof-loop agents
  'task-spec-freezer', 'task-builder', 'task-verifier', 'task-fixer',
];

export const KNOWN_DAEMONS = ['task-status-watcher', 'lifecycle-daemon', 'status-watchdog'];

export function genTaskId() {
  const rand = randomBytes(2).toString('hex');
  return `t-${Date.now()}-${rand}`;
}

export function genInsightId() {
  const rand = randomBytes(2).toString('hex');
  return `i-${Date.now()}-${rand}`;
}

export function genRoundtableId() {
  const rand = randomBytes(2).toString('hex');
  return `rt-${Date.now()}-${rand}`;
}

export function genLoopId() {
  const rand = randomBytes(2).toString('hex');
  return `fl-${Date.now()}-${rand}`;
}

export function genPipelineId() {
  const rand = randomBytes(2).toString('hex');
  return `p-${Date.now()}-${rand}`;
}

export function now() {
  return String(Math.floor(Date.now() / 1000));
}
