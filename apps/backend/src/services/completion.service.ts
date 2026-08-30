import OpenAI from 'openai';

class CompletionService {
  #client: OpenAI;

  constructor() {
    this.#client = new OpenAI({
      baseURL: 'http://192.168.31.245:1234/v1',
      apiKey: '123',
    });
  }

  async complete(prompt: string) {
    const response = await this.#client.responses.create({
      model: 'qwen/qwen3.8-27b',
      reasoning: {
        effort: 'low',
      },
      input: prompt,
    });

    return {
      responseId: response.id,
      response: response.output_text,
    };
  }
}

export const completionService = new CompletionService();
