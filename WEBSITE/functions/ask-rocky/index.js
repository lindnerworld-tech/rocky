export async function onRequestPost(context) {
  const body = await context.request.json();

  return Response.json({
    answer: `Rocky heard: "${body.question}". The mountain is listening.`
  });
}