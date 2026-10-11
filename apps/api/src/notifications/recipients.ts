export function configuredRecipientAllowlist(value = process.env.RESEND_ALLOWED_RECIPIENTS): string[] | null {
  if (!value?.trim()) return null;
  return [...new Set(value.split(",").map(email=>email.trim().toLowerCase()).filter(Boolean))];
}

export function isAllowedNotificationRecipient(email: string, value = process.env.RESEND_ALLOWED_RECIPIENTS) {
  const allowed=configuredRecipientAllowlist(value);
  return allowed === null || allowed.includes(email.trim().toLowerCase());
}
