import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectStepUsage,
  usageAttributes,
} from '../../../assets/hooks/qoder-hook-processor.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../assets/hooks/qoder-hook-processor.mjs');
const FIXTURES = path.resolve(__dirname, '../../fixtures/qoder');
const SUBAGENT_ID = 'ageneral-purpose-0f1e2d3c4b5a6978';
const AGENT_CALL_ID = 'fc_agent0000000000000000000000000000000000000000000000000001';

const USAGE_KEYS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.total_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
];

let dataDir;
let transcriptPath;
let sessionDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-usage-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
  sessionDir = transcriptPath.replace(/\.jsonl$/, '');
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function runProcessor() {
  return spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({
      session_id: 'usage-session',
      transcript_path: transcriptPath,
      cwd: '/tmp/qoder-usage-project',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function readHistory() {
  const historyDir = path.join(dataDir, 'logs', 'qoder', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(historyDir, file), 'utf-8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function writeTranscript(rows) {
  fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function assistantRow({ uuid, second, id, content, stopReason, usage }) {
  const message = {
    id,
    role: 'assistant',
    model: 'ultimate',
    content,
    stop_reason: stopReason,
  };
  if (usage) message.usage = usage;
  return {
    type: 'assistant',
    sessionId: 'usage-session',
    uuid,
    timestamp: `2026-09-22T10:00:${String(second).padStart(2, '0')}.000Z`,
    message,
  };
}

/** One turn with a tool step and a terminal step, both carrying real usage. */
function writeTwoStepTurn({ firstUsage = true, terminalUsage = true } = {}) {
  writeTranscript([
    {
      type: 'session_meta', sessionId: 'usage-session', uuid: 'meta-1',
      timestamp: '2026-09-22T10:00:00.000Z',
      data: { meta_type: 'session_info', content: { mode: 'agent', session_type: 'assistant' } },
    },
    {
      type: 'progress', sessionId: 'usage-session', uuid: 'prog-1',
      timestamp: '2026-09-22T10:00:00.500Z',
      data: { hookEvent: 'UserPromptSubmit', hookName: 'loongsuite-pilot' },
    },
    {
      type: 'user', sessionId: 'usage-session', uuid: 'user-1',
      timestamp: '2026-09-22T10:00:01.000Z',
      entrypoint: 'cli', message: { role: 'user', content: 'list the files' },
    },
    assistantRow({
      uuid: 'asst-1', second: 2, id: 'resp_step1', stopReason: 'tool_use',
      ...(firstUsage ? {
        usage: {
          input_tokens: 1200,
          output_tokens: 30,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 100,
        },
      } : {}),
      content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } }],
    }),
    {
      type: 'user', sessionId: 'usage-session', uuid: 'result-1',
      timestamp: '2026-09-22T10:00:03.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a.txt' }],
      },
    },
    assistantRow({
      uuid: 'asst-2', second: 4, id: 'resp_step2', stopReason: 'end_turn',
      ...(terminalUsage ? {
        usage: {
          input_tokens: 1500,
          output_tokens: 50,
          cache_read_input_tokens: 900,
        },
      } : {}),
      content: [{ type: 'text', text: 'there is a.txt' }],
    }),
    {
      type: 'progress', sessionId: 'usage-session', uuid: 'prog-stop',
      timestamp: '2026-09-22T10:00:05.000Z',
      data: { command: '~/.qoder/hooks/stop.sh', hookEvent: 'Stop', hookName: 'Stop', type: 'hook_progress' },
    },
    { type: 'last-prompt', sessionId: 'usage-session', uuid: 'last-1', timestamp: '2026-09-22T10:00:06.000Z', lastPrompt: 'list the files' },
  ]);
}

function responsesOf(records) {
  return records.filter(r => r['event.name'] === 'llm.response');
}

function usageOf(record) {
  return Object.fromEntries(USAGE_KEYS.filter(key => key in record).map(key => [key, record[key]]));
}

/** Child transcript with usage on the terminal row of each provider call. */
function writeChildTranscript(withUsage) {
  const base = JSON.parse(fs.readFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', 'task-atask7c21d0e5b4f9a3c1.json'),
    'utf-8',
  ));
  const subagentsDir = path.join(sessionDir, 'subagents');
  fs.mkdirSync(subagentsDir, { recursive: true });
  const childPath = path.join(subagentsDir, `agent-${SUBAGENT_ID}.jsonl`);
  fs.writeFileSync(
    path.join(subagentsDir, `task-${base.taskId}.json`),
    JSON.stringify({
      ...base,
      agentId: SUBAGENT_ID,
      parentToolUseId: AGENT_CALL_ID,
      resolvedModel: 'Qwen3.8-Flash',
      transcriptPath: childPath,
    }),
  );

  const rows = fs.readFileSync(
    path.join(FIXTURES, 'subagent-session', 'subagents', `agent-${SUBAGENT_ID}.jsonl`),
    'utf-8',
  ).trim().split('\n').map(line => JSON.parse(line));
  if (withUsage) {
    for (const row of rows) {
      if (row.type !== 'assistant' || !row.message?.stop_reason) continue;
      const call = row.message.id.endsWith('1') ? 1 : 2;
      row.message.usage = {
        input_tokens: call === 1 ? 300 : 420,
        output_tokens: call === 1 ? 12 : 18,
        cache_read_input_tokens: call === 1 ? 200 : 260,
        ...(call === 1 ? { cache_creation_input_tokens: 40 } : {}),
      };
    }
  }
  fs.writeFileSync(childPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function writeParentTranscriptWithAgentCall() {
  writeTranscript([
    {
      type: 'session_meta', sessionId: 'usage-session', uuid: 'meta-1',
      timestamp: '2026-09-22T10:00:00.000Z',
      data: { meta_type: 'session_info', content: { mode: 'agent', session_type: 'assistant' } },
    },
    {
      type: 'user', sessionId: 'usage-session', uuid: 'user-1',
      timestamp: '2026-09-22T10:00:01.000Z',
      entrypoint: 'cli', message: { role: 'user', content: 'delegate the echo task' },
    },
    assistantRow({
      uuid: 'asst-agent', second: 2, id: 'resp_agent', stopReason: 'tool_use',
      usage: { input_tokens: 2000, output_tokens: 40, cache_read_input_tokens: 1000 },
      content: [{
        type: 'tool_use', id: AGENT_CALL_ID, name: 'Agent',
        input: { prompt: 'run echo hello', subagent_type: 'general-purpose', description: 'echo test' },
      }],
    }),
    {
      type: 'user', sessionId: 'usage-session', uuid: 'result-agent',
      timestamp: '2026-09-22T10:00:09.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: AGENT_CALL_ID, content: "Subagent completed: printed 'hello'" }],
      },
    },
    assistantRow({
      uuid: 'asst-final', second: 10, id: 'resp_final', stopReason: 'end_turn',
      usage: { input_tokens: 2500, output_tokens: 25, cache_read_input_tokens: 1200 },
      content: [{ type: 'text', text: 'The subagent has finished the task.' }],
    }),
    {
      type: 'progress', sessionId: 'usage-session', uuid: 'prog-stop',
      timestamp: '2026-09-22T10:00:11.000Z',
      data: { command: '~/.qoder/hooks/stop.sh', hookEvent: 'Stop', hookName: 'Stop', type: 'hook_progress' },
    },
    { type: 'last-prompt', sessionId: 'usage-session', uuid: 'last-1', timestamp: '2026-09-22T10:00:12.000Z', lastPrompt: 'delegate the echo task' },
  ]);
}

describe('qoder-hook-processor token usage', () => {
  it('writes provider usage onto each llm.response without counting cache twice', () => {
    writeTwoStepTurn();

    const result = runProcessor();
    expect(result.status, result.stderr).toBe(0);

    const responses = responsesOf(readHistory());
    expect(responses).toHaveLength(2);

    // input_tokens from qodercli is already the inclusive prompt size; the
    // cache counters are reported alongside it, not subtracted from it.
    expect(usageOf(responses[0])).toEqual({
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 30,
      'gen_ai.usage.total_tokens': 1230,
      'gen_ai.usage.cache_read.input_tokens': 800,
      'gen_ai.usage.cache_creation.input_tokens': 100,
    });
    expect(usageOf(responses[1])).toEqual({
      'gen_ai.usage.input_tokens': 1500,
      'gen_ai.usage.output_tokens': 50,
      'gen_ai.usage.total_tokens': 1550,
      'gen_ai.usage.cache_read.input_tokens': 900,
    });
    // No fabricated total_tokens: the transcript does not carry one.
    expect(responses[0]['gen_ai.usage.total_tokens'])
      .toBe(responses[0]['gen_ai.usage.input_tokens'] + responses[0]['gen_ai.usage.output_tokens']);
  });

  it('emits no usage attributes when the transcript has no usage', () => {
    writeTwoStepTurn({ firstUsage: false, terminalUsage: false });

    const result = runProcessor();
    expect(result.status, result.stderr).toBe(0);

    const responses = responsesOf(readHistory());
    expect(responses).toHaveLength(2);
    for (const response of responses) {
      for (const key of USAGE_KEYS) expect(response).not.toHaveProperty(key);
    }
  });

  it('omits usage only for the response whose transcript row carries none', () => {
    writeTwoStepTurn({ terminalUsage: false });

    expect(runProcessor().status).toBe(0);

    const responses = responsesOf(readHistory());
    expect(responses).toHaveLength(2);
    expect(responses[0]['gen_ai.usage.input_tokens']).toBe(1200);
    for (const key of USAGE_KEYS) expect(responses[1]).not.toHaveProperty(key);
  });

  it('keeps usage off llm.request records', () => {
    writeTwoStepTurn();

    expect(runProcessor().status).toBe(0);
    const records = readHistory();
    for (const request of records.filter(r => r['event.name'] === 'llm.request')) {
      for (const key of USAGE_KEYS) expect(request).not.toHaveProperty(key);
    }
  });

  it('writes subagent usage onto the child llm.response only', () => {
    writeParentTranscriptWithAgentCall();
    writeChildTranscript(true);

    const result = runProcessor();
    expect(result.status, result.stderr).toBe(0);

    const records = readHistory();
    const childResponses = responsesOf(records).filter(r => r['gen_ai.agent.scope'] === 'subagent');
    expect(childResponses).toHaveLength(2);

    expect(usageOf(childResponses[0])).toEqual({
      'gen_ai.usage.input_tokens': 300,
      'gen_ai.usage.output_tokens': 12,
      'gen_ai.usage.total_tokens': 312,
      'gen_ai.usage.cache_read.input_tokens': 200,
      'gen_ai.usage.cache_creation.input_tokens': 40,
    });
    expect(usageOf(childResponses[1])).toEqual({
      'gen_ai.usage.input_tokens': 420,
      'gen_ai.usage.output_tokens': 18,
      'gen_ai.usage.total_tokens': 438,
      'gen_ai.usage.cache_read.input_tokens': 260,
    });

    // Parent spans keep the parent transcript's numbers.
    const parentResponses = responsesOf(records).filter(r => r['gen_ai.agent.scope'] === undefined);
    expect(parentResponses).toHaveLength(2);
    expect(parentResponses[0]['gen_ai.usage.input_tokens']).toBe(2000);
    expect(parentResponses[1]['gen_ai.usage.input_tokens']).toBe(2500);
  });

  it('omits child usage when the child transcript carries none', () => {
    writeParentTranscriptWithAgentCall();
    writeChildTranscript(false);

    const result = runProcessor();
    expect(result.status, result.stderr).toBe(0);

    const childResponses = responsesOf(readHistory()).filter(r => r['gen_ai.agent.scope'] === 'subagent');
    expect(childResponses).toHaveLength(2);
    for (const response of childResponses) {
      for (const key of USAGE_KEYS) expect(response).not.toHaveProperty(key);
    }
  });
});

describe('collectStepUsage / usageAttributes', () => {
  it('normalises partial usage and derives total', () => {
    expect(collectStepUsage({ input_tokens: 10, output_tokens: 5 }))
      .toEqual({ input: 10, output: 5, cacheRead: undefined, cacheCreation: undefined });
    expect(usageAttributes({ input_tokens: 10, output_tokens: 5 })).toEqual({
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 5,
      'gen_ai.usage.total_tokens': 15,
    });
  });

  it('treats an input-only usage object as zero output rather than dropping it', () => {
    expect(usageAttributes({ input_tokens: 7 })).toEqual({
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.total_tokens': 7,
    });
  });

  it('ignores non-numeric, negative and missing counters', () => {
    expect(collectStepUsage(null)).toBeNull();
    expect(collectStepUsage({})).toBeNull();
    expect(collectStepUsage({ input_tokens: '12', output_tokens: -1, cache_read_input_tokens: NaN }))
      .toBeNull();
    expect(usageAttributes({ input_tokens: 3, cache_read_input_tokens: '200' })).toEqual({
      'gen_ai.usage.input_tokens': 3,
      'gen_ai.usage.output_tokens': 0,
      'gen_ai.usage.total_tokens': 3,
    });
  });
});
