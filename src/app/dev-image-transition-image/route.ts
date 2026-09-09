const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

export async function GET(): Promise<Response> {
  await new Promise((resolve) => setTimeout(resolve, 900));
  return new Response(PNG_1X1, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
}
