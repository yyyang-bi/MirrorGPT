import LoginForm from "@/components/LoginForm";
import { ADMIN_COOKIE, AUTH_COOKIE, verifyAccessToken, verifyAdminToken } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function LoginPage({
  searchParams
}: {
  searchParams?: {
    admin?: string;
  };
}) {
  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  const adminToken = cookieStore.get(ADMIN_COOKIE)?.value;
  const adminMode = searchParams?.admin === "1";

  if (adminMode && verifyAdminToken(adminToken)) {
    redirect("/admin");
  }

  if (verifyAccessToken(token) && !adminMode) {
    redirect("/chat");
  }

  return <LoginForm adminMode={adminMode} />;
}
