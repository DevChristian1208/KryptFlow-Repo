"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/app/Context/UserContext";

export default function DashboardWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useUser();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/Login");
      return;
    }
  }, [user, loading, router]);
  if (loading || !user) return null;

  return <>{children}</>;
}
