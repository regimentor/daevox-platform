// Run against an explicitly loaded preset; never loads or switches a model.
import OpenAI from 'openai';
import assert from 'node:assert/strict';
const baseURL = process.env.CORE_VALIDATION_URL;
const model = process.env.CORE_VALIDATION_MODEL;
assert(baseURL && model, 'Set CORE_VALIDATION_URL ending in /v1 and CORE_VALIDATION_MODEL');
const client = new OpenAI({ baseURL, apiKey: 'local', timeout: 180_000, maxRetries: 0 });
assert.deepEqual(
  (await client.models.list()).data.map((item) => item.id),
  [model],
);
const schema = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string', enum: ['p1'] }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};
const answer = await client.chat.completions.create({
  model,
  messages: [
    { role: 'user', content: 'Translate phrase p1 "Hello" to Russian. Return one translation.' },
  ],
  temperature: 0,
  max_tokens: 128,
  chat_template_kwargs: { enable_thinking: false },
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'translations', strict: true, schema },
  },
});
assert.equal(answer.object, 'chat.completion');
assert(answer.id);
assert(answer.usage);
const parsed = JSON.parse(answer.choices[0].message.content);
assert(Array.isArray(parsed.translations));
assert(parsed.translations.every((item) => item.id === 'p1' && typeof item.text === 'string'));
let chunks = 0;
for await (const chunk of await client.chat.completions.create({
  model,
  messages: [{ role: 'user', content: 'Say hello.' }],
  stream: true,
  max_tokens: 16,
})) {
  assert.equal(chunk.object, 'chat.completion.chunk');
  chunks++;
}
assert(chunks > 0);
await assert.rejects(
  client.chat.completions.create({
    model: 'unavailable-preset',
    messages: [{ role: 'user', content: 'hello' }],
  }),
  (error) => error.status === 409 && error.code === 'preset_not_active',
);
console.log(
  JSON.stringify(
    {
      baseURL,
      model,
      sdk: 'OpenAI JS',
      strict_media_schema: 'passed',
      stream_chunks: chunks,
      error_fields: 'passed',
      usage: answer.usage,
      result: parsed,
    },
    null,
    2,
  ),
);
