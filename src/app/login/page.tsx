import LoginForm from "@/components/LoginForm";
import { ADMIN_COOKIE, AUTH_COOKIE, verifyAccessToken, verifyAdminToken } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function LoginPage({
  searchParams
}: {
  searchParams?: Promise<{
    admin?: string;
  }>;
}) {
  const cookieStore = await cookies();
  const resolvedSearchParams = await searchParams;
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  const adminToken = cookieStore.get(ADMIN_COOKIE)?.value;
  const adminMode = resolvedSearchParams?.admin === "1";

  if (adminMode && verifyAdminToken(adminToken)) {
    redirect("/admin");
  }

  if (verifyAccessToken(token) && !adminMode) {
    redirect("/chat");
  }

  return <LoginForm adminMode={adminMode} />;
}
