import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  isGoogleOAuthConfigured,
  type GoogleProfile,
} from "@/lib/auth";

export async function GET() {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  let user: GoogleProfile | null = null;
  if (raw) {
    try {
      user = JSON.parse(raw) as GoogleProfile;
    } catch {
      user = null;
    }
  }
  return NextResponse.json({ user, googleEnabled: isGoogleOAuthConfigured() });
}
