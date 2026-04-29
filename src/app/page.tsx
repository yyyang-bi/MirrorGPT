import { ADMIN_COOKIE, AUTH_COOKIE, verifyAccessToken, verifyAdminToken } from "@/lib/auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default function HomePage() {
  const cookieStore = cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;

  if (verifyAccessToken(token)) {
    redirect("/chat");
  }

  const adminToken = cookieStore.get(ADMIN_COOKIE)?.value;
  redirect(verifyAdminToken(adminToken) ? "/admin" : "/login");
}
