import { NextRequest, NextResponse } from 'next/server';
import { requireAuthenticatedUserId } from '@/lib/auth/api-auth';
import logger from '@/lib/logger';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuthenticatedUserId(request);
    if ('response' in auth) {
      return auth.response;
    }

    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      return NextResponse.json(
        { error: `File too large (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB)` },
        { status: 413 },
      );
    }

    // Create a per-user temp directory to avoid collisions
    const uploadDir = join(tmpdir(), 'tessera-uploads', auth.userId);
    await mkdir(uploadDir, { recursive: true });

    // Preserve original filename with a UUID prefix to avoid conflicts
    const safeFileName = file.name.replace(/[/\\]/g, '_');
    const destPath = join(uploadDir, `${randomUUID()}_${safeFileName}`);

    const buffer = Buffer.from(await file.arrayBuffer());
    await writeFile(destPath, buffer);

    logger.info({ userId: auth.userId, fileName: file.name, size: file.size, path: destPath }, 'File uploaded');

    return NextResponse.json({ path: destPath, fileName: file.name });
  } catch (error) {
    logger.error({ error }, 'File upload failed');
    return NextResponse.json({ error: 'Upload failed' }, { status: 500 });
  }
}
