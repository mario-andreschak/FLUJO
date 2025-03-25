"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ApiDocsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/docs/swagger");
  }, [router]);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
      }}
    >
      Redirecting to API documentation...
    </div>
  );
}
