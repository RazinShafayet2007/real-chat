import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  SESSION_COOKIE,
  exchangeCodeForTokens,
  getGoogleProfile,
  isGoogleOAuthConfigured,
} from "@/lib/auth";
import { upsertUser } from "@/server/database";

export async function GET(request: Request) {
  if (!isGoogleOAuthConfigured()) {
    return NextResponse.json(
      { error: "Google OAuth not configured. Fill GOOGLE_* in .env." },
      { status: 503 }
    );
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ error: "Missing code" }, { status: 400 });
  }
  try {
    const { access_token } = await exchangeCodeForTokens(code);
    const google = await getGoogleProfile(access_token);
    let session = google;
    try {
      const saved = await upsertUser(google);
      session = { ...google, id: saved.id };
    } catch {
      // DB unavailable (empty .env) — still sign in with Google profile only.
    }
    const store = await cookies();
    store.set(SESSION_COOKIE, JSON.stringify(session), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return NextResponse.redirect(new URL("/", request.url));
  } catch {
    return NextResponse.json(
      { error: "Google sign-in failed" },
      { status: 502 }
    );
  }
}
