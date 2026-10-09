import { NextResponse } from "next/server";

/**
 * GIF search proxy (Future-works: Sticker and GIF support).
 * Returns 503 with { configured: false } while GIPHY_API_KEY is empty,
 * so the client falls back to the built-in sticker pack.
 * Set GIPHY_API_KEY in .env to enable real search/trending.
 */
export async function GET(request: Request) {
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { configured: false, gifs: [] },
      { status: 503 }
    );
  }
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  const endpoint = q ? "search" : "trending";
  const params = new URLSearchParams({
    api_key: apiKey,
    limit: "12",
    rating: "pg",
    bundle: "messaging_non_clips",
  });
  if (q) params.set("q", q);
  try {
    const res = await fetch(
      `https://api.giphy.com/v1/gifs/${endpoint}?${params.toString()}`,
      { next: { revalidate: 60 } }
    );
    if (!res.ok) throw new Error("Giphy request failed");
    const data = await res.json();
    const gifs = (data.data ?? []).map(
      (g: {
        id: string;
        title?: string;
        images?: {
          fixed_height?: { url?: string };
          original?: { url?: string };
          fixed_height_small_still?: { url?: string };
        };
      }) => ({
      id: String(g.id),
      title: String(g.title ?? ""),
      url:
        g.images?.fixed_height?.url ??
        g.images?.original?.url ??
        "",
      preview: g.images?.fixed_height_small_still?.url ?? "",
    }));
    return NextResponse.json({ configured: true, gifs });
  } catch {
    return NextResponse.json(
      { error: "GIF provider unavailable" },
      { status: 502 }
    );
  }
}
