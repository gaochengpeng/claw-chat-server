import { extractUser, unauthorized } from "../auth/middleware.js";

export async function handleMessages(req: Request, path: string): Promise<Response> {
  const user = await extractUser(req);
  if (!user) return unauthorized();

  // 服务器不存储消息，历史记录由客户端本地管理
  // 返回空数组保持 API 兼容
  return Response.json([]);
}
