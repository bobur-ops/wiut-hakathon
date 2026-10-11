const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]!));

const eventPresentation: Record<string, { label: string; accent: string; heading: string; intro: string }> = {
  ASSESSMENT_COMPLETED: { label: "ASSESSMENT COMPLETE", accent: "#16856b", heading: "Your assessment is ready", intro: "The AI-assisted review has finished. Open the workspace to inspect findings and complete human review." },
  ASSESSMENT_FAILED: { label: "ASSESSMENT NEEDS ATTENTION", accent: "#b54735", heading: "The assessment did not complete", intro: "The assessment stopped before completion. Review its status and coverage warnings in your workspace." },
  REGULATION_CHANGED: { label: "REGULATORY UPDATE", accent: "#b7791f", heading: "A monitored source changed", intro: "A change was detected in a monitored regulatory source. Review the comparison before deciding what it means for your organization." },
  LIKELY_RELEVANT_LEGISLATION: { label: "NEW LEGISLATION · PRELIMINARY TRIAGE", accent: "#5367a5", heading: "A new act may be relevant", intro: "A keyword/profile match surfaced this act for preliminary review. This is a triage signal—not a legal applicability decision." },
};

function linkifyLine(line: string) {
  const urlPattern = /https?:\/\/[^\s<>()]+/g;
  let html = "", lastIndex = 0;
  for (const match of line.matchAll(urlPattern)) {
    const url = match[0], index = match.index ?? 0;
    html += escapeHtml(line.slice(lastIndex, index));
    const safeUrl = escapeHtml(url);
    html += `<a href="${safeUrl}" style="color:#176b59;text-decoration:underline;word-break:break-all">${safeUrl}</a>`;
    lastIndex = index + url.length;
  }
  return html + escapeHtml(line.slice(lastIndex));
}

export function renderNotificationEmail(input: { type: string; subject: string; body: string }) {
  const presentation = eventPresentation[input.type] ?? { label: "REGCHECK WORKSPACE UPDATE", accent: "#176b59", heading: input.subject, intro: "There is an update in your organization workspace." };
  const paragraphs = input.body.split(/\r?\n/).filter(Boolean)
    .map(line => `<p style="margin:0 0 14px;color:#344054;font-size:15px;line-height:1.65">${linkifyLine(line)}</p>`).join("");
  const firstLink = input.body.match(/https?:\/\/[^\s<>()]+/)?.[0];
  const button = firstLink ? `<tr><td style="padding:10px 36px 28px"><a href="${escapeHtml(firstLink)}" style="display:inline-block;background:#176b59;color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 20px;border-radius:7px">Open RegCheck workspace</a></td></tr>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(input.subject)}</title></head><body style="margin:0;padding:0;background:#f2f5f4;font-family:Arial,Helvetica,sans-serif;color:#172b27"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(presentation.intro)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f2f5f4;padding:32px 12px"><tr><td align="center"><table role="presentation" width="600" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e1e9e6;border-radius:12px;overflow:hidden"><tr><td style="background:#123b34;padding:20px 36px"><span style="color:#fff;font-size:16px;font-weight:800;letter-spacing:1.5px">REGCHECK <span style="color:#83d7bd">UZ</span></span><span style="float:right;color:#c4d8d2;font-size:12px;padding-top:3px">COMPLIANCE WORKSPACE</span></td></tr><tr><td style="padding:30px 36px 12px"><span style="display:inline-block;color:${presentation.accent};font-size:11px;font-weight:800;letter-spacing:1px;border:1px solid ${presentation.accent};border-radius:20px;padding:6px 9px">${escapeHtml(presentation.label)}</span><h1 style="font-size:25px;line-height:1.25;color:#173b34;margin:18px 0 10px">${escapeHtml(presentation.heading)}</h1><p style="font-size:15px;line-height:1.6;color:#52645f;margin:0">${escapeHtml(presentation.intro)}</p></td></tr><tr><td style="padding:18px 36px 8px">${paragraphs}</td></tr>${button}<tr><td style="padding:20px 36px;background:#f7f9f8;border-top:1px solid #e8eeeb"><p style="margin:0 0 8px;color:#52645f;font-size:12px;line-height:1.55"><strong>Human review required.</strong> RegCheck provides AI-assisted suggestions, not legal advice or certification. Confirm relevance, source text, and effective dates with a qualified reviewer.</p><p style="margin:0;color:#7a8985;font-size:11px;line-height:1.5">You received this message because this address is configured for organization notifications. Manage notification preferences in Organization settings.</p></td></tr></table><p style="margin:16px 0 0;color:#879590;font-size:11px">RegCheck UZ · Recommendations, not legal certification</p></td></tr></table></body></html>`;
  return { html, text: input.body };
}
