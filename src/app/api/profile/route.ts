import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { renameUser, upsertUser } from "@/server/database";

/**
 * Real user profile endpoint (Future-works #2).
 * GET  -> current profile (OAuth cookie, or guest lookup by ?name=)
 * PATCH { name } -> rename/create profile, refresh cookie.
 * Works with empty .env via in-memory store; persists to Postgres
 * once DATABASE_URL is provided.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (raw) {
    try {
      const session = JSON.parse(raw);
      const profile = await upsertUser({
        name: session.name ?? "anon",
        email: session.email ?? null,
        picture: session.picture ?? null,
      });
      return NextResponse.json({ profile });
    } catch {
      // fall through to guest lookup
    }
  }
  const name = url.searchParams.get("name");
  if (!name) return NextResponse.json({ profile: null });
  try {
    const profile = await upsertUser({ name });
    return NextResponse.json({ profile });
  } catch {
    return NextResponse.json({ profile: null });
  }
}

export async function PATCH(request: Request) {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  let session: {
    id?: string;
    name?: string;
    email?: string;
    picture?: string;
  } | null = null;
  if (raw) {
    try {
      session = JSON.parse(raw);
    } catch {
      session = null;
    }
  }
  const body = await request.json().catch(() => ({}));
  const name = String(body?.name ?? "").trim();
  if (!name || name.length > 24) {
    return NextResponse.json(
      { error: "Name must be 1-24 characters" },
      { status: 400 }
    );
  }
  try {
    const profile = session?.id
      ? await renameUser(session.id, name)
      : await upsertUser({
          name,
          email: session?.email ?? null,
          picture: session?.picture ?? null,
        });
    store.set(
      SESSION_COOKIE,
      JSON.stringify({ ...session, ...profile }),
      {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      }
    );
    return NextResponse.json({ profile });
  } catch {
    return NextResponse.json(
      { error: "Could not save profile" },
      { status: 500 }
    );
  }
}
