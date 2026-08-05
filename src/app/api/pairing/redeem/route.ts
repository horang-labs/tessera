import { NextRequest, NextResponse } from 'next/server';
export async function POST(_request: NextRequest) {
  return NextResponse.json(
    {
      error: 'Pairing now requires approval in the Tessera app',
      code: 'pairing-approval-required',
    },
    { status: 410 },
  );
}
