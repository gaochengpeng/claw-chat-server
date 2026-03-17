import { verifyToken } from "./jwt.js";
export async function extractUser(req) {
    const auth = req.headers.get("authorization");
    if (!auth?.startsWith("Bearer "))
        return null;
    return verifyToken(auth.slice(7));
}
export function unauthorized() {
    return Response.json({ error: "unauthorized" }, { status: 401 });
}
