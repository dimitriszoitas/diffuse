export const AI_PROVIDERS = Object.freeze(['anthropic', 'openai']);
export const DEFAULT_OPENAI_MODEL = 'gpt-6.1-sol';
export const normalizeAIProvider = value => value === 'openai' ? 'openai' : 'anthropic';
export const aiProviderName = value => value === 'openai' ? 'OpenAI' : 'Anthropic';
export const aiProviderOrigin = value => value === 'openai' ? 'https://api.openai.com/*' : 'https://api.anthropic.com/*';
export const aiManagedModel = value => value === 'openai' ? DEFAULT_OPENAI_MODEL : 'claude-opus-5-5';
export const aiModelLabel = value => ({'gpt-6.1-sol':'GPT-6.1 Sol','claude-opus-5-5':'Claude Opus 5.5','claude-fable-5':'Claude Fable 5'}[value] || value || 'Configured model');
