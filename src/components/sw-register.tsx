"use client";

import { useEffect } from "react";

/** Register /sw.js once (offline shell + static cache). */
export default function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);
  return null;
}
