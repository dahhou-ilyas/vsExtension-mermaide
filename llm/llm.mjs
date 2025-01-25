import dotenv from 'dotenv';
import path from 'path';
const __dirname = path.dirname(new URL(import.meta.url).pathname);

dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { HfInference } from '@huggingface/inference';


async function generateMistralResponse(prompt) {
  const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);

  try {
    const result = await hf.textGeneration({
      model: 'openai-community/gpt2',
      inputs: prompt,
      parameters: {
        max_new_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9
      }
    });

    return result.generated_text;
  } catch (error) {
    console.error('Mistral Response Error:', error);
    return 'Failed to generate response';
  }
}
export { generateMistralResponse };
