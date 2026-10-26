import { describe, it, expect } from 'vitest';
import { AgentConfigError, getAgentConfig, type AgentEnv } from './config';

const env = (overrides: Partial<AgentEnv> = {}): AgentEnv => ({
  AGENT_ENABLED: 'false',
  ANTHROPIC_API_KEY: '',
  VOYAGE_API_KEY: '',
  LANGSMITH_TRACING: 'false',
  LANGSMITH_API_KEY: '',
  LANGSMITH_PROJECT: 'aljo-store-agent',
  ...overrides,
});

const missingFor = (overrides: Partial<AgentEnv>) => {
  try {
    getAgentConfig(env(overrides));
  } catch (error) {
    if (error instanceof AgentConfigError) return error.missing;
    throw error;
  }
  return [];
};

describe('getAgentConfig', () => {
  it('needs nothing while the agent is disabled', () => {
    expect(getAgentConfig(env())).toMatchObject({ enabled: false, anthropicApiKey: '' });
  });

  it('treats only "true" (any case) as enabled', () => {
    expect(getAgentConfig(env({ AGENT_ENABLED: 'yes', LANGSMITH_TRACING: '1' }))).toMatchObject({
      enabled: false,
      tracing: { enabled: false },
    });
    expect(getAgentConfig(env({ AGENT_ENABLED: ' TRUE ', ANTHROPIC_API_KEY: 'k', VOYAGE_API_KEY: 'v' })).enabled).toBe(true);
  });

  it('returns the settings when enabled and complete', () => {
    const config = getAgentConfig(
      env({ AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'k', VOYAGE_API_KEY: 'v', LANGSMITH_TRACING: 'true', LANGSMITH_API_KEY: 'ls' }),
    );
    expect(config).toEqual({
      enabled: true,
      anthropicApiKey: 'k',
      voyageApiKey: 'v',
      tracing: { enabled: true, apiKey: 'ls', project: 'aljo-store-agent' },
    });
  });

  it('requires the Anthropic and Voyage keys when enabled', () => {
    expect(missingFor({ AGENT_ENABLED: 'true' })).toEqual(['ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']);
    expect(missingFor({ AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'k' })).toEqual(['VOYAGE_API_KEY']);
  });

  it('requires the LangSmith key only when tracing is on', () => {
    const keys = { AGENT_ENABLED: 'true', ANTHROPIC_API_KEY: 'k', VOYAGE_API_KEY: 'v' };
    expect(missingFor({ ...keys, LANGSMITH_TRACING: 'true' })).toEqual(['LANGSMITH_API_KEY']);
    expect(missingFor(keys)).toEqual([]);
  });

  it('reports every missing variable in one error', () => {
    expect(() => getAgentConfig(env({ AGENT_ENABLED: 'true', LANGSMITH_TRACING: 'true' }))).toThrow(
      'Missing: ANTHROPIC_API_KEY, VOYAGE_API_KEY, LANGSMITH_API_KEY',
    );
  });
});
