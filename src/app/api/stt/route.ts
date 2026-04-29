import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import { SettingsManager } from '@/lib/settings/manager';
import logger from '@/lib/logger';

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_AUDIO_SIZE_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(request: NextRequest) {
  try {
    // Auth check (same pattern as other API routes)
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    // Resolve API key: user settings > .env
    const userSettings = await SettingsManager.load(auth.userId);
    const apiKey = userSettings.geminiApiKey || process.env.GEMINI_API_KEY;

    if (!apiKey) {
      logger.error('GEMINI_API_KEY not configured');
      return NextResponse.json(
        { error: 'STT service is not configured (GEMINI_API_KEY required)' },
        { status: 503 },
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get('audio') as File | null;
    if (!audioFile) {
      return NextResponse.json({ error: 'Audio file is required' }, { status: 400 });
    }

    if (audioFile.size > MAX_AUDIO_SIZE_BYTES) {
      return NextResponse.json(
        { error: 'Audio file is too large (maximum 25MB)' },
        { status: 413 },
      );
    }

    // Convert audio to base64
    const arrayBuffer = await audioFile.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuffer).toString('base64');

    // Call Gemini API for transcription
    const geminiUrl = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                inline_data: {
                  mime_type: audioFile.type || 'audio/webm',
                  data: base64Audio,
                },
              },
              {
                text: 'Transcribe this audio accurately. Return only the transcribed text, nothing else. Preserve the original language.',
              },
            ],
          },
        ],
      }),
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      logger.error({ status: geminiResponse.status, error: errorText }, 'Gemini API error');
      return NextResponse.json(
        { error: 'Speech conversion failed' },
        { status: 502 },
      );
    }

    const result = await geminiResponse.json();
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return NextResponse.json({ text });
  } catch (error) {
    logger.error({ error }, 'POST /api/stt error');
    return NextResponse.json(
      { error: 'An error occurred during speech conversion' },
      { status: 500 },
    );
  }
}
