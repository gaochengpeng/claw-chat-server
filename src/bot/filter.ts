/**
 * Bot 消息过滤器
 * 群聊中以 / 开头的消息不转发给 Bot
 * Bot 发的消息不触发其他 Bot 回复
 */

export function shouldForwardToBot(content: string | null, senderType: string): boolean {
  // Bot 发的消息不转发给其他 Bot（防止消息循环）
  if (senderType === "bot") return false;

  // 空消息不转发
  if (!content?.trim()) return false;

  // 以 / 开头的命令不转发给 Bot
  if (content.trim().startsWith("/")) return false;

  return true;
}
