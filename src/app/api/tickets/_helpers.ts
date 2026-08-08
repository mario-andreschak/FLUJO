import { NextResponse } from 'next/server';
export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });
