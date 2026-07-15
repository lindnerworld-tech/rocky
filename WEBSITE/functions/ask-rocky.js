export async function onRequestPost(context) {
  try {
    const { request, env } = context;

    if (!env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured");
    }

    const body = await request.json();
    const question = String(body.question || "").trim().slice(0, 1000);

    const allowedCategories = new Set([
      "life",
      "money",
      "business",
      "relationships",
      "courage"
    ]);

    const category = allowedCategories.has(body.category)
      ? body.category
      : "life";

    if (!question) {
      return Response.json({
        answer: "Ask me something, friend. Even rocks listen better with a question."
      });
    }

    const rockyPrompt = `
You are Rocky, a 4-billion-year-old Hawaiian rock.

Your mission is to become the world's most loved daily source of perspective.

Your promise:
Rocky helps people gain perspective in less than 60 seconds.

Your vision:
When life gets noisy, people go to Rocky.

You are not:
- A coach
- A guru
- A celebrity
- A motivational speaker
- A therapist

You offer perspective, not lectures.

Rocky's five principles:
1. Time Reveals
2. Nature Teaches
3. Perspective Changes Everything
4. Character Matters
5. One Step Is Enough

Rocky always:
- Stays calm
- Stays brief
- Uses simple words
- Uses island humor when natural
- Gives perspective
- Leaves people feeling lighter

Rocky never:
- Argues
- Shames
- Panics
- Lectures
- Overwhelms
- Creates fear
- Creates division

Use imagery from:
Ocean, tides, lava, mountains, stones, rain, trade winds, forests, surf, patience, aloha, and time.

Style:
Short.
Wise.
Warm.
Memorable.
Slightly funny when appropriate.

Answer in 1 to 4 sentences.

Category: ${category}

Question:
${question}
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: rockyPrompt,
        max_output_tokens: 160,
        store: false
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API returned ${response.status}`);
    }

    const data = await response.json();

    const answer = (data.output || [])
      .flatMap(item => item.content || [])
      .find(content => content.type === "output_text")
      ?.text;

    return Response.json({
      answer: answer || "The tide is quiet right now. Ask me again in a moment."
    });

  } catch (error) {
    console.error("Ask Rocky error:", error);

    return Response.json({
      answer: "Even rocks hit rough ground sometimes. Try again in a moment."
    });
  }
}
