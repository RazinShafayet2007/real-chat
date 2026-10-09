import { NextResponse } from "next/server";
import { getGoogleAuthUrl, isGoogleOAuthConfigured } from "@/lib/auth";

export async function GET() {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.json(
      { error: "Google OAuth not configured. Fill GOOGLE_* in .env." },
      { status: 503 }
    );
  }
  return NextResponse.redirect(getGoogleAuthUrl());
}
