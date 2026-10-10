import { createHash } from "node:crypto";
import { normalizeExtractedText, type ExtractedSection } from "../documents/extract.js";
import type { ComparableSection } from "../documents/compare.js";

// Check current versions, not the historical or side-by-side presentation.
export function monitoringUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    const hosts = (process.env.REMOTE_DOCUMENT_HOSTS ?? "lex.uz,www.lex.uz,cbu.uz,www.cbu.uz").split(",").map((host) => host.trim().toLowerCase());
    if (!hosts.includes(url.hostname.toLowerCase())) return null;
    if (["lex.uz", "www.lex.uz"].includes(url.hostname.toLowerCase())) {
      const id = url.pathname.match(/^\/(?:docs|pdffile)\/(\d+)\/?$/)?.[1];
      if (!id) return null;
      url.hostname = "lex.uz";
      url.pathname = `/docs/${id}`;
      url.searchParams.delete("ONDATE"); url.searchParams.delete("ONDATE2");
    } else if (!/\.pdf$/i.test(url.pathname)) return null;
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

export function textHash(sections: ComparableSection[]) {
  // Stable element IDs and surrounding website controls are not legal changes.
  const text = sections.filter((section) => section.section_type !== "DOCUMENT_METADATA")
    .map((section) => normalizeExtractedText(section.normalized_content)).filter(Boolean).join("\n");
  if (!text) throw new Error("No legal text could be extracted from this source.");
  return createHash("sha256").update(text).digest("hex");
}

export function comparableSections(sections: ExtractedSection[]): ComparableSection[] {
  return sections.map((section) => ({
    section_type: section.sectionType,
    source_reference: section.sourceReference,
    normalized_content: normalizeExtractedText(section.content),
    parent_source_reference: section.parentSectionIndex === null ? null : sections[section.parentSectionIndex]?.sourceReference ?? null,
    parent_content: section.parentSectionIndex === null ? null : normalizeExtractedText(sections[section.parentSectionIndex]?.content ?? ""),
  }));
}

export function monitorInterval() {
  const value = Number(process.env.REGULATORY_CHECK_INTERVAL_MINUTES ?? 60);
  return Number.isInteger(value) && value >= 15 && value <= 10080 ? value : 60;
}
