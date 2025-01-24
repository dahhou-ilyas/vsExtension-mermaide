export async function generateMistralResponse(prompt) {
  const { HfInference } = await import('@huggingface/inference');
  const hf = new HfInference(process.env.HUGGINGFACE_TOKEN);

  try {
    const result = await hf.textGeneration({
      model: 'mistralai/Mistral-7B-Instruct-v0.2',
      inputs: prompt,
      parameters: {
        max_new_tokens: 250,
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